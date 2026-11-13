/** 工程数据模型（全部可 JSON 序列化，音频字节单独存 IndexedDB / 打包文件） */

export type PageId = 'rehearsals' | 'materials' | 'align' | 'mix' | 'export';

export interface TrackClip {
  id: string;
  /** 相对原始素材的入点（秒，素材自身时间轴） */
  start: number;
  /** 相对原始素材的出点（秒） */
  end: number;
}

export interface Track {
  id: string;
  name: string;
  materialId: string;
  /** 自动对齐得到的恒定偏移（秒，正=本轨晚于参考轨） */
  offsetSec: number;
  /** 时钟偏差 ppm，正=设备时钟偏快；播放/导出时按 1+ppm/1e6 变速重采样 */
  driftPpm: number;
  /** 手动微调（秒），拖拽时修改，叠加在 offsetSec 上 */
  nudgeSec: number;
  /** 线性增益 0..2 */
  volume: number;
  /** 声像 -1（左）..1（右） */
  pan: number;
  muted: boolean;
  solo: boolean;
  /** 剪掉的片段（素材时间轴）；空数组 = 整段保留 */
  clips: TrackClip[];
  /** 自动对齐诊断信息，仅展示用 */
  alignInfo?: {
    headLagMs: number;
    tailLagMs: number;
    residualMs: number;
    confidence: number;
  };
}

export interface MaterialMeta {
  id: string;
  name: string;
  /** 解码后 AudioBuffer 的采样率（= AudioContext 采样率，可能与原始不同） */
  sampleRate: number;
  /** 文件原始标称采样率（解码重采样前），跨设备对齐时用它判断是否需要补偿 */
  nominalSampleRate?: number;
  /** 时长（秒） */
  duration: number;
  channels: number;
  /** 解码后采样点数 */
  frames: number;
  /** 波形包络，长度 2*buckets，交错 [min0,max0,min1,max1,...] */
  peaks: number[];
  peaksBuckets: number;
  /** 原始文件字节在 IndexedDB / 打包文件中的 key */
  blobKey: string;
  /** 原始文件名后缀，如 .wav .m4a */
  ext: string;
  size: number;
  addedAt: number;
  /** 解码失败时的错误信息（坏文件占位，不允许建轨） */
  error?: string;
}

export interface Rehearsal {
  id: string;
  name: string;
  createdAt: number;
  updatedAt: number;
  /** 对齐基准轨 id */
  referenceTrackId: string | null;
  tracks: Record<string, Track>;
  trackOrder: string[];
  materials: Record<string, MaterialMeta>;
}

export interface ProjectFile {
  format: 'choir-align-mix';
  version: 1;
  rehearsal: Rehearsal;
  /** 打包时间（ms epoch） */
  exportedAt: number;
}
