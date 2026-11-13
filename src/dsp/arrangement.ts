/**
 * 轨道在工程时间轴上的纯几何计算（无 DOM / Web Audio 依赖，可被 Node 测试）。
 *
 * 时间模型：素材自身时间 u（秒）与工程时间 t 的关系
 *   t = effectiveOffset + u · rate，  rate = 1 + driftPpm/1e6
 *
 * clips 语义是「被剪掉的片段」（素材时间轴），空数组 = 整段保留。
 * 剪辑只决定哪些区间不发声，绝不改动 offset/rate，因此对齐关系不变。
 */
import type { Track } from '../model/types.ts';

/** 有效起点（秒）：自动偏移 + 手动微调 */
export function effectiveOffset(t: Track): number {
  return t.offsetSec + t.nudgeSec;
}

/** 时钟漂移对应的播放/采样速率比 */
export function driftRate(t: Track): number {
  return 1 + t.driftPpm / 1e6;
}

/** 素材自身时间 u 投影到工程时间轴 */
export function projectMaterialTime(t: Track, u: number): number {
  return effectiveOffset(t) + u * driftRate(t);
}

/**
 * 在素材时间轴上，由「剪掉的片段」求「保留的片段」。
 * 素材范围为 [0, materialDur]。
 */
export function retainedMaterialSegments(
  t: Track,
  materialDur: number,
): Array<[number, number]> {
  if (t.clips.length === 0) return [[0, materialDur]];
  const cuts = [...t.clips].sort((a, b) => a.start - b.start);
  const out: Array<[number, number]> = [];
  let cursor = 0;
  for (const c of cuts) {
    const cs = Math.max(0, c.start);
    const ce = Math.min(materialDur, c.end);
    if (cs > cursor) out.push([cursor, cs]);
    cursor = Math.max(cursor, ce);
  }
  if (cursor < materialDur) out.push([cursor, materialDur]);
  return out;
}

/**
 * 求 [regionStart, regionEnd]（工程时间）内该轨实际发声的区间集合。
 * 剪掉的片段不发声，其余保留段仍落在原对齐位置（中间只是出现空隙）。
 */
export function activeRegions(
  t: Track,
  materialDur: number,
  regionStart: number,
  regionEnd: number,
): Array<[number, number]> {
  const off = effectiveOffset(t);
  const rate = driftRate(t);
  const kept = retainedMaterialSegments(t, materialDur);
  const out: Array<[number, number]> = [];
  for (const [us, ue] of kept) {
    const s = off + us * rate;
    const e = off + ue * rate;
    const a = Math.max(s, regionStart);
    const b = Math.min(e, regionEnd);
    if (b > a) out.push([a, b]);
  }
  return out;
}
