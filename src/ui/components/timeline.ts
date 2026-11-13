/**
 * 多轨时间轴组件（对齐页 / 混音页共用）。
 *
 * 坐标：工程时间轴秒 → 像素  x = (t - viewStart) * pxPerSec
 * 每条轨的素材块按 effectiveOffset + drift 拉伸后绘制；
 * 拖拽只修改 track.nudgeSec（不动自动对齐结果），吸附到 10ms 网格
 * （按住 Shift 精细到 1ms，按住 Ctrl 关闭吸附）。
 */
import type { Rehearsal, Track } from '../../model/types.ts';
import { store } from '../../model/project.ts';
import { h } from '../dom.ts';
import { drawRuler, drawWaveform } from '../waveform.ts';
import { AudioEngine } from '../../audio/engine.ts';
import { fmtClock } from '../dom.ts';
import { toast } from '../toast.ts';

const TRACK_COLORS = ['#5b8def', '#46b36e', '#b07cd9', '#e0a44c', '#d97070', '#56b8c9', '#c9a356', '#8f8fd9'];

export interface TimelineOptions {
  rehearsal: Rehearsal;
  /** 是否允许拖拽调整偏移 */
  draggable?: boolean;
  /** 是否显示剪辑遮罩并允许剪片段 */
  editableClips?: boolean;
  /** 高度变化时重绘的订阅钩子（外部控制按钮显隐） */
  onSelect?: (trackId: string) => void;
  selectedId?: string | null;
}

export class Timeline {
  readonly host: HTMLElement;
  private opts: TimelineOptions;
  private viewStart = 0;
  private pxPerSec = 80;
  private lanes = new Map<string, { canvas: HTMLCanvasElement; track: Track }>();
  private rulerCanvas!: HTMLCanvasElement;
  private playheadEl!: HTMLDivElement;
  private playheadSec = 0;
  private rafPending = false;
  private engine: AudioEngine | null = null;
  private pollTimer: number | null = null;

  constructor(opts: TimelineOptions) {
    this.opts = opts;
    this.host = h('div', { class: 'timeline-wrap' });
    this.build();
  }

  setEngine(engine: AudioEngine): void {
    this.engine = engine;
  }

  setOptions(patch: Partial<TimelineOptions>): void {
    this.opts = { ...this.opts, ...patch };
    this.redraw();
  }

  /** 根据素材总长度给一个舒服的默认缩放。 */
  fitContent(): void {
    const r = this.opts.rehearsal;
    let end = 10;
    for (const t of r.trackOrder.map((id) => r.tracks[id])) {
      const m = r.materials[t.materialId];
      if (!m) continue;
      const rate = 1 + t.driftPpm / 1e6;
      end = Math.max(end, AudioEngine.effectiveOffset(t) + m.duration * rate);
    }
    const width = this.host.clientWidth - 226;
    this.pxPerSec = Math.max(8, Math.min(400, width / Math.max(10, end)));
    this.viewStart = 0;
    this.redraw();
  }

  zoom(factor: number): void {
    const anchor = this.host.clientWidth / 2;
    const tAnchor = this.viewStart + anchor / this.pxPerSec;
    this.pxPerSec = Math.max(4, Math.min(2000, this.pxPerSec * factor));
    this.viewStart = Math.max(0, tAnchor - anchor / this.pxPerSec);
    this.redraw();
  }

  scrollBySec(delta: number): void {
    this.viewStart = Math.max(0, this.viewStart + delta);
    this.redraw();
  }

  getView(): { start: number; end: number } {
    return {
      start: this.viewStart,
      end: this.viewStart + (this.host.clientWidth - 226) / this.pxPerSec,
    };
  }

  setPlayhead(sec: number): void {
    this.playheadSec = sec;
    this.positionPlayhead();
  }

  get position(): number {
    return this.playheadSec;
  }

  destroy(): void {
    if (this.pollTimer !== null) cancelAnimationFrame(this.pollTimer);
  }

  // ---------- 构建 ----------

  private build(): void {
    const r = this.opts.rehearsal;
    const ruler = h('div', { class: 'timeline-ruler', style: 'display:flex' });
    this.rulerCanvas = h('canvas', { style: 'flex:1;height:100%' }) as HTMLCanvasElement;
    ruler.append(h('div', { style: 'flex:0 0 210px;width:210px;border-right:1px solid var(--border)' }), this.rulerCanvas);

    const scroll = h('div', { class: 'timeline-scroll' });
    const lanesHost = h('div');
    scroll.append(lanesHost);
    this.playheadEl = h('div', { class: 'playhead' }) as HTMLDivElement;

    this.host.replaceChildren(ruler, scroll);
    scroll.style.position = 'relative';
    scroll.append(this.playheadEl);

    for (const tid of r.trackOrder) {
      const track = r.tracks[tid];
      const m = r.materials[track.materialId];
      if (!track || !m) continue;
      const canvas = h('canvas', {}) as HTMLCanvasElement;
      const side = h(
        'div',
        { class: 'lane-side' },
        h('div', { class: 'name', title: track.name }, track.name + (tid === r.referenceTrackId ? ' ★' : '')),
        h('div', { class: 'sub' }, `偏移 ${(AudioEngine.effectiveOffset(track) * 1000).toFixed(1)} ms · 漂移 ${track.driftPpm.toFixed(1)} ppm`),
      );
      const laneCanvas = h('div', { class: 'lane-canvas' }, canvas);
      const lane = h('div', { class: 'track-lane' }, side, laneCanvas);
      if (this.opts.selectedId === tid) lane.style.outline = '2px solid var(--accent)';
      side.addEventListener('click', () => this.opts.onSelect?.(tid));
      laneCanvas.addEventListener('click', () => this.opts.onSelect?.(tid));
      lanesHost.append(lane);
      this.lanes.set(tid, { canvas, track });

      if (this.opts.draggable && tid !== r.referenceTrackId) {
        this.attachDrag(laneCanvas, canvas, track);
      }
      if (this.opts.editableClips) {
        this.attachClipClicks(laneCanvas, track, m.duration);
      }
    }

    // 滚轮：横向滚动（Shift）或缩放（Ctrl/Alt）
    scroll.addEventListener(
      'wheel',
      (e: WheelEvent) => {
        e.preventDefault();
        if (e.ctrlKey || e.altKey) this.zoom(e.deltaY < 0 ? 1.12 : 0.89);
        else this.scrollBySec((e.deltaY + e.deltaX) / this.pxPerSec);
      },
      { passive: false },
    );

    requestAnimationFrame(() => {
      this.fitContent();
      this.startPolling();
    });
  }

  private startPolling(): void {
    const tick = () => {
      if (this.engine) this.setPlayhead(this.engine.position);
      this.pollTimer = requestAnimationFrame(tick);
    };
    this.pollTimer = requestAnimationFrame(tick);
  }

  private positionPlayhead(): void {
    const x = (this.playheadSec - this.viewStart) * this.pxPerSec + 210;
    this.playheadEl.style.left = `${x}px`;
  }

  // ---------- 拖拽改 nudge ----------

  private attachDrag(wrapper: HTMLElement, canvas: HTMLCanvasElement, track: Track): void {
    let startX = 0;
    let startNudge = 0;
    let dragging = false;

    canvas.addEventListener('pointerdown', (e: PointerEvent) => {
      dragging = true;
      startX = e.clientX;
      startNudge = track.nudgeSec;
      canvas.setPointerCapture(e.pointerId);
      wrapper.classList.add('dragging');
    });

    canvas.addEventListener('pointermove', (e: PointerEvent) => {
      if (!dragging) return;
      const rawDelta = (e.clientX - startX) / this.pxPerSec;
      let next = startNudge + rawDelta;
      if (!e.ctrlKey && !e.metaKey) {
        const grid = e.shiftKey ? 0.001 : 0.01; // 1ms / 10ms 吸附
        next = Math.round(next / grid) * grid;
      }
      track.nudgeSec = next;
      this.redraw();
    });

    const finish = () => {
      if (!dragging) return;
      dragging = false;
      wrapper.classList.remove('dragging');
      void store.updateTrack(this.opts.rehearsal.id, track.id, { nudgeSec: track.nudgeSec });
    };
    canvas.addEventListener('pointerup', finish);
    canvas.addEventListener('pointercancel', finish);
  }

  // ---------- 点击剪片段 ----------

  private attachClipClicks(wrapper: HTMLElement, track: Track, duration: number): void {
    wrapper.addEventListener('dblclick', (e: MouseEvent) => {
      const rect = wrapper.getBoundingClientRect();
      const xPx = e.clientX - rect.left;
      const tEng = this.viewStart + xPx / this.pxPerSec;
      const u = (tEng - AudioEngine.effectiveOffset(track)) / (1 + track.driftPpm / 1e6);
      if (u < 0 || u > duration) return;
      // 双击点落在已有剪片段里 → 删除该片段；否则以该点为中心新建 2s 片段
      const existing = track.clips.find((c) => u >= c.start && u <= c.end);
      if (existing) {
        void store.removeClip(this.opts.rehearsal.id, track.id, existing.id);
        toast('已恢复该片段', 'info', 1800);
      } else {
        void store.addClip(this.opts.rehearsal.id, track.id, Math.max(0, u - 1), Math.min(duration, u + 1));
        toast('已剪掉 2s，双击红色区域可恢复', 'info', 2200);
      }
    });
  }

  // ---------- 绘制 ----------

  redraw(): void {
    if (this.rafPending) return;
    this.rafPending = true;
    requestAnimationFrame(() => {
      this.rafPending = false;
      this.paint();
    });
  }

  private paint(): void {
    const r = this.opts.rehearsal;
    const view = this.getView();
    const dpr = window.devicePixelRatio || 1;

    drawRuler(this.rulerCanvas, view.start, view.end);

    for (const [tid, { canvas, track }] of this.lanes) {
      const m = r.materials[track.materialId];
      if (!m) continue;
      const cssW = canvas.parentElement!.clientWidth;
      const cssH = 78;
      const w = Math.round(cssW * dpr);
      const hPx = Math.round(cssH * dpr);
      if (canvas.width !== w) canvas.width = w;
      if (canvas.height !== hPx) canvas.height = hPx;
      canvas.style.height = `${cssH}px`;
      const ctx = canvas.getContext('2d')!;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, cssW, cssH);

      const rate = 1 + track.driftPpm / 1e6;
      const off = AudioEngine.effectiveOffset(track);
      const x = (off - view.start) * this.pxPerSec;
      const widthPx = m.duration * rate * this.pxPerSec;
      const color = TRACK_COLORS[r.trackOrder.indexOf(tid) % TRACK_COLORS.length];

      if (x + widthPx > 0 && x < cssW) {
        drawWaveform(canvas, m, {
          x,
          width: widthPx,
          color,
          cutRanges: track.clips.map((c) => [c.start, c.end] as [number, number]),
        });
        // 素材边框
        ctx.strokeStyle = tid === r.referenceTrackId ? '#e6eaf0' : 'rgba(230,234,240,0.25)';
        ctx.lineWidth = tid === r.referenceTrackId ? 1.5 : 1;
        ctx.strokeRect(x + 0.5, 0.5, widthPx - 1, cssH - 1);
      }

      // 剪辑遮罩的 DOM 覆盖层（对齐页也提示可剪区域，实际编辑在混音页）
      const parent = canvas.parentElement!;
      parent.querySelectorAll('.clip-overlay').forEach((n) => n.remove());
      if (this.opts.editableClips) {
        for (const c of track.clips) {
          const sx = (off + c.start * rate - view.start) * this.pxPerSec;
          const sw = (c.end - c.start) * rate * this.pxPerSec;
          const overlay = h('div', {
            class: 'clip-overlay',
            style: `left:${sx}px;width:${sw}px`,
          });
          parent.append(overlay);
        }
      }
    }
    this.positionPlayhead();
  }

  get clockLabel(): string {
    return fmtClock(this.playheadSec);
  }
}
