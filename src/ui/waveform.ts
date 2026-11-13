/**
 * 波形绘制：把素材的 min/max 包络画到 canvas 上，
 * 支持按工程时间轴缩放/平移，并叠加剪辑遮罩与拖拽高亮。
 */
import type { MaterialMeta } from '../model/types.ts';

export interface WaveDrawOpts {
  /** 素材在画布上的横向起点（px） */
  x: number;
  /** 素材在画布上的像素宽度 */
  width: number;
  /** 波形颜色 */
  color?: string;
  /** 被剪掉的素材时间段（秒，素材自身时间轴） */
  cutRanges?: Array<[number, number]>;
}

export function drawWaveform(
  canvas: HTMLCanvasElement,
  material: MaterialMeta,
  opts: WaveDrawOpts,
): void {
  const dpr = window.devicePixelRatio || 1;
  const cssW = canvas.clientWidth;
  const cssH = canvas.clientHeight;
  if (cssW === 0 || cssH === 0) return;
  const w = Math.round(cssW * dpr);
  const h = Math.round(cssH * dpr);
  if (canvas.width !== w || canvas.height !== h) {
    canvas.width = w;
    canvas.height = h;
  }
  const ctx = canvas.getContext('2d')!;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, cssW, cssH);

  const mid = cssH / 2;
  const color = opts.color ?? '#5b8def';
  const peaks = material.peaks;
  const buckets = material.peaksBuckets;
  if (!buckets) return;

  ctx.fillStyle = color;
  ctx.globalAlpha = 0.92;
  const x0 = opts.x;
  const wpx = Math.max(1, opts.width);

  for (let px = 0; px < wpx; px++) {
    const b = Math.min(buckets - 1, Math.floor((px / wpx) * buckets));
    const mn = peaks[b * 2];
    const mx = peaks[b * 2 + 1];
    const y1 = mid - mx * (mid - 2);
    const y2 = mid - mn * (mid - 2);
    ctx.fillRect(x0 + px, Math.min(y1, y2), 1, Math.max(1, Math.abs(y2 - y1)));
  }
  ctx.globalAlpha = 1;

  // 剪辑遮罩
  if (opts.cutRanges) {
    ctx.fillStyle = 'rgba(20, 23, 29, 0.78)';
    for (const [s, e] of opts.cutRanges) {
      const sx = x0 + (s / material.duration) * wpx;
      const ex = x0 + (e / material.duration) * wpx;
      ctx.fillRect(sx, 0, Math.max(1, ex - sx), cssH);
    }
  }
}

/** 画时间标尺，返回标签间距（秒）。 */
export function drawRuler(
  canvas: HTMLCanvasElement,
  viewStart: number,
  viewEnd: number,
): void {
  const dpr = window.devicePixelRatio || 1;
  const cssW = canvas.clientWidth;
  const cssH = canvas.clientHeight;
  const w = Math.round(cssW * dpr);
  const h = Math.round(cssH * dpr);
  if (canvas.width !== w || canvas.height !== h) {
    canvas.width = w;
    canvas.height = h;
  }
  const ctx = canvas.getContext('2d')!;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, cssW, cssH);

  const span = viewEnd - viewStart;
  const rawStep = span / Math.max(4, Math.floor(cssW / 90));
  const mag = Math.pow(10, Math.floor(Math.log10(rawStep)));
  const candidates = [1, 2, 5, 10, 30, 60, 120, 300, 600, 1800, 3600];
  const step = candidates.find((c) => c >= rawStep) ?? mag * 10;

  ctx.strokeStyle = '#343c4a';
  ctx.fillStyle = '#667085';
  ctx.font = '11px Consolas, monospace';
  ctx.textAlign = 'center';
  ctx.beginPath();
  const first = Math.ceil(viewStart / step) * step;
  for (let t = first; t <= viewEnd; t += step) {
    const x = ((t - viewStart) / span) * cssW;
    ctx.moveTo(x, cssH - 7);
    ctx.lineTo(x, cssH);
    ctx.fillText(formatTick(t), x, 12);
  }
  ctx.stroke();
}

function formatTick(sec: number): string {
  const m = Math.floor(sec / 60);
  const s = Math.round(sec % 60);
  return m > 0 ? `${m}:${String(s).padStart(2, '0')}` : `${s}s`;
}
