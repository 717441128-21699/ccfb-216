import type { Rehearsal } from '../../model/types.ts';
import { store } from '../../model/project.ts';
import { download, h } from '../dom.ts';
import { toast } from '../toast.ts';
import type { AppContext } from '../app.ts';
import { formatBytes } from '../../util/format.ts';

export function renderRehearsals(host: HTMLElement, app: AppContext): void {
  host.replaceChildren();
  const head = h(
    'div',
    { class: 'page-head' },
    h('h1', {}, '排练列表'),
    h(
      'button',
      { class: 'primary', onclick: () => void createRehearsal(app) },
      '+ 新建排练',
    ),
    h('button', { onclick: () => importFile.click() }, '导入工程文件'),
  );

  const importFile = h('input', {
    type: 'file',
    accept: '.camx,.zip,application/zip',
    style: 'display:none',
    onchange: () => void doImport(app, importFile),
  });

  const listHost = h('div', { class: 'grid-list' });
  host.append(head, importFile, listHost);

  void store.listRehearsals().then((items) => {
    if (items.length === 0) {
      listHost.replaceChildren(
        h('div', { class: 'empty', style: 'grid-column:1/-1' }, '还没有排练。新建一个，然后把各手机录的素材拖进来。'),
      );
      return;
    }
    listHost.replaceChildren(...items.map((r) => card(r, app)));
  });
}

function card(r: Rehearsal, app: AppContext): HTMLElement {
  const matCount = Object.keys(r.materials).length;
  const trkCount = r.trackOrder.length;
  const totalBytes = Object.values(r.materials).reduce((s, m) => s + m.size, 0);

  return h(
    'div',
    { class: 'reh-card', onclick: () => void app.go('materials', r.id) },
    h('div', { class: 'title' }, r.name),
    h('div', { class: 'meta' }, `${matCount} 个素材 · ${trkCount} 条轨道 · ${formatBytes(totalBytes)}`),
    h('div', { class: 'meta' }, `更新于 ${new Date(r.updatedAt).toLocaleString()}`),
    h(
      'div',
      { class: 'actions' },
      h(
        'button',
        {
          onclick: (e: Event) => {
            e.stopPropagation();
            void rename(r, app);
          },
        },
        '改名',
      ),
      h(
        'button',
        {
          onclick: (e: Event) => {
            e.stopPropagation();
            void exportOne(r);
          },
        },
        '打包导出',
      ),
      h(
        'button',
        {
          class: 'danger',
          onclick: (e: Event) => {
            e.stopPropagation();
            void remove(r, app);
          },
        },
        '删除',
      ),
    ),
  );
}

async function createRehearsal(app: AppContext): Promise<void> {
  const name = prompt('排练名称：', `排练 ${new Date().toLocaleDateString()}`);
  if (name === null) return;
  const r = await store.createRehearsal(name);
  toast('已新建排练', 'success');
  await app.go('materials', r.id);
}

async function rename(r: Rehearsal, app: AppContext): Promise<void> {
  const name = prompt('新名称：', r.name);
  if (name === null) return;
  await store.renameRehearsal(r.id, name);
  toast('已改名', 'success');
  void app.refresh();
}

async function remove(r: Rehearsal, app: AppContext): Promise<void> {
  if (!confirm(`确认删除「${r.name}」？该排练的全部素材与工程数据都会删除，不可恢复。`)) return;
  await store.deleteRehearsal(r.id);
  toast('已删除', 'success');
  if (app.rehearsal?.id === r.id) await app.go('rehearsals');
  void app.refresh();
}

async function exportOne(r: Rehearsal): Promise<void> {
  try {
    await store.flush(r.id);
    const bytes = await store.exportProjectFile(r.id);
    download(bytes, `${safeName(r.name)}.camx`, 'application/zip');
    toast('工程已打包导出（.camx）', 'success');
  } catch (e) {
    toast(`导出失败：${(e as Error).message}`, 'error');
  }
}

async function doImport(app: AppContext, input: HTMLInputElement): Promise<void> {
  const file = input.files?.[0];
  input.value = '';
  if (!file) return;
  try {
    const bytes = new Uint8Array(await file.arrayBuffer());
    const r = await store.importProjectFile(bytes);
    toast(`已导入工程「${r.name}」`, 'success');
    await app.go('materials', r.id);
  } catch (e) {
    toast(`导入失败：${(e as Error).message}`, 'error');
  }
}

function safeName(name: string): string {
  return name.replace(/[\\/:*?"<>|]+/g, '_');
}
