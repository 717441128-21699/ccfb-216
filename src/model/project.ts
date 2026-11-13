/**
 * 工程中央状态：排练/素材/轨道的所有变更都走这里，
 * 变更后自动持久化到 IndexedDB，并通知 UI 订阅者。
 */
import type { MaterialMeta, ProjectFile, Rehearsal, Track, TrackClip } from './types.ts';
import { blobDelete, blobGet, blobPut, kvAllKeys, kvDelete, kvGet, kvPut } from '../storage/db.ts';
import { computePeaks } from '../dsp/peaks.ts';
import { readZip, writeZip } from '../util/zip.ts';
import { extOf, uid } from '../util/format.ts';

const REH_PREFIX = 'rehearsal:';
type Listener = () => void;

export interface DecodeResult {
  meta: MaterialMeta;
}

class ProjectStore {
  private listeners = new Set<Listener>();
  private decodeCtx: AudioContext | null = null;
  private saveTimers = new Map<string, number>();
  /**
   * 活动排练的内存实例：所有写操作都改这同一个对象，
   * 防抖落盘只是把它序列化进 IDB，避免「读旧副本→覆盖新改动」丢数据。
   */
  private live = new Map<string, Rehearsal>();

  subscribe(fn: Listener): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private emit(): void {
    for (const fn of this.listeners) fn();
  }

  // ---------- 排练 ----------

  async listRehearsals(): Promise<Rehearsal[]> {
    const keys = await kvAllKeys();
    const all = await Promise.all(
      keys.filter((k) => k.startsWith(REH_PREFIX)).map((k) => kvGet<Rehearsal>(k)),
    );
    return all
      .filter((x): x is Rehearsal => !!x)
      .sort((a, b) => b.updatedAt - a.updatedAt);
  }

  async getRehearsal(id: string): Promise<Rehearsal | undefined> {
    const cached = this.live.get(id);
    if (cached) return cached;
    const r = await kvGet<Rehearsal>(REH_PREFIX + id);
    if (r) this.live.set(id, r);
    return r;
  }

  async createRehearsal(name: string): Promise<Rehearsal> {
    const now = Date.now();
    const r: Rehearsal = {
      id: uid('reh'),
      name: name.trim() || '未命名排练',
      createdAt: now,
      updatedAt: now,
      referenceTrackId: null,
      tracks: {},
      trackOrder: [],
      materials: {},
    };
    await kvPut(REH_PREFIX + r.id, r);
    this.live.set(r.id, r);
    this.emit();
    return r;
  }

  async renameRehearsal(id: string, name: string): Promise<void> {
    const r = await this.require(id);
    r.name = name.trim() || r.name;
    r.updatedAt = Date.now();
    await this.save(r);
  }

  async deleteRehearsal(id: string): Promise<void> {
    const r = await this.getRehearsal(id);
    if (!r) return;
    await Promise.all(
      Object.values(r.materials).map((m) => blobDelete(m.blobKey).catch(() => undefined)),
    );
    await kvDelete(REH_PREFIX + id);
    this.live.delete(id);
    this.emit();
  }

  // ---------- 素材 ----------

  /**
   * 解码一个音频文件：原始字节存入 IDB，解码出波形包络。
   * 坏文件/不支持的格式会返回带 error 的占位素材，而不是抛异常。
   */
  async addMaterial(rehearsalId: string, file: File): Promise<MaterialMeta> {
    const r = await this.require(rehearsalId);
    const blobKey = uid('blob');
    const base: MaterialMeta = {
      id: uid('mat'),
      name: file.name,
      sampleRate: 0,
      duration: 0,
      channels: 0,
      frames: 0,
      peaks: [],
      peaksBuckets: 0,
      blobKey,
      ext: extOf(file.name),
      size: file.size,
      addedAt: Date.now(),
    };

    try {
      await blobPut(blobKey, file);
      const buf = await this.decodeFile(file);
      const nominal = (await probeNominalSampleRate(file)) ?? buf.sampleRate;
      const chans: Float32Array[] = [];
      for (let c = 0; c < buf.numberOfChannels; c++) chans.push(buf.getChannelData(c));
      const peaks = computePeaks(chans);
      const meta: MaterialMeta = {
        ...base,
        sampleRate: buf.sampleRate,
        nominalSampleRate: nominal,
        duration: buf.duration,
        channels: buf.numberOfChannels,
        frames: buf.length,
        peaks,
        peaksBuckets: peaks.length / 2,
      };
      r.materials[meta.id] = meta;
      await this.save(r);
      return meta;
    } catch (err) {
      const meta: MaterialMeta = {
        ...base,
        error: err instanceof Error ? err.message : String(err),
      };
      // 坏文件也登记一条，便于在列表里标红并删除；blob 清掉避免垃圾
      await blobDelete(blobKey).catch(() => undefined);
      r.materials[meta.id] = { ...meta, blobKey: '' };
      await this.save(r);
      return meta;
    }
  }

  async removeMaterial(rehearsalId: string, materialId: string): Promise<void> {
    const r = await this.require(rehearsalId);
    const m = r.materials[materialId];
    if (!m) return;
    // 同时删除使用该素材的轨道
    for (const [tid, t] of Object.entries(r.tracks)) {
      if (t.materialId === materialId) {
        delete r.tracks[tid];
        r.trackOrder = r.trackOrder.filter((x) => x !== tid);
        if (r.referenceTrackId === tid) r.referenceTrackId = null;
      }
    }
    delete r.materials[materialId];
    if (m.blobKey) await blobDelete(m.blobKey).catch(() => undefined);
    await this.save(r);
  }

  async renameMaterial(rehearsalId: string, materialId: string, name: string): Promise<void> {
    const r = await this.require(rehearsalId);
    const m = r.materials[materialId];
    if (!m) return;
    m.name = name.trim() || m.name;
    await this.save(r);
  }

  /** 读取原始字节并解码为 AudioBuffer（播放/对齐时调用）。 */
  async loadAudioBuffer(rehearsalId: string, materialId: string): Promise<AudioBuffer> {
    const r = await this.require(rehearsalId);
    const m = r.materials[materialId];
    if (!m) throw new Error('素材不存在');
    if (m.error) throw new Error(`素材已损坏：${m.error}`);
    const blob = await blobGet(m.blobKey);
    if (!blob) throw new Error('音频数据缺失（可能被浏览器清理）');
    return this.decodeFile(blob);
  }

  /** 播放/解码所用 AudioContext 的采样率（所有 buffer 的统一网格）。 */
  get contextSampleRate(): number | null {
    return this.decodeCtx ? this.decodeCtx.sampleRate : null;
  }

  private async decodeFile(blob: Blob): Promise<AudioBuffer> {
    if (!this.decodeCtx) {
      const Ctor = window.AudioContext ?? (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
      this.decodeCtx = new Ctor();
    }
    const arr = await blob.arrayBuffer();
    // decodeAudioData 必须拿到未被其它视图引用的 buffer 副本才稳
    const copy = arr.slice(0);
    return await this.decodeCtx.decodeAudioData(copy);
  }

  // ---------- 轨道 ----------

  async createTrack(rehearsalId: string, materialId: string, name?: string): Promise<Track> {
    const r = await this.require(rehearsalId);
    const m = r.materials[materialId];
    if (!m) throw new Error('素材不存在');
    if (m.error) throw new Error('损坏的素材不能建轨');
    const t: Track = {
      id: uid('trk'),
      name: name ?? m.name.replace(/\.[^.]+$/, ''),
      materialId,
      offsetSec: 0,
      driftPpm: 0,
      nudgeSec: 0,
      volume: 1,
      pan: 0,
      muted: false,
      solo: false,
      clips: [],
    };
    r.tracks[t.id] = t;
    r.trackOrder.push(t.id);
    if (!r.referenceTrackId) r.referenceTrackId = t.id;
    await this.save(r);
    return t;
  }

  async updateTrack(rehearsalId: string, trackId: string, patch: Partial<Track>): Promise<void> {
    const r = await this.require(rehearsalId);
    const t = r.tracks[trackId];
    if (!t) throw new Error('轨道不存在');
    Object.assign(t, patch);
    await this.save(r);
  }

  async removeTrack(rehearsalId: string, trackId: string): Promise<void> {
    const r = await this.require(rehearsalId);
    delete r.tracks[trackId];
    r.trackOrder = r.trackOrder.filter((x) => x !== trackId);
    if (r.referenceTrackId === trackId) {
      r.referenceTrackId = r.trackOrder[0] ?? null;
    }
    await this.save(r);
  }

  async setReference(rehearsalId: string, trackId: string): Promise<void> {
    const r = await this.require(rehearsalId);
    if (!r.tracks[trackId]) throw new Error('轨道不存在');
    r.referenceTrackId = trackId;
    // 参考轨自身的偏移/漂移归零（它定义时间轴）
    const ref = r.tracks[trackId];
    ref.offsetSec = 0;
    ref.nudgeSec = 0;
    ref.driftPpm = 0;
    await this.save(r);
  }

  /** 用一次对齐结果覆盖轨道参数。 */
  async applyAlignment(
    rehearsalId: string,
    trackId: string,
    result: { offsetSec: number; driftPpm: number; info: Track['alignInfo'] },
  ): Promise<void> {
    const r = await this.require(rehearsalId);
    const t = r.tracks[trackId];
    if (!t) return;
    t.offsetSec = result.offsetSec;
    t.driftPpm = result.driftPpm;
    t.nudgeSec = 0;
    t.alignInfo = result.info;
    await this.save(r);
  }

  /** 调整剪辑段（start/end 为素材自身时间轴上的秒）。 */
  async setClipRange(
    rehearsalId: string,
    trackId: string,
    clipId: string,
    patch: Partial<Pick<TrackClip, 'start' | 'end'>>,
  ): Promise<void> {
    const r = await this.require(rehearsalId);
    const t = r.tracks[trackId];
    if (!t) return;
    const c = t.clips.find((x) => x.id === clipId);
    if (!c) return;
    if (patch.start !== undefined) c.start = Math.max(0, patch.start);
    if (patch.end !== undefined) c.end = Math.max(c.start + 0.01, patch.end);
    await this.save(r);
  }

  async addClip(rehearsalId: string, trackId: string, start: number, end: number): Promise<void> {
    const r = await this.require(rehearsalId);
    const t = r.tracks[trackId];
    if (!t) return;
    const m = r.materials[t.materialId];
    const e = Math.min(end, m?.duration ?? end);
    t.clips.push({ id: uid('clip'), start: Math.max(0, start), end: Math.max(start + 0.01, e) });
    t.clips.sort((a, b) => a.start - b.start);
    await this.save(r);
  }

  async removeClip(rehearsalId: string, trackId: string, clipId: string): Promise<void> {
    const r = await this.require(rehearsalId);
    const t = r.tracks[trackId];
    if (!t) return;
    t.clips = t.clips.filter((c) => c.id !== clipId);
    await this.save(r);
  }

  // ---------- 打包导出 / 导入 ----------

  async exportProjectFile(rehearsalId: string): Promise<Uint8Array> {
    const r = await this.require(rehearsalId);
    const pf: ProjectFile = {
      format: 'choir-align-mix',
      version: 1,
      rehearsal: structuredClone(r),
      exportedAt: Date.now(),
    };
    const json = new TextEncoder().encode(JSON.stringify(pf));
    const entries = [{ name: 'project.json', data: json }];
    for (const m of Object.values(r.materials)) {
      if (!m.blobKey) continue;
      const blob = await blobGet(m.blobKey);
      if (!blob) continue;
      entries.push({
        name: `audio/${m.blobKey}${m.ext}`,
        data: new Uint8Array(await blob.arrayBuffer()),
      });
    }
    return writeZip(entries);
  }

  async importProjectFile(bytes: Uint8Array): Promise<Rehearsal> {
    const entries = readZip(bytes);
    const jsonEntry = entries.find((e) => e.name === 'project.json');
    if (!jsonEntry) throw new Error('工程文件缺少 project.json');
    const pf = JSON.parse(new TextDecoder().decode(jsonEntry.data)) as ProjectFile;
    if (pf.format !== 'choir-align-mix' || pf.version !== 1) {
      throw new Error('不支持的工程文件版本');
    }
    const r = structuredClone(pf.rehearsal);
    // 重新生成 id，避免和本机已有工程撞车
    const idMap = new Map<string, string>();
    r.id = uid('reh');
    for (const m of Object.values(r.materials)) {
      const newBlob = uid('blob');
      idMap.set(m.blobKey, newBlob);
      m.blobKey = newBlob;
    }
    for (const e of entries) {
      if (!e.name.startsWith('audio/')) continue;
      const oldKey = e.name.slice('audio/'.length).replace(/\.[^.]+$/, '');
      const newKey = idMap.get(oldKey);
      if (newKey) {
        await blobPut(newKey, new Blob([new Uint8Array(e.data)], { type: 'application/octet-stream' }));
      }
    }
    r.updatedAt = Date.now();
    await kvPut(REH_PREFIX + r.id, r);
    this.live.set(r.id, r);
    this.emit();
    return r;
  }

  // ---------- 内部 ----------

  private async require(id: string): Promise<Rehearsal> {
    const cached = this.live.get(id);
    if (cached) return cached;
    const r = await kvGet<Rehearsal>(REH_PREFIX + id);
    if (!r) throw new Error(`排练 ${id} 不存在`);
    this.live.set(id, r);
    return r;
  }

  /** 防抖持久化，避免拖拽时狂写 IDB */
  private save(r: Rehearsal): Promise<void> {
    r.updatedAt = Date.now();
    const existing = this.saveTimers.get(r.id);
    if (existing) clearTimeout(existing);
    return new Promise((resolve) => {
      const timer = window.setTimeout(() => {
        this.saveTimers.delete(r.id);
        kvPut(REH_PREFIX + r.id, r)
          .then(() => {
            this.emit();
            resolve();
          })
          .catch((e) => {
            console.error('工程保存失败', e);
            resolve();
          });
      }, 150);
      this.saveTimers.set(r.id, timer);
    });
  }

  /** 立即落盘（导出前调用，确保防抖队列里的改动已写入）。 */
  async flush(rehearsalId: string): Promise<void> {
    const timer = this.saveTimers.get(rehearsalId);
    if (timer !== undefined) {
      clearTimeout(timer);
      this.saveTimers.delete(rehearsalId);
      const r = await this.require(rehearsalId);
      await kvPut(REH_PREFIX + r.id, r);
      this.emit();
    }
  }
}

export const store = new ProjectStore();

/**
 * 从原始文件头探测解码前的标称采样率。
 * WAV/RIFF 直接读 fmt chunk；其它压缩格式浏览器解码时本就会统一到
 * AudioContext 采样率，返回 undefined 让调用方回退即可。
 */
async function probeNominalSampleRate(file: File): Promise<number | undefined> {
  try {
    if (!/\.wav$/i.test(file.name)) return undefined;
    const head = new Uint8Array(await file.slice(0, 32).arrayBuffer());
    // RIFF....WAVEfmt 后偏移 24 起为 fmt chunk 体，采样率在 +24..+27
    if (head.length < 28) return undefined;
    const riff = String.fromCharCode(head[0], head[1], head[2], head[3]);
    const wave = String.fromCharCode(head[8], head[9], head[10], head[11]);
    if (riff !== 'RIFF' || wave !== 'WAVE') return undefined;
    const dv = new DataView(head.buffer, head.byteOffset, head.byteLength);
    const sr = dv.getUint32(24, true);
    return sr > 0 ? sr : undefined;
  } catch {
    return undefined;
  }
}
