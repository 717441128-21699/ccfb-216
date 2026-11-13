/**
 * 迭代基-2 FFT（原地 Cooley–Tukey），全 Float64 精度。
 * 长度必须是 2 的幂。约定：
 *   forward: X[k] = Σ x[n] · exp(-j·2πkn/N)
 *   inverse: x[n] = (1/N) · Σ X[k] · exp(+j·2πkn/N)
 */
export class FFT {
  readonly size: number;
  private readonly bits: number;
  private readonly cos: Float64Array;
  private readonly sin: Float64Array;
  private readonly rev: Uint32Array;

  constructor(size: number) {
    if (size < 2 || (size & (size - 1)) !== 0) {
      throw new Error(`FFT 长度必须是 2 的幂，收到 ${size}`);
    }
    this.size = size;
    this.bits = Math.log2(size);
    this.cos = new Float64Array(size >> 1);
    this.sin = new Float64Array(size >> 1);
    for (let i = 0; i < size >> 1; i++) {
      this.cos[i] = Math.cos((-2 * Math.PI * i) / size);
      this.sin[i] = Math.sin((-2 * Math.PI * i) / size);
    }
    this.rev = new Uint32Array(size);
    for (let i = 0; i < size; i++) {
      this.rev[i] = reverseBits(i, this.bits);
    }
  }

  /** 正变换：re/im 长度均为 size，原地改写。 */
  forward(re: Float64Array, im: Float64Array): void {
    this.transform(re, im, false);
  }

  /** 逆变换（带 1/N 归一化）。 */
  inverse(re: Float64Array, im: Float64Array): void {
    this.transform(re, im, true);
  }

  private transform(re: Float64Array, im: Float64Array, inverse: boolean): void {
    const n = this.size;
    // 位反转排列
    for (let i = 0; i < n; i++) {
      const j = this.rev[i];
      if (j > i) {
        let t = re[i];
        re[i] = re[j];
        re[j] = t;
        t = im[i];
        im[i] = im[j];
        im[j] = t;
      }
    }
    for (let size = 2; size <= n; size <<= 1) {
      const half = size >> 1;
      const step = n / size;
      for (let i = 0; i < n; i += size) {
        let k = 0;
        for (let j = i; j < i + half; j++) {
          const c = this.cos[k];
          const s = inverse ? -this.sin[k] : this.sin[k];
          const tr = c * re[j + half] - s * im[j + half];
          const ti = c * im[j + half] + s * re[j + half];
          re[j + half] = re[j] - tr;
          im[j + half] = im[j] - ti;
          re[j] += tr;
          im[j] += ti;
          k += step;
        }
      }
    }
    if (inverse) {
      for (let i = 0; i < n; i++) {
        re[i] /= n;
        im[i] /= n;
      }
    }
  }
}

function reverseBits(x: number, bits: number): number {
  let y = 0;
  for (let i = 0; i < bits; i++) {
    y = (y << 1) | (x & 1);
    x >>= 1;
  }
  return y >>> 0;
}

/** 取 >= n 的最小 2 的幂。 */
export function nextPow2(n: number): number {
  if (n <= 1) return 1;
  return 1 << Math.ceil(Math.log2(n));
}
