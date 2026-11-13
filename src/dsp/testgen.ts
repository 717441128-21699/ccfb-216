/**
 * 测试信号生成（Node 与浏览器都可用）：
 * 信号 = 和声进行的锯齿波 + 随机「拍点」脉冲 + 白噪声，全程有能量、
 * 有清晰瞬态，适合互相关。所有随机数走可种子化 PRNG，结果可复现。
 */

/** mulberry32 可种子化随机数 */
export function makeRng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export interface SignalSpec {
  sampleRate: number;
  durationSec: number;
  seed: number;
  /** 噪声分量幅度 */
  noiseLevel?: number;
}

export function generateReference(spec: SignalSpec): Float64Array {
  const { sampleRate: sr, durationSec, seed } = spec;
  const n = Math.round(durationSec * sr);
  const rng = makeRng(seed);
  const out = new Float64Array(n);
  const noise = spec.noiseLevel ?? 0.02;

  // 每 2 秒换一个和弦根音（A 小调进行 A-F-C-G），频率单位 Hz
  const roots = [220, 174.61, 261.63, 196.0];
  const chord = [1, 1.2, 1.5]; // 根音、三度、五度的频率比

  for (let i = 0; i < n; i++) {
    const t = i / sr;
    const chordIdx = Math.floor(t / 2) % roots.length;
    let v = 0;
    for (const ratio of chord) {
      const f = roots[chordIdx] * ratio;
      // 锯齿波的前 6 个谐波
      for (let h = 1; h <= 6; h++) {
        v += (0.05 / h) * Math.sign(Math.sin(2 * Math.PI * f * h * t));
      }
    }
    out[i] = v;
  }

  // 随机拍点：指数衰减的正弦脉冲，模拟指挥手势/咬字瞬态。
  // 间隔在 0.32~0.68s 间随机，避免严格周期性——真实合唱的瞬态不是
  // 等间距的，等距拍点会让互相关在节拍周期处产生等高假峰。
  let bt = 0.25;
  while (bt < durationSec) {
    const jitter = (rng() - 0.5) * 0.05;
    const center = bt + jitter;
    const f = 800 + rng() * 1200;
    const decay = 0.012 + rng() * 0.02;
    const start = Math.max(0, Math.floor((center - 0.05) * sr));
    const end = Math.min(n, Math.ceil((center + 0.1) * sr));
    for (let i = start; i < end; i++) {
      const dt = i / sr - center;
      const env = Math.exp(-Math.abs(dt) / decay);
      out[i] += 0.55 * env * Math.sin(2 * Math.PI * f * dt);
    }
    bt += 0.32 + rng() * 0.36;
  }

  // 白噪声（模拟环境底噪，也让相关峰不至于数值完美）
  for (let i = 0; i < n; i++) {
    out[i] += (rng() * 2 - 1) * noise;
  }

  // 归一化到 -3 dB 左右
  let peak = 0;
  for (let i = 0; i < n; i++) peak = Math.max(peak, Math.abs(out[i]));
  const g = 0.7 / peak;
  for (let i = 0; i < n; i++) out[i] *= g;
  return out;
}

export interface RecorderSpec extends SignalSpec {
  /** 已知起始偏移（秒，正=该机晚开始录） */
  offsetSec: number;
  /** 已知时钟偏差 ppm，正=时钟偏快 */
  driftPpm: number;
  /** 额外底噪（模拟不同手机的麦噪） */
  extraNoise?: number;
  /** 截掉尾部的秒数（模拟某台手机先按停） */
  trimTailSec?: number;
}

/**
 * 按「手机录音」物理模型生成一条目标轨：
 *   设备以 (1+ppm/1e6) 倍速采样，晚 offsetSec 开始，
 *   输出第 k 点对应真实时间 k / (sr·rate)，内容取参考信号在
 *   （该时间 - offsetSec）处的值。
 */
export function generateRecording(ref: Float64Array, refSr: number, spec: RecorderSpec): Float64Array {
  const rate = 1 + spec.driftPpm / 1e6;
  const sr = spec.sampleRate;
  const totalDur = spec.durationSec - (spec.trimTailSec ?? 0);
  const n = Math.round(totalDur * sr);
  const rng = makeRng(spec.seed ^ 0x9e3779b9);
  const out = new Float64Array(n);

  for (let k = 0; k < n; k++) {
    const realTime = k / (sr * rate);
    const srcTime = realTime - spec.offsetSec;
    const idx = srcTime * refSr;
    out[k] = sampleLinear(ref, idx);
    if (spec.extraNoise) out[k] += (rng() * 2 - 1) * spec.extraNoise;
  }
  return out;
}

function sampleLinear(x: Float64Array, idx: number): number {
  if (idx < 0 || idx >= x.length - 1) return 0;
  const i = Math.floor(idx);
  const f = idx - i;
  return x[i] * (1 - f) + x[i + 1] * f;
}
