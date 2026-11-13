/**
 * 应用外壳：顶栏导航 + 页面路由 + 当前排练上下文。
 * 状态来自 ProjectStore（IndexedDB），store 变更后整体重渲染当前页。
 */
import type { PageId, Rehearsal } from '../model/types.ts';
import { store } from '../model/project.ts';
import { h, clear } from './dom.ts';
import { renderRehearsals } from './pages/rehearsals-page.ts';
import { renderMaterials } from './pages/materials-page.ts';
import { renderAlign } from './pages/align-page.ts';
import { renderMix } from './pages/mix-page.ts';
import { renderExport } from './pages/export-page.ts';

const PAGE_LABELS: Record<PageId, string> = {
  rehearsals: '排练',
  materials: '素材',
  align: '对齐',
  mix: '混音',
  export: '导出',
};

const ORDER: PageId[] = ['rehearsals', 'materials', 'align', 'mix', 'export'];

export interface AppContext {
  page: PageId;
  rehearsal: Rehearsal | null;
  go(page: PageId, rehearsalId?: string): void;
  refresh(): void;
}

class AppShell implements AppContext {
  page: PageId = 'rehearsals';
  rehearsal: Rehearsal | null = null;
  private root = document.getElementById('app')!;

  start(): void {
    store.subscribe(() => void this.onStoreChange());
    this.render();
  }

  private async onStoreChange(): Promise<void> {
    // 排练被删除或被外部（导入）改动时重新拉取
    if (this.rehearsal) {
      const fresh = await store.getRehearsal(this.rehearsal.id);
      this.rehearsal = fresh ?? null;
      if (!fresh && this.page !== 'rehearsals') this.page = 'rehearsals';
    }
    this.render();
  }

  async go(page: PageId, rehearsalId?: string): Promise<void> {
    if (rehearsalId) {
      this.rehearsal = (await store.getRehearsal(rehearsalId)) ?? this.rehearsal;
    }
    this.page = page;
    this.render();
  }

  async refresh(): Promise<void> {
    if (this.rehearsal) {
      this.rehearsal = (await store.getRehearsal(this.rehearsal.id)) ?? this.rehearsal;
    }
    this.render();
  }

  private render(): void {
    clear(this.root);
    const hasReh = !!this.rehearsal;
    const nav = h(
      'div',
      { class: 'nav' },
      ...ORDER.map((p) =>
        h(
          'button',
          {
            class: this.page === p ? 'active' : '',
            disabled: p !== 'rehearsals' && !hasReh,
            onclick: () => void this.go(p),
          },
          PAGE_LABELS[p],
        ),
      ),
    );

    const top = h(
      'div',
      { class: 'topbar' },
      h('div', { class: 'brand' }, '合唱团', h('span', { class: 'dot' }, '·'), '多轨对齐混音台'),
      nav,
      this.rehearsal ? h('div', { class: 'reh-badge', title: this.rehearsal.name }, this.rehearsal.name) : null,
    );

    const pageHost = h('div', { class: 'page' });
    this.root.append(top, pageHost);

    switch (this.page) {
      case 'rehearsals':
        renderRehearsals(pageHost, this);
        break;
      case 'materials':
        if (this.rehearsal) renderMaterials(pageHost, this, this.rehearsal);
        break;
      case 'align':
        if (this.rehearsal) renderAlign(pageHost, this, this.rehearsal);
        break;
      case 'mix':
        if (this.rehearsal) renderMix(pageHost, this, this.rehearsal);
        break;
      case 'export':
        if (this.rehearsal) renderExport(pageHost, this, this.rehearsal);
        break;
    }
  }
}

export const app: AppShell = new AppShell();
