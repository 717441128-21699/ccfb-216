/**
 * 基于 FFT 的互相关，用于估计 b 相对 a 的延迟（单位：采样点）。
 * 返回 lag 的含义：b[n] ≈ a[n - lag]，即 b 比 a 晚 lag 个采样点开始。
 * 亚采样精度通过峰值附近三点抛物插值获得。
 */
import { FFT, nextPow2 } from './fft.ts';

export interface XCorrResult {
  /** 估计延迟（采样点，可为小数、可为负） */
  lag: number;
  /** 归一化相关峰值 [-1, 1]，越接近 1 越可信 */
  peak: number;
  /** 0..1 置信度（峰值与相关函数均值的对比度） */
  confidence: number;
}

export interface XCorrOptions {
  /** 搜索范围 ±maxLag（采样点），默认 min(len)/2 */
  maxLag?: number;
  /** 使用 GCC-PHAT 加权（多麦克风、不同频响时更稳），默认 false */
  phat?: boolean;
  /** 输入采样率，仅用于结果展示，不影响计算 */
  sampleRate?: number;
  /** 围绕该延迟中心搜索（采样点），不给则在 [-maxLag, maxLag] 内搜索 */
  centerLag?: number;
}

export function xcorrLag(
  a: Float64Array | Float32Array,
  b: Float64Array | Float32Array,
  options: XCorrOptions = {},
): XCorrResult {
  const na = a.length;
  const nb = b.length;
  if (na < 4 || nb < 4) {
    throw new Error('互相关输入至少需要 4 个采样点');
  }
  const nfft = nextPow2(na + nb - 1);
  const fft = new FFT(nfft);

  const ar = new Float64Array(nfft);
  const ai = new Float64Array(nfft);
  const br = new Float64Array(nfft);
  const bi = new Float64Array(nfft);
  for (let i = 0; i < na; i++) ar[i] = a[i];
  for (let i = 0; i < nb; i++) br[i] = b[i];

  fft.forward(ar, ai);
  fft.forward(br, bi);

  // R = conj(A) * B，其逆变换在 index d 处为 Σ a[n]·b[n+d]
  const usePhat = options.phat ?? true;
  // PHAT 的 epsilon 正则：噪声频点幅度小，硬归一化会把它们放大到和信号频点
  // 同权，反而污染相关峰。按频点幅度中位数的 1/8 作地板。
  let phatFloor = 0;
  if (usePhat) {
    const mags: number[] = [];
    for (let k = 0; k < nfft; k++) mags.push(Math.hypot(ar[k], ai[k]));
    mags.sort((x, y) => x - y);
    phatFloor = mags[Math.floor(mags.length / 2)] / 8;
  }
  for (let k = 0; k < nfft; k++) {
    let rr = ar[k] * br[k] + ai[k] * bi[k];
    let ri = ar[k] * bi[k] - ai[k] * br[k];
    if (usePhat) {
      const mag = Math.hypot(rr, ri);
      if (mag > 1e-12) {
        const denom = mag + phatFloor;
        rr /= denom;
        ri /= denom;
      } else {
        rr = 0;
        ri = 0;
      }
    }
    ar[k] = rr;
    ai[k] = ri;
  }
  fft.inverse(ar, ai);

  const corr = ar; // 逆变换后的实部即相关序列
  const maxLag = Math.min(
    options.maxLag ?? Math.min(na, nb) >> 1,
    Math.min(na, nb) - 1,
  );
  const anchorCenter = Math.round(options.centerLag ?? 0);
  const lo = anchorCenter - maxLag;
  const hi = anchorCenter + maxLag;

  // 把循环相关的负延迟部分（index >= nfft-d）映射成负数
  let bestIdx = 0;
  let bestVal = -Infinity;
  for (let d = lo; d <= hi; d++) {
    const idx = ((d % nfft) + nfft) % nfft;
    if (corr[idx] > bestVal) {
      bestVal = corr[idx];
      bestIdx = idx;
    }
  }
  // 记录胜出延迟对应的整数索引（含负延迟语义），供插值使用
  const bestLagInt = bestIdx > nfft / 2 ? bestIdx - nfft : bestIdx;

  // 抛物插值（PHAT 下峰可能略平，插值仍能把偏差压到亚采样级）
  const left = corr[(bestIdx - 1 + nfft) % nfft];
  const peakCenter = corr[bestIdx];
  const right = corr[(bestIdx + 1) % nfft];
  const denom = left - 2 * peakCenter + right;
  const delta = denom !== 0 ? 0.5 * (left - right) / denom : 0;
  const clampedDelta = Math.max(-1, Math.min(1, delta));

  let lag: number;
  if (bestLagInt < 0) {
    // 负延迟的插值要在 nfft-|d| 邻域上取点
    const d2 =
      left - 2 * peakCenter + right !== 0
        ? (0.5 * (left - right)) / (left - 2 * peakCenter + right)
        : 0;
    lag = bestLagInt + Math.max(-1, Math.min(1, d2));
  } else {
    lag = bestLagInt + clampedDelta;
  }

  // 在实际搜索区间内统计相关值分布，用峰的标准分（z-score）衡量「峰突出度」。
  // 这样置信度只反映真峰相对其它候选的独特性，与信号自身的相关幅度解耦——
  // 多麦克风噪声录音的相关系数可能只有 0.3，但只要峰足够突出依然高置信。
  let sSum = 0;
  let n2 = 0;
  for (let d = lo; d <= hi; d++) {
    sSum += corr[((d % nfft) + nfft) % nfft];
    n2++;
  }
  const mean2 = sSum / n2;
  let varSum = 0;
  for (let d = lo; d <= hi; d++) {
    const v = corr[((d % nfft) + nfft) % nfft] - mean2;
    varSum += v * v;
  }
  const std = Math.sqrt(varSum / n2) || 1e-12;
  const z = (bestVal - mean2) / std;
  const confidence = Math.max(0, Math.min(1, 1 - Math.exp(-z / 3)));

  // 归一化峰高（相关系数）保留在 peak 字段，供锚点打分等需要绝对量的场景使用
  const norm = Math.sqrt(energy(a) * energy(b));
  const normalizedPeak = norm > 0 ? bestVal / norm : 0;
  const peak = usePhat ? confidence : normalizedPeak;

  return { lag, peak, confidence };
}

function energy(x: Float64Array | Float32Array): number {
  let s = 0;
  for (let i = 0; i < x.length; i++) s += x[i] * x[i];
  return s;
}
