/** 全局轻提示 */
import { h } from './dom.ts';

let host: HTMLDivElement | null = null;

function ensureHost(): HTMLDivElement {
  if (!host) {
    host = h('div', { class: 'toast-host' });
    document.body.append(host);
  }
  return host;
}

export function toast(message: string, kind: 'info' | 'error' | 'success' = 'info', ttl = 4200): void {
  const el = h('div', { class: `toast ${kind === 'info' ? '' : kind}` }, message);
  ensureHost().append(el);
  setTimeout(() => {
    el.style.opacity = '0';
    el.style.transform = 'translateY(6px)';
    el.style.transition = 'opacity 0.2s, transform 0.2s';
    setTimeout(() => el.remove(), 220);
  }, ttl);
}
