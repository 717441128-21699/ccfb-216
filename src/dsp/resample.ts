/**
 * 任意比值重采样（时钟漂移补偿）。
 *
 * ratio = 输入采样率 / 输出采样率（输出第 n 点取输入第 n·ratio 点）。
 * 例：设备实际跑快了 100 ppm，文件标称 48000 而真实速率 48004.8，
 *     想把数据搬到真实 48000 时间轴上，ratio ≈ 48004.8/48000 = 1.0001。
 *
 * 采用窗口化 sinc（加窗 Shannon）插值，16 点窗、Blackman 窗，
 * 对音乐信号全频带都足够透明；Float64 内部累加。
 */

const HALF_TAPS = 8; // 每侧 8 点，共 16 阶

export function resampleRatio(
  input: Float64Array | Float32Array,
  ratio: number,
  startPhase = 0,
): Float64Array {
  if (!(ratio > 0) || !Number.isFinite(ratio)) {
    throw new Error(`非法重采样比值: ${ratio}`);
  }
  const outLen = Math.max(0, Math.floor((input.length - startPhase) / ratio));
  const out = new Float64Array(outLen);
  if (outLen === 0) return out;

  for (let n = 0; n < outLen; n++) {
    const center = startPhase + n * ratio;
    const i0 = Math.floor(center);
    let acc = 0;
    const kStart = i0 - HALF_TAPS + 1;
    const kEnd = i0 + HALF_TAPS;
    for (let k = kStart; k <= kEnd; k++) {
      const x = k - center;
      acc += sampleClamped(input, k) * sincWindowed(x);
    }
    out[n] = acc;
  }
  return out;
}

/** 已知输出长度的重采样（按 (inLen-1)/(outLen-1) 对齐首尾）。 */
export function resampleToLength(
  input: Float64Array | Float32Array,
  outLen: number,
): Float64Array {
  if (outLen <= 1) return new Float64Array(outLen);
  const ratio = (input.length - 1) / (outLen - 1);
  const out = new Float64Array(outLen);
  for (let n = 0; n < outLen; n++) {
    const center = n * ratio;
    const i0 = Math.floor(center);
    let acc = 0;
    for (let k = i0 - HALF_TAPS + 1; k <= i0 + HALF_TAPS; k++) {
      acc += sampleClamped(input, k) * sincWindowed(k - center);
    }
    out[n] = acc;
  }
  return out;
}

/** 线性插值重采样（仅供粗略预对齐/预览用，正式补偿走 sinc）。 */
export function resampleLinear(
  input: Float64Array | Float32Array,
  ratio: number,
  startPhase = 0,
): Float64Array {
  const outLen = Math.max(0, Math.floor((input.length - startPhase) / ratio));
  const out = new Float64Array(outLen);
  for (let n = 0; n < outLen; n++) {
    const center = startPhase + n * ratio;
    const i0 = Math.floor(center);
    const frac = center - i0;
    const x0 = sampleClamped(input, i0);
    const x1 = sampleClamped(input, i0 + 1);
    out[n] = x0 + (x1 - x0) * frac;
  }
  return out;
}

function sampleClamped(input: Float64Array | Float32Array, k: number): number {
  if (k < 0) return input[0];
  if (k >= input.length) return input[input.length - 1];
  return input[k];
}

/** 加 Blackman 窗的归一化 sinc。 */
function sincWindowed(x: number): number {
  if (Math.abs(x) < 1e-12) return 1;
  if (Math.abs(x) >= HALF_TAPS) return 0;
  const px = Math.PI * x;
  const sinc = Math.sin(px) / px;
  // Blackman：0.42 + 0.5 cos(πx/M) + 0.08 cos(2πx/M)，M = HALF_TAPS
  const w =
    0.42 +
    0.5 * Math.cos((Math.PI * x) / HALF_TAPS) +
    0.08 * Math.cos((2 * Math.PI * x) / HALF_TAPS);
  return sinc * w;
}

/**
 * 把 ppm 级时钟偏差换算成重采样比值。
 * ppm > 0 表示设备时钟偏快（同样真实时间里录到更多采样点）。
 */
export function ppmToRatio(ppm: number): number {
  return 1 + ppm / 1e6;
}

/**
 * 亚采样精度的整体平移：返回 out，使 out[n] ≈ input[n + shift]，
 * shift 可为小数、可为负。物理含义：目标信号晚了 shift 个采样
 * （lag = +shift），把它整体前移 shift 即可与参考对齐。
 */
export function shiftSignal(input: Float64Array, shift: number): Float64Array {
  const out = new Float64Array(input.length);
  for (let n = 0; n < input.length; n++) {
    const center = n + shift;
    const i0 = Math.floor(center);
    for (let k = i0 - HALF_TAPS + 1; k <= i0 + HALF_TAPS; k++) {
      out[n] += sampleClamped(input, k) * sincWindowed(k - center);
    }
  }
  return out;
}
