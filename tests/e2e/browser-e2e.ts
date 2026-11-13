/**
 * 浏览器端到端测试（Playwright + Chromium）：
 * 建排练 → 上传 4 条带真值的测试 WAV → 建轨 → 一键自动对齐 →
 * 从 IndexedDB 读回对齐参数对照真值 → 混音操作 → 导出 WAV 并解码校验 →
 * 工程打包导出再导入 → 坏文件标红。
 *
 * 前置：dev server 已在 BASE 运行；测试音频已由 gen:test 生成。
 * 用法：node --experimental-strip-types --no-warnings tests/e2e/browser-e2e.ts
 */
import { chromium, type Browser, type Page } from 'playwright';
import { readdirSync, mkdirSync, readFileSync, existsSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { decodeWav } from '../../src/dsp/wav.ts';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..', '..');
const wavDir = join(root, 'test-output');
// 下载目录放到项目外，避免 Vite 文件监视器锁文件崩溃
const dlDir = join(tmpdir(), 'choir-e2e-downloads');
mkdirSync(dlDir, { recursive: true });

const BASE = process.env.E2E_BASE ?? 'http://localhost:5210';

// 生成脚本里的真值
const TRUTH = [
  { match: 'phone2', off: 0.85, ppm: -120 },
  { match: 'phone3', off: -1.4, ppm: 95 },
  { match: 'phone4', off: 2.3, ppm: 40 },
];

let pass = 0;
let fail = 0;
function check(name: string, cond: boolean, detail = ''): void {
  if (cond) {
    pass++;
    console.log(`  ✓ ${name}`);
  } else {
    fail++;
    console.log(`  ✗ ${name} ${detail}`);
  }
}

async function readRehearsalFromIdb(page: Page, name = 'E2E 测试合唱'): Promise<{
  name: string;
  tracks: Array<{ name: string; offsetSec: number; driftPpm: number; muted: boolean }>;
  materialCount: number;
}> {
  return page.evaluate(async (wantedName) => {
    const db: IDBDatabase = await new Promise((resolve, reject) => {
      const req = indexedDB.open('choir-align-mix');
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    const all: unknown[] = await new Promise((resolve, reject) => {
      const tx = db.transaction('kv', 'readonly');
      const r = tx.objectStore('kv').getAll();
      r.onsuccess = () => resolve(r.result);
      r.onerror = () => reject(r.error);
    });
    type RehShape = {
      name: string;
      tracks: Record<string, { name: string; offsetSec: number; driftPpm: number; muted: boolean }>;
      trackOrder: string[];
      materials: object;
    };
    const list = all as RehShape[];
    const reh = list.find((x) => x.name === wantedName) ?? list[list.length - 1];
    return {
      name: reh.name,
      materialCount: Object.keys(reh.materials).length,
      tracks: reh.trackOrder.map((id) => reh.tracks[id]),
    };
  }, name);
}

async function waitForToast(page: Page, text: string, timeoutMs = 60000): Promise<void> {
  await page.waitForFunction(
    (t) => [...document.querySelectorAll('.toast')].some((el) => el.textContent?.includes(t)),
    text,
    { timeout: timeoutMs },
  );
}

async function expectCount(locator: { count(): Promise<number> }, n: number, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if ((await locator.count()) >= n) return;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`等待元素数量 ${n} 超时`);
}

async function run(): Promise<void> {
  const browser: Browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  page.on('console', (m) => {
    if (m.type() === 'error') console.log('  [console.error]', m.text());
  });
  page.on('pageerror', (e) => console.log('  [pageerror]', e.message));

  console.log('\n[E2E-1] 启动并新建排练');
  await page.goto(BASE, { waitUntil: 'networkidle' });
  // 清空历史运行残留，保证测试隔离
  await page.evaluate(
    () =>
      new Promise<void>((resolve, reject) => {
        const req = indexedDB.deleteDatabase('choir-align-mix');
        req.onsuccess = () => resolve();
        req.onerror = () => reject(req.error);
        req.onblocked = () => resolve();
      }),
  );
  await page.reload({ waitUntil: 'networkidle' });
  page.on('dialog', (d) => {
    if (d.type() === 'prompt') d.accept('E2E 测试合唱');
    else d.accept().catch(() => undefined);
  });
  await page.getByRole('button', { name: '+ 新建排练' }).click();
  await page.waitForSelector('.dropzone');
  check('进入素材页（拖拽区出现）', (await page.locator('.dropzone').count()) === 1);

  console.log('\n[E2E-2] 上传 4 条测试 WAV');
  const wavs = readdirSync(wavDir).filter((f) => f.endsWith('.wav')).map((f) => join(wavDir, f));
  check('找到 4 条测试音频', wavs.length === 4, `got=${wavs.length}`);
  const fileInput = page.locator('input[type=file]').first();
  await fileInput.setInputFiles(wavs);
  await waitForToast(page, '已解码 4 个素材', 90000);
  const rows = page.locator('tbody tr');
  check('素材列表出现 4 行', (await rows.count()) === 4);
  check('没有损坏标记', (await page.locator('tr.error').count()) === 0);

  console.log('\n[E2E-3] 全部添加为轨道');
  const builtPills = page.locator('tbody tr .pill', { hasText: '已建轨' });
  for (let i = 0; i < 4; i++) {
    await page.getByRole('button', { name: '添加到轨道' }).first().click();
    await expectCount(builtPills, i + 1, 15000);
  }
  check('4 条素材都已建轨', (await builtPills.count()) === 4);

  console.log('\n[E2E-4] 一键自动对齐并对照真值');
  await page.getByRole('button', { name: '对齐' }).click();
  await page.waitForSelector('.track-lane');
  await page.getByRole('button', { name: '一键自动对齐' }).click();
  await waitForToast(page, '已自动对齐 3 条轨道', 120000);
  await page.waitForTimeout(500);

  const data = await readRehearsalFromIdb(page);
  check('IDB 中素材数为 4', data.materialCount === 4);
  check('IDB 中轨道数为 4', data.tracks.length === 4);
  for (const t of TRUTH) {
    const trk = data.tracks.find((x) => x.name.includes(t.match));
    if (!trk) {
      check(`找到轨道 ${t.match}`, false);
      continue;
    }
    const offMs = Math.abs((trk.offsetSec - t.off) * 1000);
    const ppmErr = Math.abs(trk.driftPpm - t.ppm);
    check(`${t.match} 偏移误差 < 5ms（真值 ${t.off}s）`, offMs < 5, `got=${(trk.offsetSec * 1000).toFixed(2)}ms err=${offMs.toFixed(2)}ms`);
    check(`${t.match} 漂移误差 < 8ppm（真值 ${t.ppm}ppm）`, ppmErr < 8, `got=${trk.driftPpm.toFixed(2)}ppm err=${ppmErr.toFixed(2)}ppm`);
    console.log(`      ${trk.name}: offset=${(trk.offsetSec * 1000).toFixed(2)}ms ppm=${trk.driftPpm.toFixed(2)}`);
  }
  // 对齐结果面板渲染检查
  check('对齐结果统计面板可见', (await page.locator('.align-result .stat').count()) >= 4);

  console.log('\n[E2E-5] 混音操作（静音 + 音量）');
  await page.getByRole('button', { name: '混音' }).click();
  await page.waitForSelector('.channel-strip');
  await page.locator('.channel-strip').first().getByRole('button', { name: '静音' }).click();
  await page.waitForTimeout(300);
  const mutedAfter = await readRehearsalFromIdb(page);
  check('静音状态已持久化', mutedAfter.tracks[0].muted === true);
  // 时间轴渲染了波形
  check('混音页时间轴轨道数 = 4', (await page.locator('.track-lane').count()) === 4);

  console.log('\n[E2E-6] 导出立体声混音 WAV');
  await page.getByRole('button', { name: '导出' }).click();
  await page.waitForSelector('.card');
  const [mixDl] = await Promise.all([
    page.waitForEvent('download', { timeout: 120000 }),
    page.getByRole('button', { name: '导出立体声混音 WAV' }).click(),
  ]);
  const mixPath = join(dlDir, 'mix.wav');
  await mixDl.saveAs(mixPath);
  const mixBytes = new Uint8Array(readFileSync(mixPath));
  const mixDecoded = decodeWav(mixBytes);
  check('混音 WAV 可解码且为立体声', mixDecoded.channels.length === 2, `ch=${mixDecoded.channels.length}`);
  check('混音时长 > 100s', mixDecoded.channels[0].length / mixDecoded.sampleRate > 100,
    `dur=${(mixDecoded.channels[0].length / mixDecoded.sampleRate).toFixed(1)}s`);
  check('混音含真实音频能量（非全零）', mixDecoded.channels[0].some((v) => Math.abs(v) > 0.01));

  console.log('\n[E2E-7] 工程打包导出 + 重新导入');
  const [camxDl] = await Promise.all([
    page.waitForEvent('download', { timeout: 60000 }),
    page.getByRole('button', { name: '打包导出 .camx' }).click(),
  ]);
  const camxPath = join(dlDir, 'project.camx');
  await camxDl.saveAs(camxPath);
  check('.camx 文件已下载且非空', existsSync(camxPath) && readFileSync(camxPath).length > 1000);

  await page.getByRole('button', { name: '排练' }).click();
  await page.waitForSelector('.reh-card');
  const beforeCount = await page.locator('.reh-card').count();
  const importInput = page.locator('input[type=file]').last();
  await importInput.setInputFiles(camxPath);
  await waitForToast(page, '已导入工程', 60000);
  await page.waitForTimeout(800);
  const idbNames = await page.evaluate(async () => {
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const req = indexedDB.open('choir-align-mix');
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    const keys = await new Promise<IDBValidKey[]>((resolve, reject) => {
      const r = db.transaction('kv', 'readonly').objectStore('kv').getAllKeys();
      r.onsuccess = () => resolve(r.result);
      r.onerror = () => reject(r.error);
    });
    return keys.map(String);
  });
  console.log('  导入后 IDB keys:', JSON.stringify(idbNames));
  // 导入成功后应用会自动打开新工程，回到排练列表页再核对卡片数
  await page.getByRole('button', { name: '排练' }).click();
  await page.waitForSelector('.reh-card');
  const afterCount = await page.locator('.reh-card').count();
  check('导入后排练卡片 +1', afterCount === beforeCount + 1, `${beforeCount} -> ${afterCount}, idb=${idbNames.length}`);
  // 打开导入的工程核对内容
  await page.locator('.reh-card').first().click();
  await page.waitForSelector('.dropzone');
  const imported = await readRehearsalFromIdb(page);
  check('导入工程保留 4 条轨道', imported.tracks.length === 4, `got=${imported.tracks.length}`);
  const importedPhone2 = imported.tracks.find((x) => x.name.includes('phone2'));
  check('导入工程保留对齐参数', !!importedPhone2 && Math.abs(importedPhone2.driftPpm - (-120)) < 8);

  console.log('\n[E2E-8] 坏文件提示');
  await page.getByRole('button', { name: '排练' }).click();
  await page.getByRole('button', { name: '+ 新建排练' }).click();
  await page.waitForSelector('.dropzone');
  const badPath = join(dlDir, 'broken.wav');
  writeFileSync(badPath, Buffer.from('this is definitely not a valid audio file content'));
  await page.locator('input[type=file]').first().setInputFiles(badPath);
  await page.waitForSelector('tr.error', { timeout: 30000 });
  const errRowText = await page.locator('tr.error').innerText();
  check('坏文件在列表中标红', (await page.locator('tr.error .pill.bad').count()) === 1);
  check('坏文件行包含损坏标记与说明', errRowText.includes('损坏') && errRowText.length > 10);

  await browser.close();
}

run()
  .then(() => {
    console.log(`\n========================================`);
    console.log(`E2E 通过 ${pass} 项，失败 ${fail} 项`);
    process.exit(fail === 0 ? 0 : 1);
  })
  .catch((e) => {
    console.error('E2E 脚本异常：', e);
    process.exit(1);
  });
