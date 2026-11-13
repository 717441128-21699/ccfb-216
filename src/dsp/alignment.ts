/**
 * 成对对齐：沿时间轴在多个窗口分别做互相关，对「延迟 ~ 时间」做
 * 最小二乘线性回归，斜率即时钟漂移、截距为补偿后的恒定偏移。
 * 多点回归把单次互相关的亚采样噪声平均掉，半小时录音的头尾都能压住。
 *
 * 内存设计：调用方只传入各窗口的短片段（如每段 12s），不在此持有
 * 整条信号，30 分钟录音的对齐额外内存也是 MB 级而非 GB 级。
 *
 * 模型：设目标机真实采样率是参考机的 ratio 倍，
 *   实测延迟 lag(t) ≈ L + (ratio - 1)·t，L 为补偿后的恒定偏移。
 */
import { xcorrLag, type XCorrResult } from './xcorr.ts';

export interface DriftEstimate {
  /** 时钟偏差 ppm，正值表示目标设备时钟偏快 */
  ppm: number;
  /** 重采样比值 = 目标真实速率 / 标称速率 */
  ratio: number;
  /** 漂移补偿后，目标相对参考的恒定偏移（采样点，正=目标晚） */
  constantLag: number;
  /** 头部窗口实测延迟（采样点） */
  headLag: number;
  /** 尾部窗口实测延迟（采样点） */
  tailLag: number;
  /** 回归模型对各窗口延迟的最大拟合残差（毫秒） */
  residualMs: number;
  /** 0..1 对齐置信度，取所有窗口的最小值 */
  confidence: number;
  /** 回归优度 R²，越接近 1 漂移模型越可信 */
  r2: number;
  /** 参与回归的窗口数 */
  windows: number;
}

export interface AlignOptions {
  sampleRate: number;
  /** 单个估计窗口长度（秒），默认 12s */
  windowSec?: number;
  /** 窗口距信号端点的留白（秒），默认 2s */
  marginSec?: number;
  /** 最大允许延迟搜索范围（秒），默认 60s（手机晚按录音键很常见） */
  maxLagSec?: number;
  /** 回归窗口数量，默认 6 */
  windowCount?: number;
}

type TypedArray = Float64Array | Float32Array;

export interface WindowPair {
  /** 窗口起点在各自（同采样率）时间轴上的采样索引 */
  center: number;
  a: TypedArray;
  b: TypedArray;
}

/**
 * 基于已抽取的窗口片段做漂移估计。
 * 两个片段需在同一采样率网格上、索引含义一致（第 n 点对应同一标称时刻）。
 *
 * 鲁棒性：单窗口互相关在强周期音乐上可能锁到节拍假峰。这里先全范围
 * 搜索得到候选延迟，按候选做「围绕锚点的局部重搜」并累计各窗相关峰
 * 总分选出全局正确锚点，再用 RANSAC 直线拟合剔除残余错峰窗口。
 */
export function estimateDriftFromWindows(
  pairs: WindowPair[],
  sampleRate: number,
  maxLagSamples: number,
): DriftEstimate {
  if (pairs.length < 2) throw new Error('漂移估计至少需要 2 个窗口');

  // 1) 全范围初搜
  const initial = pairs.map(({ a, b }) =>
    xcorrLag(a, b, { maxLag: maxLagSamples, phat: false }),
  );
  let confidence = Math.min(...initial.map((r) => r.confidence));

  // 2) 候选锚点：把初搜延迟按 50ms 粒度聚类去重
  const binSamples = Math.max(1, Math.round(0.05 * sampleRate));
  const anchors = [...new Set(initial.map((r) => Math.round(r.lag / binSamples) * binSamples))];

  // 3) 每个锚点做局部重搜（半径 0.35s，足以排除周期假峰、容得下漂移累积），
  //    累计归一化峰高，总分最高者为全局锚点
  const localRadius = Math.round(0.35 * sampleRate);
  let bestAnchor = anchors[0];
  let bestScore = -Infinity;
  const refinedByAnchor = new Map<number, XCorrResult[]>();
  for (const anchor of anchors) {
    let score = 0;
    const rs = pairs.map(({ a, b }) =>
      xcorrLag(a, b, { maxLag: localRadius, centerLag: anchor, phat: false }),
    );
    for (const r of rs) score += Math.abs(r.peak);
    refinedByAnchor.set(anchor, rs);
    if (score > bestScore) {
      bestScore = score;
      bestAnchor = anchor;
    }
  }
  const refined = refinedByAnchor.get(bestAnchor)!;
  const centers = pairs.map((p) => p.center);
  const lags = refined.map((r) => r.lag);

  // 4) RANSAC 直线拟合 lag = intercept + slope·t，剔除错峰窗口
  // 8ms 容差：真峰经抛物插值后偏差远小于此，而周期假峰偏差通常几十 ms 以上
  const inlierTol = Math.round(0.008 * sampleRate);
  const fit = robustLineFit(centers, lags, inlierTol);
  const slope = fit.slope;
  const intercept = fit.intercept;
  const r2 = fit.r2;

  // 5) 残差：内点窗相对拟合直线的最大偏差
  let maxResidual = 0;
  for (const i of fit.inlierIdx) {
    const predicted = intercept + slope * centers[i];
    maxResidual = Math.max(maxResidual, Math.abs(lags[i] - predicted));
  }
  const residualMs = (maxResidual / sampleRate) * 1000;
  confidence = Math.min(confidence, ...fit.inlierIdx.map((i) => refined[i].confidence));

  return {
    ppm: slope * 1e6,
    ratio: 1 + slope,
    constantLag: intercept,
    headLag: lags[0],
    tailLag: lags[lags.length - 1],
    residualMs,
    confidence,
    r2,
    windows: pairs.length,
  };
}

/** RANSAC + 最小二乘：返回斜率、截距、R² 和内点索引。 */
function robustLineFit(
  xs: number[],
  ys: number[],
  tol: number,
): { slope: number; intercept: number; r2: number; inlierIdx: number[] } {
  const n = xs.length;
  let best: { idx: number[]; resid: number } = { idx: [], resid: Infinity };

  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      const dx = xs[j] - xs[i];
      if (dx === 0) continue;
      const s = (ys[j] - ys[i]) / dx;
      const c = ys[i] - s * xs[i];
      const idx: number[] = [];
      let resid = 0;
      for (let k = 0; k < n; k++) {
        const d = Math.abs(ys[k] - (s * xs[k] + c));
        if (d <= tol) {
          idx.push(k);
          resid += d;
        }
      }
      if (idx.length > best.idx.length || (idx.length === best.idx.length && resid < best.resid)) {
        best = { idx, resid };
      }
    }
  }

  // 内点不足 3 个（含退化情形）则退回全部点
  const useIdx = best.idx.length >= 3 ? best.idx : xs.map((_, i) => i);
  const m = useIdx.length;
  const xBar = useIdx.reduce((s, i) => s + xs[i], 0) / m;
  const yBar = useIdx.reduce((s, i) => s + ys[i], 0) / m;
  let sxx = 0;
  let sxy = 0;
  let syy = 0;
  for (const i of useIdx) {
    const dx = xs[i] - xBar;
    const dy = ys[i] - yBar;
    sxx += dx * dx;
    sxy += dx * dy;
    syy += dy * dy;
  }
  const slope = sxx > 0 ? sxy / sxx : 0;
  const intercept = yBar - slope * xBar;
  const r2 = syy > 0 ? Math.max(0, Math.min(1, (sxy * sxy) / (sxx * syy))) : 1;
  return { slope, intercept, r2, inlierIdx: useIdx };
}

/**
 * 整条信号版本（Node 测试与短信号用）：内部切出窗口后走窗口估计，
 * 不在此做整段重采样。
 */
export function estimateDrift(
  ref: TypedArray,
  target: TypedArray,
  opts: AlignOptions,
): DriftEstimate {
  const sr = opts.sampleRate;
  const usable = Math.min(ref.length, target.length);
  const maxWin = Math.floor(usable / 4);
  const win = Math.max(2048, Math.min(Math.floor((opts.windowSec ?? 12) * sr), maxWin));
  const margin = Math.floor((opts.marginSec ?? 2) * sr);
  const maxLag = Math.min(
    Math.floor((opts.maxLagSec ?? 60) * sr),
    Math.min(ref.length, target.length) - win - 1,
  );
  const count = opts.windowCount ?? 6;

  if (usable < win * 2 + margin * 2) {
    throw new Error(
      `信号过短，无法估计漂移：至少需要 ${Math.ceil((win * 2 + margin * 2) / sr)}s，` +
        `参考 ${ref.length} 点、目标 ${target.length} 点`,
    );
  }

  const firstCenter = margin + Math.floor(win / 2);
  const lastCenter = usable - margin - Math.floor(win / 2);
  const nWin = Math.max(2, Math.min(count, Math.floor((lastCenter - firstCenter) / win) + 1));
  const pairs: WindowPair[] = [];
  const half = Math.floor(win / 2);
  for (let i = 0; i < nWin; i++) {
    const center = Math.round(firstCenter + ((lastCenter - firstCenter) * i) / (nWin - 1));
    const s = center - half;
    pairs.push({
      center,
      a: ref.subarray(s, s + win),
      b: target.subarray(s, s + win),
    });
  }
  return estimateDriftFromWindows(pairs, sr, maxLag);
}

/**
 * 不做漂移估计、只找恒定偏移（短录音或漂移已确认可忽略时用）。
 * 返回目标相对参考的延迟（采样点）。
 */
export function findOffset(
  ref: TypedArray,
  target: TypedArray,
  sampleRate: number,
  maxLagSec = 60,
): XCorrResult {
  return xcorrLag(ref, target, {
    maxLag: Math.floor(maxLagSec * sampleRate),
    phat: false,
  });
}
