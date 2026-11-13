/** 简单唯一 id（不依赖 crypto.randomUUID，浏览器/Node 都能跑） */
let counter = 0;

export function uid(prefix = 'id'): string {
  counter = (counter + 1) % 0xfffff;
  const t = Date.now().toString(36);
  const r = Math.floor(Math.random() * 0x100000000).toString(36);
  return `${prefix}_${t}${r}${counter.toString(36)}`;
}

export function clamp(x: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, x));
}

export function formatSec(sec: number): string {
  if (!Number.isFinite(sec)) return '--:--';
  const sign = sec < 0 ? '-' : '';
  const a = Math.abs(sec);
  const m = Math.floor(a / 60);
  const s = a - m * 60;
  return `${sign}${m}:${s.toFixed(2).padStart(5, '0')}`;
}

export function formatMs(sec: number, digits = 2): string {
  return `${(sec * 1000).toFixed(digits)} ms`;
}

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

export function extOf(name: string): string {
  const i = name.lastIndexOf('.');
  return i >= 0 ? name.slice(i).toLowerCase() : '';
}
