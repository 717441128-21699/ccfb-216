/**
 * 纯 Node 测试（node --experimental-strip-types 直接跑 TS）：
 * 不依赖浏览器，覆盖 FFT/互相关/重采样/漂移估计/WAV/ZIP 全链路，
 * 长录音用较低采样率控制内存，但时长严格 30 分钟。
 */
import { FFT, nextPow2 } from '../src/dsp/fft.ts';
import { xcorrLag } from '../src/dsp/xcorr.ts';
import { estimateDrift } from '../src/dsp/alignment.ts';
import { resampleRatio, shiftSignal } from '../src/dsp/resample.ts';
import { decodeWav, encodeWav } from '../src/dsp/wav.ts';
import { readZip, writeZip, crc32 } from '../src/util/zip.ts';
import { generateRecording, generateReference, makeRng } from '../src/dsp/testgen.ts';
import { activeRegions, effectiveOffset, projectMaterialTime, retainedMaterialSegments } from '../src/dsp/arrangement.ts';
import type { Track } from '../src/model/types.ts';

let passed = 0;
let failed = 0;
const failures: string[] = [];

function check(name: string, cond: boolean, detail = ''): void {
  if (cond) {
    passed++;
    console.log(`  ✓ ${name}`);
  } else {
    failed++;
    failures.push(`${name} ${detail}`);
    console.log(`  ✗ ${name} ${detail}`);
  }
}

function approx(a: number, b: number, tol: number): boolean {
  return Math.abs(a - b) <= tol;
}

// ---------------- 1. FFT 正确性：与朴素 DFT 对比 ----------------
function testFFT(): void {
  console.log('\n[1] FFT 与朴素 DFT 对比');
  const n = 64;
  const rng = makeRng(42);
  const re = new Float64Array(n);
  const im = new Float64Array(n);
  for (let i = 0; i < n; i++) re[i] = rng() * 2 - 1;
  const reRef = re.slice();
  const imRef = im.slice();

  // 朴素 DFT
  const dftRe = new Float64Array(n);
  const dftIm = new Float64Array(n);
  for (let k = 0; k < n; k++) {
    let sr = 0;
    let si = 0;
    for (let t = 0; t < n; t++) {
      const ang = (-2 * Math.PI * k * t) / n;
      sr += reRef[t] * Math.cos(ang) - imRef[t] * Math.sin(ang);
      si += reRef[t] * Math.sin(ang) + imRef[t] * Math.cos(ang);
    }
    dftRe[k] = sr;
    dftIm[k] = si;
  }

  const fft = new FFT(n);
  fft.forward(re, im);
  let maxErr = 0;
  for (let k = 0; k < n; k++) {
    maxErr = Math.max(maxErr, Math.abs(re[k] - dftRe[k]), Math.abs(im[k] - dftIm[k]));
  }
  check('FFT 正变换误差 < 1e-10', maxErr < 1e-10, `maxErr=${maxErr.toExponential(2)}`);

  // 逆变换还原
  fft.inverse(re, im);
  let invErr = 0;
  for (let i = 0; i < n; i++) invErr = Math.max(invErr, Math.abs(re[i] - reRef[i]), Math.abs(im[i] - imRef[i]));
  check('FFT 逆变换可还原', invErr < 1e-12, `err=${invErr.toExponential(2)}`);
  check('nextPow2 边界正确', nextPow2(1000) === 1024 && nextPow2(1024) === 1024 && nextPow2(1) === 1);
}

// ---------------- 2. 互相关：已知整数/小数偏移 ----------------
function testXcorr(): void {
  console.log('\n[2] 互相关延迟估计');
  const sr = 8000;
  const ref = generateReference({ sampleRate: sr, durationSec: 8, seed: 7, noiseLevel: 0.01 });

  for (const shiftSec of [0.123, -0.25, 0.5001]) {
    const shift = Math.round(shiftSec * sr);
    const shifted = new Float64Array(ref.length);
    for (let i = 0; i < ref.length; i++) {
      const j = i - shift;
      if (j >= 0 && j < ref.length) shifted[i] = ref[j];
    }
    const r = xcorrLag(ref, shifted, { phat: true });
    const errMs = Math.abs(r.lag - shift) / sr * 1000;
    check(`整数偏移 ${shiftSec}s 估计误差 < 0.5ms`, errMs < 0.5, `lag=${r.lag} truth=${shift} err=${errMs.toFixed(3)}ms conf=${r.confidence.toFixed(2)}`);
  }

  // 亚采样偏移：用线性插值构造 2.3 个采样的延迟
  const frac = 2.3;
  const shifted = new Float64Array(ref.length);
  for (let i = 0; i < ref.length; i++) {
    const j = i - frac;
    const j0 = Math.floor(j);
    const f = j - j0;
    if (j0 >= 0 && j0 + 1 < ref.length) shifted[i] = ref[j0] * (1 - f) + ref[j0 + 1] * f;
  }
  const r = xcorrLag(ref, shifted, { phat: true });
  const errSamples = Math.abs(r.lag - frac);
  check('亚采样偏移 2.3 点误差 < 0.25 采样', errSamples < 0.25, `lag=${r.lag.toFixed(3)} err=${errSamples.toFixed(3)}`);
}

// ---------------- 3. 重采样：比值往返 + 正弦频率保持 ----------------
function testResample(): void {
  console.log('\n[3] sinc 重采样');
  const sr = 12000;
  const n = sr * 2;
  const sine = new Float64Array(n);
  for (let i = 0; i < n; i++) sine[i] = Math.sin(2 * Math.PI * 440 * (i / sr));

  // 1.0001 比值（100ppm）往返后长度与波形应近似还原
  const up = resampleRatio(sine, 1.0001);
  check('重采样长度按比值变化', approx(up.length, n / 1.0001, 2), `got=${up.length} expect≈${Math.round(n / 1.0001)}`);
  const back = resampleRatio(up, 1 / 1.0001);
  const compareLen = Math.min(back.length, n) - 64;
  let err = 0;
  for (let i = 64; i < compareLen; i++) err = Math.max(err, Math.abs(back[i] - sine[i]));
  check('重采样往返波形误差 < 0.02', err < 0.02, `maxErr=${err.toExponential(2)}`);

  // 频率保持：1000Hz 正弦以 0.9 比值重采样后，输出采样点间隔对应的
  // 角频率变为 0.9 倍，即按输出网格解释主频为 900Hz（内容本身没改音高）
  const f0 = 1000;
  const src = new Float64Array(sr);
  for (let i = 0; i < sr; i++) src[i] = Math.sin(2 * Math.PI * f0 * (i / sr));
  const out = resampleRatio(src, 0.9);
  const coherenceAt = (freq: number): number => {
    let cr = 0;
    let ci = 0;
    for (let t = 0; t < out.length; t++) {
      const w = (2 * Math.PI * freq * t) / sr;
      cr += out[t] * Math.cos(w);
      ci += out[t] * Math.sin(w);
    }
    return (2 * Math.hypot(cr, ci)) / out.length;
  };
  const c900 = coherenceAt(900);
  const c1000 = coherenceAt(1000);
  check('重采样后主频落在比值预测的 900Hz', c900 > 0.9 && c900 > c1000 * 5, `c900=${c900.toFixed(3)} c1000=${c1000.toFixed(3)}`);
}

// ---------------- 4. 漂移估计：已知偏移+ppm，检查 1ms 精度 ----------------
function testDrift(durationSec: number, sr: number, label: string): void {
  console.log(`\n[4] 漂移端到端（${label}，${durationSec / 60} 分钟 @ ${sr}Hz）`);
  const ref = generateReference({ sampleRate: sr, durationSec, seed: 11, noiseLevel: 0.015 });

  const cases: Array<{ off: number; ppm: number; trim?: number }> = [
    { off: 0.3, ppm: 50 },
    { off: -1.2, ppm: -80 },
    { off: 2.0, ppm: 120, trim: 5 },
    { off: 0.05, ppm: 0 },
  ];

  for (const [i, c] of cases.entries()) {
    const rec = generateRecording(ref, sr, {
      sampleRate: sr,
      durationSec,
      seed: 100 + i,
      offsetSec: c.off,
      driftPpm: c.ppm,
      extraNoise: 0.01,
      trimTailSec: c.trim ?? 0,
    });
    const est = estimateDrift(ref, rec, { sampleRate: sr, windowSec: 12, marginSec: 2, maxLagSec: 60 });
    const ppmErr = Math.abs(est.ppm - c.ppm);
    const offErrMs = Math.abs(est.constantLag / sr - c.off) * 1000;

    check(
      `${label} case${i + 1} 偏移 ${c.off}s / ${c.ppm}ppm：偏移误差 < 1ms`,
      offErrMs < 1,
      `offErr=${offErrMs.toFixed(3)}ms`,
    );
    // 关键验收：按 ratio 重采样 + 亚采样平移恒定偏移后，头/尾窗口与参考的残差都得 < 1ms
    const corrected = shiftSignal(resampleRatio(rec, est.ratio), est.constantLag);
    const win = Math.floor(10 * sr);
    const headErr = residualAfterShiftMs(ref, corrected, sr, Math.floor(3 * sr), win);
    const tailCenter = Math.min(ref.length, corrected.length) - Math.floor(8 * sr);
    const tailErr = residualAfterShiftMs(ref, corrected, sr, tailCenter - win / 2, win);
    const tolPpm = durationSec >= 30 * 60 ? 2 : 5;
    check(`${label} case${i + 1} ppm 误差 < ${tolPpm}ppm`, ppmErr < tolPpm, `ppmErr=${ppmErr.toFixed(3)}`);
    check(`${label} case${i + 1} 补偿后头部残差 < 1ms`, headErr < 1, `head=${headErr.toFixed(3)}ms`);
    check(`${label} case${i + 1} 补偿后尾部残差 < 1ms`, tailErr < 1, `tail=${tailErr.toFixed(3)}ms`);
    console.log(`      估计: offset=${(est.constantLag / sr * 1000).toFixed(3)}ms ppm=${est.ppm.toFixed(3)} R²=${est.r2.toFixed(4)} 窗口=${est.windows} 报告残差=${est.residualMs.toFixed(3)}ms 置信度=${est.confidence.toFixed(2)}`);
  }
}

/**
 * 平移已在调用方通过 shiftSignal 完成，这里直接在 start 起的窗口内
 * 做小范围互相关，返回残余偏差毫秒数。
 */
function residualAfterShiftMs(
  ref: Float64Array,
  tgt: Float64Array,
  sr: number,
  start: number,
  win: number,
): number {
  const len = Math.min(win, ref.length - start, tgt.length - start);
  const a = ref.subarray(start, start + len);
  const b = tgt.subarray(start, start + len);
  const r = xcorrLag(a, b, { phat: true, maxLag: Math.max(8, Math.floor(0.02 * sr)) });
  return Math.abs(r.lag) / sr * 1000;
}

// ---------------- 5. WAV 往返 ----------------
function testWav(): void {
  console.log('\n[5] WAV 编解码往返');
  const sr = 16000;
  const n = sr;
  const mono = new Float64Array(n);
  const left = new Float64Array(n);
  const right = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    mono[i] = 0.5 * Math.sin(2 * Math.PI * 300 * (i / sr));
    left[i] = 0.4 * Math.sin(2 * Math.PI * 300 * (i / sr));
    right[i] = 0.3 * Math.sin(2 * Math.PI * 500 * (i / sr));
  }

  for (const bits of [16, 24, 32] as const) {
    const bytes = encodeWav([mono], sr, bits);
    const dec = decodeWav(bytes);
    check(`WAV ${bits}-bit 采样率/声道/帧数正确`, dec.sampleRate === sr && dec.channels.length === 1 && dec.channels[0].length === n);
    let err = 0;
    for (let i = 0; i < n; i++) err = Math.max(err, Math.abs(dec.channels[0][i] - mono[i]));
    const tol = bits === 16 ? 1 / 0x7fff + 1e-6 : bits === 24 ? 1 / 0x7fffff + 1e-7 : 1e-9;
    check(`WAV ${bits}-bit 往返误差在量化容差内`, err < tol * 2, `err=${err.toExponential(2)}`);
  }

  const stereo = encodeWav([left, right], sr, 16);
  const decS = decodeWav(stereo);
  check('WAV 立体声双声道独立保持', decS.channels.length === 2 && approx(decS.channels[0][100], left[100], 1e-4) && approx(decS.channels[1][100], right[100], 1e-4));

  // 坏文件
  let threw = false;
  try {
    decodeWav(new TextEncoder().encode('not a wav file at all......'));
  } catch {
    threw = true;
  }
  check('坏 WAV 抛异常（UI 层据此标红提示）', threw);
}

// ---------------- 6. ZIP 往返 + CRC ----------------
function testZip(): void {
  console.log('\n[6] ZIP 打包/解包（工程文件格式）');
  check('CRC32 已知向量正确', crc32(new TextEncoder().encode('123456789')) === 0xcbf43926);

  const entries = [
    { name: 'project.json', data: new TextEncoder().encode('{"format":"choir-align-mix"}') },
    { name: 'audio/a.wav', data: new Uint8Array([1, 2, 3, 4, 5, 255, 0, 128]) },
    { name: 'audio/b.m4a', data: new Uint8Array(1000).map((_, i) => i % 251) },
  ];
  const zip = writeZip(entries);
  const back = readZip(zip);
  check('ZIP 条目数一致', back.length === entries.length);
  let allMatch = true;
  for (const e of entries) {
    const got = back.find((x) => x.name === e.name);
    if (!got || got.data.length !== e.data.length || got.data.some((v, i) => v !== e.data[i])) allMatch = false;
  }
  check('ZIP 各条目字节完全一致', allMatch);

  // 确定性：同内容两次输出相同
  const zip2 = writeZip(entries);
  check('ZIP 输出确定性（同内容同字节）', zip.length === zip2.length && zip.every((v, i) => v === zip2[i]));

  let threw = false;
  try {
    readZip(new Uint8Array([1, 2, 3, 4, 5]));
  } catch {
    threw = true;
  }
  check('坏 ZIP 抛异常', threw);
}

// ---------------- 7. 剪辑/对齐几何：剪辑不能破坏对齐 ----------------
function testArrangement(): void {
  console.log('\n[7] 剪辑与时间轴几何');
  const base: Track = {
    id: 't1',
    name: 't',
    materialId: 'm1',
    offsetSec: 1.0,
    driftPpm: 100, // rate = 1.0001
    nudgeSec: 0.005,
    volume: 1,
    pan: 0,
    muted: false,
    solo: false,
    clips: [],
  };

  check('有效偏移 = 自动偏移 + 微调', approx(effectiveOffset(base), 1.005, 1e-12));
  check('漂移速率 = 1 + ppm/1e6', approx(base.driftPpm / 1e6 + 1, 1.0001, 1e-12));
  // u=10s 的素材点投影到工程时间：1.005 + 10*1.0001 = 11.006
  check('素材时间正确投影到工程时间', approx(projectMaterialTime(base, 10), 11.006, 1e-12));

  // 无剪辑：整段保留，区间即整段素材投影
  const whole = activeRegions(base, 60, -100, 100);
  check('无剪辑时只有一个发声段', whole.length === 1);
  check('无剪辑发声段起点对齐投影', approx(whole[0][0], 1.005, 1e-9));
  check('无剪辑发声段终点 = 起点 + 时长·rate', approx(whole[0][1], 1.005 + 60 * 1.0001, 1e-9));

  // 剪掉开头 0~8s（闲聊）和中间 20~23s（停顿）
  const cut: Track = {
    ...base,
    clips: [
      { id: 'c1', start: 0, end: 8 },
      { id: 'c2', start: 20, end: 23 },
    ],
  };
  const retained = retainedMaterialSegments(cut, 60);
  check('求补集得到 2 个保留段', retained.length === 2);
  check('第一个保留段为 8~20s', approx(retained[0][0], 8, 1e-9) && approx(retained[0][1], 20, 1e-9));
  check('第二个保留段为 23~60s', approx(retained[1][0], 23, 1e-9) && approx(retained[1][1], 60, 1e-9));

  const regions = activeRegions(cut, 60, -100, 100);
  check('剪辑后有 2 个发声段', regions.length === 2);
  // 关键：保留段仍在原对齐位置（起点用同样的 offset/rate 投影），只是中间空了
  check('剪辑后第一段仍对齐原投影', approx(regions[0][0], projectMaterialTime(cut, 8), 1e-9));
  check('剪辑后第二段起点不受影响', approx(regions[1][0], projectMaterialTime(cut, 23), 1e-9));
  // 被剪掉的 20~23s 投影区间不出现在发声段里
  const cutStart = projectMaterialTime(cut, 20);
  const cutEnd = projectMaterialTime(cut, 23);
  const overlapsCut = regions.some(([a, b]) => a < cutEnd - 1e-9 && b > cutStart + 1e-9);
  check('被剪区间不发声', !overlapsCut);

  // 区域裁剪：只导出 [11, 12] 工程秒时，发声段被正确裁切
  const partial = activeRegions(cut, 60, 11, 12);
  check('区域裁剪只返回交集', partial.length === 1 && approx(partial[0][0], 11, 1e-9) && approx(partial[0][1], 12, 1e-9));
}

// ---------------- 主流程 ----------------
function main(): void {
  const t0 = Date.now();
  testFFT();
  testXcorr();
  testResample();
  testDrift(180, 24000, '短录音');
  testWav();
  testZip();
  testArrangement();
  // 30 分钟 @ 8kHz：1440 万采样/轨，内存可控，时长严格达标
  // 快速模式（--fast）跳过长测，本地迭代用
  if (!process.argv.includes('--fast')) {
    testDrift(30 * 60, 8000, '长录音 30 分钟');
  } else {
    console.log('\n[跳过] 30 分钟长测（--fast 模式）');
  }

  console.log(`\n========================================`);
  console.log(`通过 ${passed} 项，失败 ${failed} 项，耗时 ${((Date.now() - t0) / 1000).toFixed(1)}s`);
  if (failed > 0) {
    console.log('失败项：');
    for (const f of failures) console.log('  - ' + f);
    process.exit(1);
  }
}

main();
