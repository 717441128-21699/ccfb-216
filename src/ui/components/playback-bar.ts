/**
 * 走带控制条：负责按需解码素材、驱动 AudioEngine 播放，
 * 并把播放位置回写给 Timeline。
 */
import type { Rehearsal } from '../../model/types.ts';
import { store } from '../../model/project.ts';
import type { AudioEngine, SchedTrack } from '../../audio/engine.ts';
import { h } from '../dom.ts';
import { toast } from '../toast.ts';
import type { Timeline } from './timeline.ts';
import { fmtClock } from '../dom.ts';

export class PlaybackBar {
  readonly host: HTMLElement;
  private engine: AudioEngine;
  private rehearsal: Rehearsal;
  private timeline: Timeline;
  private timeEl: HTMLElement;
  private tracks: SchedTrack[] = [];
  private loaded = false;
  private loadHint: HTMLElement;
  private raf = 0;

  constructor(engine: AudioEngine, rehearsal: Rehearsal, timeline: Timeline) {
    this.engine = engine;
    this.rehearsal = rehearsal;
    this.timeline = timeline;
    timeline.setEngine(engine);

    this.timeEl = h('span', { class: 'time' }, '00:00.00');
    this.loadHint = h('span', { class: 'faint', style: 'font-size:12px' }, '');

    const btn = (label: string, fn: () => void, extra?: string) =>
      h('button', { class: extra, onclick: fn }, label);

    this.host = h(
      'div',
      { class: 'transport' },
      btn('▶ 播放', () => void this.play()),
      btn('⏸ 暂停', () => this.pause()),
      btn('⏹ 停止', () => this.stop()),
      h('span', { style: 'width:1px;height:24px;background:var(--border)' }),
      btn('－', () => timeline.zoom(0.8)),
      btn('＋', () => timeline.zoom(1.25)),
      btn('适应宽度', () => timeline.fitContent()),
      h('span', { style: 'width:1px;height:24px;background:var(--border)' }),
      this.timeEl,
      h('div', { class: 'spacer' }),
      this.loadHint,
    );
  }

  private async ensureLoaded(): Promise<SchedTrack[]> {
    if (this.loaded) return this.tracks;
    this.loadHint.textContent = '解码素材中…';
    const out: SchedTrack[] = [];
    for (const id of this.rehearsal.trackOrder) {
      const track = this.rehearsal.tracks[id];
      const cached = this.engine.getCached(track.materialId);
      const buffer = cached ?? (await store.loadAudioBuffer(this.rehearsal.id, track.materialId));
      if (!cached) this.engine.cacheBuffer(track.materialId, buffer);
      out.push({ track, buffer });
    }
    this.tracks = out;
    this.loaded = true;
    this.loadHint.textContent = '';
    return out;
  }

  async play(): Promise<void> {
    try {
      const tracks = await this.ensureLoaded();
      void tracks;
      await this.engine.playTransport(this.tracks, this.engine.position || 0);
      this.watch();
    } catch (e) {
      toast(`播放失败：${(e as Error).message}`, 'error');
    }
  }

  pause(): void {
    this.engine.pause();
  }

  stop(): void {
    this.engine.stop();
    this.timeline.setPlayhead(0);
  }

  private watch(): void {
    cancelAnimationFrame(this.raf);
    const loop = () => {
      this.timeEl.textContent = fmtClock(this.engine.position);
      this.raf = requestAnimationFrame(loop);
    };
    this.raf = requestAnimationFrame(loop);
  }

  destroy(): void {
    cancelAnimationFrame(this.raf);
    this.engine.stop();
  }
}
