/**
 * 生成带已知偏移/漂移的测试 WAV 文件到 test-output/，
 * 可直接拖进浏览器应用做手动验证。
 * 用法：npm run gen:test
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { encodeWav } from '../src/dsp/wav.ts';
import { generateRecording, generateReference } from '../src/dsp/testgen.ts';

const here = dirname(fileURLToPath(import.meta.url));
const outDir = join(here, '..', 'test-output');
mkdirSync(outDir, { recursive: true });

const sr = 24000;
const durationSec = 120; // 2 分钟，手工验证足够快

const ref = generateReference({ sampleRate: sr, durationSec, seed: 11, noiseLevel: 0.015 });

const phones: Array<{ name: string; off: number; ppm: number; noise: number; trim?: number }> = [
  { name: 'phone1_ref', off: 0, ppm: 0, noise: 0.005 },
  { name: 'phone2_slow', off: 0.85, ppm: -120, noise: 0.02, trim: 3 },
  { name: 'phone3_fast', off: -1.4, ppm: 95, noise: 0.015 },
  { name: 'phone4_late', off: 2.3, ppm: 40, noise: 0.03 },
];

for (const [i, p] of phones.entries()) {
  const sig =
    i === 0
      ? ref
      : generateRecording(ref, sr, {
          sampleRate: sr,
          durationSec,
          seed: 200 + i,
          offsetSec: p.off,
          driftPpm: p.ppm,
          extraNoise: p.noise,
          trimTailSec: p.trim ?? 0,
        });
  const wav = encodeWav([sig], sr, 16);
  const file = join(outDir, `${p.name}_off${p.off}s_${p.ppm}ppm.wav`);
  writeFileSync(file, wav);
  console.log(`写出 ${file}（${sig.length} 采样, ${(sig.length / sr).toFixed(1)}s）`);
}

console.log('\n真值表（对齐页应对照这些数字）：');
for (const p of phones) {
  console.log(`  ${p.name}: 偏移 ${p.off}s, 漂移 ${p.ppm}ppm${p.trim ? `, 尾截 ${p.trim}s` : ''}`);
}
