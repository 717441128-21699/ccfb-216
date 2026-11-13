/**
 * 纯数据 WAV 编解码，无 DOM 依赖，浏览器与 Node 测试共用。
 * 支持 PCM 16/24/32-bit 与 IEEE float32，多声道交错。
 */

export type WavBitDepth = 16 | 24 | 32;

export interface WavData {
  sampleRate: number;
  channels: Float64Array[]; // 每声道一个数组
}

export function encodeWav(
  data: Float64Array[] | Float32Array[],
  sampleRate: number,
  bitDepth: WavBitDepth = 16,
): Uint8Array {
  const ch = data.length;
  if (ch === 0) throw new Error('WAV 编码：至少需要一个声道');
  const frames = data[0].length;
  const bytesPerSample = bitDepth / 8;
  const blockAlign = ch * bytesPerSample;
  const dataBytes = frames * blockAlign;
  const buf = new ArrayBuffer(44 + dataBytes);
  const dv = new DataView(buf);
  let p = 0;
  const writeStr = (s: string) => {
    for (let i = 0; i < s.length; i++) {
      dv.setUint8(p, s.charCodeAt(i));
      p++;
    }
  };
  const writeU32 = (v: number) => { dv.setUint32(p, v, true); p += 4; };
  const writeU16 = (v: number) => { dv.setUint16(p, v, true); p += 2; };

  writeStr('RIFF');
  writeU32(36 + dataBytes);
  writeStr('WAVE');
  writeStr('fmt ');
  writeU32(16);
  writeU16(1); // PCM integer
  writeU16(ch);
  writeU32(sampleRate);
  writeU32(sampleRate * blockAlign);
  writeU16(blockAlign);
  writeU16(bitDepth);
  writeStr('data');
  writeU32(dataBytes);

  for (let n = 0; n < frames; n++) {
    for (let c = 0; c < ch; c++) {
      const v = clampSample(data[c][n]);
      if (bitDepth === 16) {
        dv.setInt16(p, v * 0x7fff, true);
        p += 2;
      } else if (bitDepth === 24) {
        const iv = Math.round(v * 0x7fffff);
        dv.setUint8(p, iv & 0xff);
        dv.setUint8(p + 1, (iv >> 8) & 0xff);
        dv.setUint8(p + 2, (iv >> 16) & 0xff);
        p += 3;
      } else {
        dv.setInt32(p, Math.round(v * 0x7fffffff), true);
        p += 4;
      }
    }
  }
  return new Uint8Array(buf);

  function clampSample(x: number): number {
    return Math.max(-1, Math.min(1, x));
  }
}

export function encodeWavFloat(
  data: Float64Array[] | Float32Array[],
  sampleRate: number,
): Uint8Array {
  const ch = data.length;
  const frames = data[0].length;
  const buf = new ArrayBuffer(44 + frames * ch * 4);
  const dv = new DataView(buf);
  let p = 0;
  const writeStr = (s: string) => {
    for (let i = 0; i < s.length; i++) {
      dv.setUint8(p, s.charCodeAt(i));
      p++;
    }
  };
  const writeU32 = (v: number) => { dv.setUint32(p, v, true); p += 4; };
  const writeU16 = (v: number) => { dv.setUint16(p, v, true); p += 2; };
  writeStr('RIFF');
  writeU32(36 + frames * ch * 4);
  writeStr('WAVE');
  writeStr('fmt ');
  writeU32(16);
  writeU16(3); // IEEE float
  writeU16(ch);
  writeU32(sampleRate);
  writeU32(sampleRate * ch * 4);
  writeU16(ch * 4);
  writeU16(32);
  writeStr('data');
  writeU32(frames * ch * 4);
  for (let n = 0; n < frames; n++) {
    for (let c = 0; c < ch; c++) {
      dv.setFloat32(p, data[c][n], true);
      p += 4;
    }
  }
  return new Uint8Array(buf);
}

/** 解析 WAV（支持 PCM 16/24/32 与 float32，跳过未知 chunk）。 */
export function decodeWav(bytes: Uint8Array): WavData {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let p = 0;
  const readStr = (len: number): string => {
    let s = '';
    for (let i = 0; i < len; i++) {
      s += String.fromCharCode(dv.getUint8(p));
      p++;
    }
    return s;
  };
  // RIFF(4) + 整体尺寸(4) + WAVE(4)
  if (readStr(4) !== 'RIFF') throw new Error('不是合法的 WAV 文件（缺少 RIFF 头）');
  p += 4; // 跳过 RIFF chunk size
  if (readStr(4) !== 'WAVE') throw new Error('不是合法的 WAV 文件（缺少 WAVE 头）');
  let sampleRate = 0;
  let channels = 0;
  let audioFormat = 1;
  let bits = 16;
  let dataBytes: Uint8Array | null = null;

  while (p + 8 <= bytes.length) {
    const id = readStr(4);
    const size = dv.getUint32(p, true);
    p += 4;
    const body = p;
    if (id === 'fmt ') {
      audioFormat = dv.getUint16(body, true);
      channels = dv.getUint16(body + 2, true);
      sampleRate = dv.getUint32(body + 4, true);
      bits = dv.getUint16(body + 14, true);
    } else if (id === 'data') {
      dataBytes = new Uint8Array(bytes.buffer, bytes.byteOffset + body, size);
    }
    p = body + size + (size & 1); // chunk 按偶数字节对齐
    // 两个关键 chunk 都拿到才退出，避免 data 先于 fmt 时参数缺失
    if (dataBytes && sampleRate && channels) break;
  }
  if (!dataBytes) throw new Error('WAV 中找不到 data chunk');
  if (!sampleRate || !channels) throw new Error('WAV fmt chunk 不完整');

  const bps = bits / 8;
  const frames = Math.floor(dataBytes.length / (bps * channels));
  const out: Float64Array[] = [];
  for (let c = 0; c < channels; c++) out.push(new Float64Array(frames));
  const base = dataBytes.byteOffset;

  for (let n = 0; n < frames; n++) {
    for (let c = 0; c < channels; c++) {
      const q = base + (n * channels + c) * bps;
      let v: number;
      if (audioFormat === 3 && bits === 32) {
        v = dv.getFloat32(q, true);
      } else if (bits === 16) {
        v = dv.getInt16(q, true) / 0x8000;
      } else if (bits === 24) {
        const u = dv.getUint8(q) | (dv.getUint8(q + 1) << 8) | (dv.getUint8(q + 2) << 16);
        v = (u > 0x7fffff ? u - 0x1000000 : u) / 0x800000;
      } else if (bits === 32) {
        v = dv.getInt32(q, true) / 0x80000000;
      } else {
        throw new Error(`不支持的 WAV 格式：format=${audioFormat} bits=${bits}`);
      }
      out[c][n] = v;
    }
  }
  return { sampleRate, channels: out };
}
