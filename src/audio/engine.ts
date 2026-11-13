/**
 * 播放与离线渲染引擎。
 *
 * 时间模型（工程时间轴 t，单位秒，基准采样率 = AudioContext.sampleRate）：
 *   素材自身时间 u 与工程时间的关系  t = offset + u
 *   时钟漂移用 source.playbackRate = 1 + ppm/1e6 补偿
 *   （设备偏快 → 同样内容在工程轴上被拉长 → rate>1 压回正确时长）
 */
import type { Track } from '../model/types.ts';
import { activeRegions, effectiveOffset } from '../dsp/arrangement.ts';

// worklet 是独立全局作用域，放在 public/ 下原样提供；
// BASE_URL 同时兼容部署在子路径和 file:// 之外的所有场景。
const workletUrl = `${import.meta.env.BASE_URL}meter-worklet.js`;

export interface SchedTrack {
  track: Track;
  buffer: AudioBuffer;
}

export interface RenderOptions {
  /** 工程起点/终点（秒），默认覆盖全部素材范围 */
  startSec?: number;
  endSec?: number;
  /** 只渲染指定 trackId（分轨导出）；不传 = 整曲混音 */
  onlyTrackId?: string;
  /** 输出声道数，默认 2 */
  channels?: number;
  /** 目标采样率，默认取浏览器实时上下文的采样率 */
  sampleRate?: number;
}

export interface EngineMeter {
  rms: number;
  peak: number;
}

type MeterCb = (m: EngineMeter) => void;

export class AudioEngine {
  ctx: AudioContext;
  private master: GainNode;
  private masterMeter: AudioWorkletNode | null = null;
  private trackMeters = new Map<string, AudioWorkletNode>();
  private sources: AudioBufferSourceNode[] = [];
  private cache = new Map<string, AudioBuffer>();
  private playing = false;
  private startedAt = 0; // ctx.currentTime 对应工程起点 startPos
  private startPos = 0;
  private loopTimer: number | null = null;
  meterCallbacks = new Map<string, MeterCb>();
  masterCb: MeterCb | null = null;

  private constructor(ctx: AudioContext, workletReady: boolean) {
    this.ctx = ctx;
    this.master = ctx.createGain();
    this.master.gain.value = 1;
    if (workletReady) {
      try {
        this.masterMeter = new AudioWorkletNode(ctx, 'meter-processor');
        this.masterMeter.port.onmessage = (e: MessageEvent<EngineMeter>) => {
          this.masterCb?.(e.data);
        };
        this.master.connect(this.masterMeter);
      } catch {
        this.masterMeter = null;
      }
    }
    this.master.connect(ctx.destination);
  }

  static async create(): Promise<AudioEngine> {
    const ctx = new AudioContext();
    let ready = false;
    try {
      await ctx.audioWorklet.addModule(workletUrl);
      ready = true;
    } catch {
      // 部分环境（file:// 直开）无法加载 worklet，电平表降级为不可用
      ready = false;
    }
    return new AudioEngine(ctx, ready);
  }

  get sampleRate(): number {
    return this.ctx.sampleRate;
  }

  get isPlaying(): boolean {
    return this.playing;
  }

  get position(): number {
    if (!this.playing) return this.startPos;
    return this.startPos + (this.ctx.currentTime - this.startedAt);
  }

  cacheBuffer(key: string, buffer: AudioBuffer): void {
    this.cache.set(key, buffer);
  }

  getCached(key: string): AudioBuffer | undefined {
    return this.cache.get(key);
  }

  invalidate(key: string): void {
    this.cache.delete(key);
  }

  setMasterVolume(v: number): void {
    this.master.gain.setTargetAtTime(v, this.ctx.currentTime, 0.01);
  }

  onMasterMeter(cb: MeterCb): void {
    this.masterCb = cb;
  }

  onTrackMeter(trackId: string, cb: MeterCb): void {
    this.meterCallbacks.set(trackId, cb);
  }

  clearMeters(): void {
    this.meterCallbacks.clear();
    this.masterCb = null;
  }

  async resume(): Promise<void> {
    if (this.ctx.state === 'suspended') await this.ctx.resume();
  }

  /** 有效起点（秒）：自动偏移 + 手动微调 */
  static effectiveOffset(t: Track): number {
    return effectiveOffset(t);
  }

  /** 播放/导出区间内有效的发声段（工程时间轴坐标，已扣除剪辑） */
  static activeRegions(t: Track, materialDur: number, regionStart: number, regionEnd: number): Array<[number, number]> {
    return activeRegions(t, materialDur, regionStart, regionEnd);
  }

  private anySolo(tracks: SchedTrack[]): boolean {
    return tracks.some((x) => x.track.solo);
  }

  private isAudible(t: Track, soloActive: boolean): boolean {
    if (t.muted) return false;
    if (soloActive && !t.solo) return false;
    return true;
  }

  /** 构建一条轨的增益/声像/电平链路 */
  private makeChain(trackId: string): { gain: GainNode; panner: StereoPannerNode } {
    const g = this.ctx.createGain();
    const p = this.ctx.createStereoPanner();
    g.connect(p);
    p.connect(this.master);
    try {
      const meter = new AudioWorkletNode(this.ctx, 'meter-processor');
      meter.port.onmessage = (e: MessageEvent<EngineMeter>) => {
        this.meterCallbacks.get(trackId)?.(e.data);
      };
      p.connect(meter);
      this.trackMeters.set(trackId, meter);
    } catch {
      /* worklet 不可用时电平表静默降级 */
    }
    return { gain: g, panner: p };
  }

  /**
   * 从工程时间 posSec 开始播放，到 endSec 自动停止（不传则播到全部素材结束）。
   */
  async play(tracks: SchedTrack[], posSec: number, endSec?: number): Promise<void> {
    await this.resume();
    this.stopInternal();
    const soloActive = this.anySolo(tracks);
    const horizon =
      endSec ??
      Math.max(
        0,
        ...tracks.map((x) => {
          const off = AudioEngine.effectiveOffset(x.track);
          const rate = 1 + x.track.driftPpm / 1e6;
          return off + x.buffer.duration * rate;
        }),
      );

    const now = this.ctx.currentTime + 0.05;
    this.startedAt = now;
    this.startPos = posSec;
    this.playing = true;

    for (const st of tracks) {
      if (!this.isAudible(st.track, soloActive)) continue;
      const { gain, panner } = this.makeChain(st.track.id);
      gain.gain.value = st.track.volume;
      panner.pan.value = st.track.pan;
      const rate = 1 + st.track.driftPpm / 1e6;
      const regions = AudioEngine.activeRegions(st.track, st.buffer.duration, posSec, horizon);

      for (const [a, b] of regions) {
        const src = this.ctx.createBufferSource();
        src.buffer = st.buffer;
        src.playbackRate.value = rate;
        src.connect(gain);
        const when = now + (a - posSec);
        const offset = (a - AudioEngine.effectiveOffset(st.track)) / rate;
        const dur = (b - a) / rate;
        src.start(when, Math.max(0, offset), dur);
        this.sources.push(src);
      }
    }

    const durMs = Math.max(50, (horizon - posSec) * 1000);
    this.loopTimer = window.setTimeout(() => {
      if (this.playing) {
        this.stopInternal();
        this.startPos = horizon;
      }
    }, durMs);
  }

  pause(): void {
    const pos = this.position;
    this.stopInternal();
    this.startPos = pos;
  }

  stop(): void {
    this.stopInternal();
    this.startPos = 0;
  }

  seek(posSec: number): void {
    const wasPlaying = this.playing;
    const tracks = this.lastTracks;
    this.stopInternal();
    this.startPos = posSec;
    if (wasPlaying && tracks) {
      void this.play(tracks, posSec, this.lastEnd);
    }
  }

  private lastTracks: SchedTrack[] | null = null;
  private lastEnd: number | undefined;

  /** play 的包装：记住参数供 seek 后恢复 */
  async playTransport(tracks: SchedTrack[], posSec: number, endSec?: number): Promise<void> {
    this.lastTracks = tracks;
    this.lastEnd = endSec;
    await this.play(tracks, posSec, endSec);
  }

  private stopInternal(): void {
    for (const s of this.sources) {
      try {
        s.onended = null;
        s.stop();
      } catch {
        /* 已停止 */
      }
      try {
        s.disconnect();
      } catch {
        /* ignore */
      }
    }
    this.sources = [];
    for (const m of this.trackMeters.values()) {
      try {
        m.disconnect();
      } catch {
        /* ignore */
      }
    }
    this.trackMeters.clear();
    if (this.loopTimer !== null) {
      clearTimeout(this.loopTimer);
      this.loopTimer = null;
    }
    this.playing = false;
  }

  /**
   * 离线渲染：返回渲染好的 AudioBuffer。
   * 分轨导出时各轨仍按对齐参数落在同一时间轴上（前置/后置补零）。
   */
  async render(tracks: SchedTrack[], opts: RenderOptions = {}): Promise<AudioBuffer> {
    const sr = opts.sampleRate ?? this.ctx.sampleRate;
    const channels = opts.channels ?? 2;
    const bounds = tracks.map((x) => {
      const off = AudioEngine.effectiveOffset(x.track);
      const rate = 1 + x.track.driftPpm / 1e6;
      return [off, off + x.buffer.duration * rate] as [number, number];
    });
    const fullStart = Math.min(0, ...bounds.map((b) => b[0]));
    const fullEnd = Math.max(...bounds.map((b) => b[1]));
    const startSec = opts.startSec ?? fullStart;
    const endSec = opts.endSec ?? fullEnd;
    if (!(endSec > startSec)) throw new Error('导出区间为空');

    const frames = Math.ceil((endSec - startSec) * sr);
    const offline = new OfflineAudioContext(channels, frames, sr);
    const soloActive = this.anySolo(tracks);
    const master = offline.createGain();
    master.gain.value = 1;
    master.connect(offline.destination);

    for (const st of tracks) {
      if (opts.onlyTrackId && st.track.id !== opts.onlyTrackId) continue;
      if (!opts.onlyTrackId && !this.isAudible(st.track, soloActive)) continue;

      const g = offline.createGain();
      g.gain.value = st.track.volume;
      const p = offline.createStereoPanner();
      p.pan.value = st.track.pan;
      g.connect(p);
      p.connect(master);

      const buf = await this.ensureRate(st.buffer, sr);
      const rate = 1 + st.track.driftPpm / 1e6;
      const regions = AudioEngine.activeRegions(st.track, st.buffer.duration, startSec, endSec);
      for (const [a, b] of regions) {
        const src = offline.createBufferSource();
        src.buffer = buf;
        src.playbackRate.value = rate;
        src.connect(g);
        const when = Math.max(0, a - startSec);
        const offset = Math.max(0, (a - AudioEngine.effectiveOffset(st.track)) / rate);
        const dur = (b - a) / rate;
        src.start(when, offset, dur);
      }
    }
    return offline.startRendering();
  }

  /** 离线上下文采样率不同时，先把 buffer 重采样到目标采样率。 */
  private async ensureRate(
    buf: AudioBuffer,
    targetSr: number,
  ): Promise<AudioBuffer> {
    if (buf.sampleRate === targetSr) return buf;
    const tmp = new OfflineAudioContext(
      buf.numberOfChannels,
      Math.ceil((buf.duration * targetSr)),
      targetSr,
    );
    const src = tmp.createBufferSource();
    src.buffer = buf;
    src.connect(tmp.destination);
    src.start();
    return tmp.startRendering();
  }
}
