/**
 * 对齐服务：从解码后的 AudioBuffer 中只抽取对齐窗口的短片段
 * （默认 6 × 12s），不缓存整条单声道信号——30 分钟录音也只占 MB 级内存。
 *
 * 关键：浏览器 decodeAudioData 会把所有文件统一重采样到 AudioContext
 * 的采样率（如 48k），因此这里拿到的所有 buffer 已在同一时间网格上，
 * 直接按秒抽窗即可；素材的原始标称采样率仅用于展示和跨设备诊断，
 * 不参与窗口索引，否则会把解码重采样误当成时钟漂移。
 */
import {
  estimateDriftFromWindows,
  findOffset,
  type DriftEstimate,
  type WindowPair,
} from '../dsp/alignment.ts';
import { store } from '../model/project.ts';
import type { Rehearsal, Track } from '../model/types.ts';

const WINDOW_SEC = 12;
const MARGIN_SEC = 2;
const WINDOW_COUNT = 6;
const MAX_LAG_SEC = 60;

class AlignmentService {
  /** 窗口方案无缓存，此方法为空操作（保留接口兼容）。 */
  invalidate(): void {
    /* no-op */
  }

  /**
   * 把一条轨对齐到参考轨。结果只以「秒」和「ppm」表达，与采样率无关。
   */
  async alignTrack(
    rehearsal: Rehearsal,
    track: Track,
    opts: { windowSec?: number; maxLagSec?: number } = {},
  ): Promise<DriftEstimate> {
    const refId = rehearsal.referenceTrackId;
    if (!refId) throw new Error('尚未指定参考轨');
    if (track.id === refId) throw new Error('参考轨不需要对齐');
    const refTrack = rehearsal.tracks[refId];
    if (!refTrack) throw new Error('参考轨缺失');

    const winSec = opts.windowSec ?? WINDOW_SEC;
    const [refBuf, tgtBuf] = await Promise.all([
      store.loadAudioBuffer(rehearsal.id, refTrack.materialId),
      store.loadAudioBuffer(rehearsal.id, track.materialId),
    ]);

    // 两者都已被解码到同一个 AudioContext 采样率
    const sr = refBuf.sampleRate;
    if (tgtBuf.sampleRate !== sr) {
      throw new Error('解码采样率不一致，无法对齐（请在同一浏览器环境重试）');
    }

    const usable = Math.min(refBuf.duration, tgtBuf.duration);
    const win = Math.min(winSec, usable / 4);
    if (!(win > 0.5)) throw new Error('素材过短，无法估计漂移');

    const firstCenter = MARGIN_SEC + win / 2;
    const lastCenter = usable - MARGIN_SEC - win / 2;
    const pairs: WindowPair[] = [];

    for (let i = 0; i < WINDOW_COUNT; i++) {
      const centerSec = firstCenter + ((lastCenter - firstCenter) * i) / (WINDOW_COUNT - 1);
      const startSec = centerSec - win / 2;
      pairs.push({
        center: Math.round(centerSec * sr),
        a: extractMonoWindow(refBuf, startSec, win),
        b: extractMonoWindow(tgtBuf, startSec, win),
      });
    }

    const est = estimateDriftFromWindows(
      pairs,
      sr,
      Math.floor((opts.maxLagSec ?? MAX_LAG_SEC) * sr),
    );

    await store.applyAlignment(rehearsal.id, track.id, {
      offsetSec: est.constantLag / sr,
      driftPpm: est.ppm,
      info: {
        headLagMs: (est.headLag / sr) * 1000,
        tailLagMs: (est.tailLag / sr) * 1000,
        residualMs: est.residualMs,
        confidence: est.confidence,
      },
    });
    return est;
  }

  /** 只估恒定偏移、忽略漂移（快速粗对齐），取前 30s。 */
  async alignTrackOffsetOnly(rehearsal: Rehearsal, track: Track): Promise<number> {
    const refId = rehearsal.referenceTrackId;
    if (!refId) throw new Error('尚未指定参考轨');
    const refTrack = rehearsal.tracks[refId];
    const [refBuf, tgtBuf] = await Promise.all([
      store.loadAudioBuffer(rehearsal.id, refTrack.materialId),
      store.loadAudioBuffer(rehearsal.id, track.materialId),
    ]);
    const sr = refBuf.sampleRate;
    const coarse = Math.min(30, refBuf.duration, tgtBuf.duration);
    const refWin = extractMonoWindow(refBuf, MARGIN_SEC, coarse - MARGIN_SEC);
    const tgtWin = extractMonoWindow(tgtBuf, MARGIN_SEC, coarse - MARGIN_SEC);
    const r = findOffset(refWin, tgtWin, sr, MAX_LAG_SEC);
    await store.applyAlignment(rehearsal.id, track.id, {
      offsetSec: r.lag / sr,
      driftPpm: 0,
      info: {
        headLagMs: (r.lag / sr) * 1000,
        tailLagMs: (r.lag / sr) * 1000,
        residualMs: 0,
        confidence: r.confidence,
      },
    });
    return r.lag / sr;
  }
}

/**
 * 从 AudioBuffer 抽取 [startSec, startSec+winSec) 的单声道片段。
 * 多声道取平均；越界部分补零，保证返回长度恰好 winSec·sampleRate。
 */
function extractMonoWindow(buf: AudioBuffer, startSec: number, winSec: number): Float64Array {
  const sr = buf.sampleRate;
  const startFrame = Math.max(0, Math.round(startSec * sr));
  const len = Math.round(winSec * sr);
  const out = new Float64Array(len);
  const ch = buf.numberOfChannels;
  const available = Math.max(0, Math.min(len, buf.length - startFrame));
  for (let c = 0; c < ch; c++) {
    const data = buf.getChannelData(c);
    for (let n = 0; n < available; n++) {
      out[n] += data[startFrame + n] / ch;
    }
  }
  return out;
}

export const alignmentService = new AlignmentService();
