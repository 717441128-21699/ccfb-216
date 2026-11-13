import type { Rehearsal } from '../../model/types.ts';
import { store } from '../../model/project.ts';
import { h } from '../dom.ts';
import { toast } from '../toast.ts';
import type { AppContext } from '../app.ts';
import { Timeline } from '../components/timeline.ts';
import { alignmentService } from '../../audio/alignment-service.ts';
import { PlaybackBar } from '../components/playback-bar.ts';
import { sharedEngine } from '../shared-engine.ts';

export function renderAlign(host: HTMLElement, app: AppContext, rehearsal: Rehearsal): void {
  host.replaceChildren();

  if (rehearsal.trackOrder.length < 2) {
    host.append(
      h('div', { class: 'page-head' }, h('h1', {}, '对齐')),
      h('div', { class: 'empty' }, '至少需要两条轨道。先到「素材」页把各手机录音添加为轨道。'),
    );
    return;
  }

  let timeline: Timeline | null = null;
  let selectedId: string | null = rehearsal.referenceTrackId;

  const resultHost = h('div');
  const busy = h('span', { id: 'align-busy' });

  const head = h(
    'div',
    { class: 'page-head' },
    h('h1', {}, '对齐'),
    h(
      'button',
      {
        class: 'primary',
        onclick: () => void alignAll(rehearsal, app, () => timeline, (b) => (busy.innerHTML = b ? '<span class="spin"></span> 对齐中…' : '')),
      },
      '一键自动对齐',
    ),
    h(
      'button',
      { onclick: () => void alignSelected(rehearsal, app, () => timeline, () => selectedId, (b) => (busy.innerHTML = b ? '<span class="spin"></span> 对齐中…' : '')) },
      '仅对齐选中轨',
    ),
    busy,
  );

  const tip = h(
    'div',
    { class: 'context-tip' },
    '自动对齐用头/尾双窗口互相关估计时钟漂移并做重采样补偿；手动微调：直接左右拖动波形（10ms 吸附，Shift=1ms，Ctrl=自由）。★ 为参考轨，定义工程时间轴。',
  );

  const timelineHost = h('div');
  const barHost = h('div');
  host.append(head, tip, resultHost, barHost, timelineHost);

  const buildTimeline = () => {
    timeline?.destroy();
    const reh = app.rehearsal ?? rehearsal;
    timeline = new Timeline({
      rehearsal: reh,
      draggable: true,
      editableClips: false,
      selectedId,
      onSelect: (id) => {
        selectedId = id;
        renderResult(resultHost, reh, id, app);
        timeline?.setOptions({ selectedId: id });
      },
    });
    timelineHost.replaceChildren(timeline.host);
    renderResult(resultHost, reh, selectedId ?? reh.referenceTrackId ?? '', app);
    void sharedEngine().then((engine) => {
      const bar = new PlaybackBar(engine, reh, timeline!);
      barHost.replaceChildren(bar.host);
    });
  };
  buildTimeline();

  // store 变更后整体重建（对齐结果回写、参考轨切换等）
  const unsub = store.subscribe(() => {
    const fresh = app.rehearsal;
    if (fresh && fresh.id === rehearsal.id) {
      buildTimeline();
    }
  });
  // 页面销毁时（简单处理：host 被替换）取消订阅
  const observer = new MutationObserver(() => {
    if (!document.body.contains(host)) {
      unsub();
      timeline?.destroy();
      observer.disconnect();
    }
  });
  observer.observe(document.body, { childList: true, subtree: true });
}

function renderResult(host: HTMLElement, reh: Rehearsal, trackId: string, app: AppContext): void {
  const track = reh.tracks[trackId];
  if (!track) {
    host.replaceChildren();
    return;
  }
  const isRef = reh.referenceTrackId === trackId;
  const info = track.alignInfo;

  const stat = (k: string, v: string, cls = '') =>
    h('div', { class: `stat ${cls}` }, h('div', { class: 'k' }, k), h('div', { class: 'v' }, v));

  host.replaceChildren(
    h(
      'div',
      { class: 'card' },
      h('div', { class: 'row' }, h('strong', {}, track.name), isRef ? h('span', { class: 'pill good' }, '参考轨') : null, h('div', { class: 'spacer' }),
        isRef
          ? null
          : h(
              'button',
              {
                onclick: () => void makeRef(reh.id, trackId, app),
              },
              '设为参考轨',
            ),
        h(
          'button',
          {
            class: 'ghost',
            onclick: () => {
              void store.updateTrack(reh.id, trackId, { nudgeSec: 0 });
              toast('已清零手动微调', 'info', 1600);
            },
            disabled: isRef,
          },
          '清零微调',
        ),
      ),
      h(
        'div',
        { class: 'align-result' },
        stat('总偏移（含微调）', `${((track.offsetSec + track.nudgeSec) * 1000).toFixed(2)} ms`),
        stat('自动偏移', `${(track.offsetSec * 1000).toFixed(2)} ms`),
        stat('手动微调', `${(track.nudgeSec * 1000).toFixed(2)} ms`),
        stat('时钟漂移', `${track.driftPpm.toFixed(2)} ppm`),
        info ? stat('头窗延迟', `${info.headLagMs.toFixed(2)} ms`) : h('div'),
        info ? stat('尾窗延迟', `${info.tailLagMs.toFixed(2)} ms`) : h('div'),
        info
          ? stat('补偿残差', `${info.residualMs.toFixed(3)} ms`, Math.abs(info.residualMs) <= 1 ? 'good' : 'bad')
          : h('div'),
        info ? stat('置信度', `${(info.confidence * 100).toFixed(0)} %`) : h('div'),
      ),
      !info && !isRef ? h('div', { class: 'context-tip' }, '该轨尚未自动对齐，可先点「一键自动对齐」，或直接在时间轴上拖动。') : null,
    ),
  );
}

async function makeRef(rehearsalId: string, trackId: string, app: AppContext): Promise<void> {
  await store.setReference(rehearsalId, trackId);
  toast('已切换参考轨（其偏移/漂移已归零，其余轨请重新对齐）', 'success', 3600);
  await app.refresh();
}

async function alignAll(
  reh: Rehearsal,
  app: AppContext,
  getTimeline: () => Timeline | null,
  setBusy: (b: boolean) => void,
): Promise<void> {
  const targets = reh.trackOrder.filter((id) => id !== reh.referenceTrackId).map((id) => reh.tracks[id]);
  setBusy(true);
  let ok = 0;
  for (const t of targets) {
    try {
      await alignmentService.alignTrack(reh, t);
      ok++;
    } catch (e) {
      toast(`「${t.name}」对齐失败：${(e as Error).message}`, 'error', 6000);
    }
  }
  setBusy(false);
  getTimeline()?.fitContent();
  toast(ok ? `已自动对齐 ${ok} 条轨道` : '没有轨道对齐成功', ok ? 'success' : 'error');
  await app.refresh();
}

async function alignSelected(
  reh: Rehearsal,
  app: AppContext,
  getTimeline: () => Timeline | null,
  getSelected: () => string | null,
  setBusy: (b: boolean) => void,
): Promise<void> {
  const id = getSelected();
  const t = id ? reh.tracks[id] : undefined;
  if (!t) {
    toast('请先在时间轴上选择一条轨道', 'error');
    return;
  }
  if (id === reh.referenceTrackId) {
    toast('参考轨不需要对齐', 'info');
    return;
  }
  setBusy(true);
  try {
    const est = await alignmentService.alignTrack(reh, t);
    getTimeline()?.fitContent();
    toast(`对齐完成：偏移 ${(est.constantLag / reh.materials[t.materialId].sampleRate * 1000).toFixed(2)} ms，漂移 ${est.ppm.toFixed(2)} ppm，残差 ${est.residualMs.toFixed(3)} ms`, 'success', 5200);
  } catch (e) {
    toast(`对齐失败：${(e as Error).message}`, 'error');
  } finally {
    setBusy(false);
  }
  await app.refresh();
}

