import type { MaterialMeta, Rehearsal } from '../../model/types.ts';
import { store } from '../../model/project.ts';
import { h } from '../dom.ts';
import { toast } from '../toast.ts';
import type { AppContext } from '../app.ts';
import { drawWaveform } from '../waveform.ts';
import { formatBytes, formatSec } from '../../util/format.ts';

export function renderMaterials(host: HTMLElement, app: AppContext, rehearsal: Rehearsal): void {
  host.replaceChildren();
  const fileInput = h('input', {
    type: 'file',
    accept: 'audio/*,.wav,.m4a,.mp3,.aac,.ogg,.flac,.webm',
    multiple: true,
    style: 'display:none',
    onchange: () => {
      const fs = [...(fileInput.files ?? [])];
      fileInput.value = '';
      void ingest(rehearsal.id, fs, app);
    },
  });

  const drop = h(
    'div',
    { class: 'dropzone' },
    h('div', { class: 'big' }, '把手机录音拖到这里（可多选）'),
    h('div', {}, '支持 WAV / M4A / MP3 / AAC / OGG / FLAC，浏览器自动解码；坏文件会单独标红提示'),
    h('div', { style: 'margin-top:14px' }, h('button', { class: 'primary', onclick: () => fileInput.click() }, '选择文件')),
  );

  ['dragenter', 'dragover'].forEach((ev) =>
    drop.addEventListener(ev, (e: Event) => {
      e.preventDefault();
      drop.classList.add('dragover');
    }),
  );
  ['dragleave', 'drop'].forEach((ev) =>
    drop.addEventListener(ev, (e: Event) => {
      e.preventDefault();
      drop.classList.remove('dragover');
    }),
  );
  drop.addEventListener('drop', (e: DragEvent) => {
    e.preventDefault();
    const fs = [...(e.dataTransfer?.files ?? [])].filter((f) => f.type.startsWith('audio') || /\.(wav|m4a|mp3|aac|ogg|flac|webm)$/i.test(f.name));
    if (fs.length === 0) {
      toast('没有识别到音频文件', 'error');
      return;
    }
    void ingest(rehearsal.id, fs, app);
  });

  const tableHost = h('div');
  host.append(
    h('div', { class: 'page-head' }, h('h1', {}, `素材 · ${rehearsal.name}`)),
    drop,
    fileInput,
    h('div', { style: 'height:16px' }),
    tableHost,
  );
  renderTable(tableHost, app, rehearsal);
}

function renderTable(host: HTMLElement, app: AppContext, rehearsal: Rehearsal): void {
  const mats = Object.values(rehearsal.materials).sort((a, b) => a.addedAt - b.addedAt);
  if (mats.length === 0) {
    host.replaceChildren(h('div', { class: 'empty' }, '还没有素材，先拖入录音文件。'));
    return;
  }

  const rows = mats.map((m) => {
    const used = Object.values(rehearsal.tracks).some((t) => t.materialId === m.id);
    const waveCanvas = h('canvas', { style: 'width:180px;height:44px;background:#101318;border-radius:4px' }) as HTMLCanvasElement;
    if (!m.error && m.peaksBuckets > 0) {
      requestAnimationFrame(() =>
        drawWaveform(waveCanvas, m, { x: 0, width: waveCanvas.clientWidth, color: '#5b8def' }),
      );
    }

    return h(
      'tr',
      m.error ? { class: 'error' } : {},
      h('td', {}, waveCanvas),
      h(
        'td',
        {},
        h('div', { style: 'font-weight:600;word-break:break-all' }, m.name),
        h('div', { class: 'faint', style: 'font-size:12px' }, formatBytes(m.size)),
      ),
      h(
        'td',
        {},
        m.error
          ? h('span', { class: 'pill bad' }, '损坏')
          : h('span', { class: 'pill good' }, `${m.nominalSampleRate ?? m.sampleRate} Hz · ${m.channels}ch`),
      ),
      h(
        'td',
        {},
        m.error
          ? '—'
          : m.nominalSampleRate && m.nominalSampleRate !== m.sampleRate
            ? h('span', { class: 'pill warn', title: `浏览器已统一解码到 ${m.sampleRate} Hz，对齐按真实时间轴计算` }, `重采样 ${m.nominalSampleRate}→${m.sampleRate}`)
            : h('span', { class: 'faint', style: 'font-size:12px' }, '采样率一致'),
      ),
      h('td', {}, m.error ? '—' : formatSec(m.duration)),
      h(
        'td',
        {},
        m.error
          ? h('span', { style: 'font-size:12px' }, m.error)
          : used
            ? h('span', { class: 'pill' }, '已建轨')
            : h(
                'button',
                {
                  onclick: () => void createTrack(rehearsal.id, m, app),
                },
                '添加到轨道',
              ),
      ),
      h(
        'td',
        {},
        h(
          'button',
          {
            class: 'danger ghost',
            onclick: () => void remove(rehearsal.id, m, app),
          },
          '删除',
        ),
      ),
    );
  });

  host.replaceChildren(
    h(
      'div',
      { class: 'card', style: 'padding:6px 10px' },
      h(
        'table',
        {},
        h(
          'thead',
          {},
          h('tr', {}, h('th', {}, '波形'), h('th', {}, '文件名'), h('th', {}, '规格'), h('th', {}, '采样率'), h('th', {}, '时长'), h('th', {}, '状态/操作'), h('th', {}, '')),
        ),
        h('tbody', {}, ...rows),
      ),
    ),
  );
}

async function ingest(rehearsalId: string, files: File[], app: AppContext): Promise<void> {
  let ok = 0;
  let bad = 0;
  for (const f of files) {
    const meta = await store.addMaterial(rehearsalId, f);
    if (meta.error) bad++;
    else ok++;
  }
  if (ok) toast(`已解码 ${ok} 个素材`, 'success');
  if (bad) toast(`${bad} 个文件无法解码，已在列表中标红`, 'error', 7000);
  await app.refresh();
}

async function createTrack(rehearsalId: string, m: MaterialMeta, app: AppContext): Promise<void> {
  await store.createTrack(rehearsalId, m.id);
  toast(`已添加轨道：${m.name}`, 'success');
  await app.refresh();
}

async function remove(rehearsalId: string, m: MaterialMeta, app: AppContext): Promise<void> {
  if (!confirm(`删除素材「${m.name}」？使用它的轨道会一并删除。`)) return;
  await store.removeMaterial(rehearsalId, m.id);
  toast('已删除', 'success');
  await app.refresh();
}
