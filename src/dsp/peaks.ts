/**
 * 波形包络：把每声道降采样成固定数量的 min/max 桶，
 * 峰值取所有声道中绝对值更大的那个（绘制时按单声道包络画）。
 */

export const PEAK_BUCKETS = 2400;

export function computePeaks(channels: Float32Array[], buckets = PEAK_BUCKETS): number[] {
  const frames = channels[0]?.length ?? 0;
  if (frames === 0) return [];
  const per = Math.max(1, Math.floor(frames / buckets));
  const actual = Math.min(buckets, Math.ceil(frames / per));
  const peaks = new Array<number>(actual * 2);
  for (let b = 0; b < actual; b++) {
    let mn = Infinity;
    let mx = -Infinity;
    const start = b * per;
    const end = Math.min(frames, start + per);
    for (let n = start; n < end; n++) {
      for (let c = 0; c < channels.length; c++) {
        const v = channels[c][n];
        if (v < mn) mn = v;
        if (v > mx) mx = v;
      }
    }
    peaks[b * 2] = mn === Infinity ? 0 : mn;
    peaks[b * 2 + 1] = mx === -Infinity ? 0 : mx;
  }
  return peaks;
}

/** 多声道混为单声道 Float64（对齐算法只需要单声道）。 */
export function downmixToMono(channels: Float32Array[] | Float64Array[]): Float64Array {
  const frames = channels[0]?.length ?? 0;
  const out = new Float64Array(frames);
  const g = 1 / channels.length;
  for (let n = 0; n < frames; n++) {
    let s = 0;
    for (let c = 0; c < channels.length; c++) s += channels[c][n];
    out[n] = s * g;
  }
  return out;
}
