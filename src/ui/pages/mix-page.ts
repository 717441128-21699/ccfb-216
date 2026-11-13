import type { Rehearsal, Track } from '../../model/types.ts';
import { store } from '../../model/project.ts';
import { h } from '../dom.ts';
import { toast } from '../toast.ts';
import type { AppContext } from '../app.ts';
import { Timeline } from '../components/timeline.ts';
import { PlaybackBar } from '../components/playback-bar.ts';
import { sharedEngine } from '../shared-engine.ts';
import type { EngineMeter } from '../../audio/engine.ts';

const TRACK_COLORS = ['#5b8def', '#46b36e', '#b07cd9', '#e0a44c', '#d97070', '#56b8c9', '#c9a356', '#8f8fd9'];

export function renderMix(host: HTMLElement, app: AppContext, rehearsal: Rehearsal): void {
  host.replaceChildren();

  if (rehearsal.trackOrder.length === 0) {
    host.append(
      h('div', { class: 'page-head' }, h('h1', {}, '混音')),
      h('div', { class: 'empty' }, '还没有轨道。先到「素材」页添加录音并在「对齐」页完成对齐。'),
    );
    return;
  }

  const head = h('div', { class: 'page-head' }, h('h1', {}, '混音与剪辑'));
  const tip = h(
    'div',
    { class: 'context-tip' },
    '剪辑只剪掉工程时间轴上的片段，不会改动各轨的对齐关系：在下方时间轴双击波形可剪掉该点前后各 1s，双击红色区域恢复。电平表在播放时实时显示。',
  );

  const mixerHost = h('div', { class: 'mixer' });
  const timelineHost = h('div');
  const barHost = h('div');
  host.append(head, tip, mixerHost, h('div', { style: 'height:14px' }), barHost, timelineHost);

  let timeline: Timeline | null = null;

  const buildMixer = () => {
    const reh = app.rehearsal ?? rehearsal;
    mixerHost.replaceChildren(
      ...reh.trackOrder.map((id, i) => channelStrip(reh, reh.tracks[id], i, app)),
    );
  };

  const buildTimeline = () => {
    timeline?.destroy();
    const reh = app.rehearsal ?? rehearsal;
    timeline = new Timeline({ rehearsal: reh, draggable: false, editableClips: true });
    timelineHost.replaceChildren(timeline.host);
    void sharedEngine().then((engine) => {
      const bar = new PlaybackBar(engine, reh, timeline!);
      barHost.replaceChildren(bar.host);
    });
  };

  buildMixer();
  buildTimeline();

  const unsub = store.subscribe(() => {
    const fresh = app.rehearsal;
    if (fresh && fresh.id === rehearsal.id) {
      buildMixer();
      timeline?.setOptions({ rehearsal: fresh });
      timeline?.redraw();
    }
  });

  const observer = new MutationObserver(() => {
    if (!document.body.contains(host)) {
      unsub();
      timeline?.destroy();
      observer.disconnect();
    }
  });
  observer.observe(document.body, { childList: true, subtree: true });
}

function channelStrip(reh: Rehearsal, track: Track, index: number, app: AppContext): HTMLElement {
  const isRef = reh.referenceTrackId === track.id;
  const color = TRACK_COLORS[index % TRACK_COLORS.length];
  const meterFill = h('div', { class: 'fill', style: 'height:0%' });
  const meter = h('div', { class: 'meter' }, meterFill);

  const updateMeter = (m: EngineMeter) => {
    const db = m.peak > 0 ? 20 * Math.log10(m.peak) : -60;
    const pct = Math.max(0, Math.min(100, ((db + 60) / 60) * 100));
    meterFill.style.height = `${pct}%`;
  };
  void sharedEngine().then((engine) => engine.onTrackMeter(track.id, updateMeter));

  const patch = (p: Partial<Track>) => store.updateTrack(reh.id, track.id, p);

  const volLabel = h('span', { class: 'faint', style: 'font-size:11px;min-width:38px;text-align:right' }, `${track.volume.toFixed(2)}`);
  const panLabel = h('span', { class: 'faint', style: 'font-size:11px;min-width:38px;text-align:right' }, track.pan === 0 ? 'C' : track.pan < 0 ? `L${Math.round(-track.pan * 100)}` : `R${Math.round(track.pan * 100)}`);

  return h(
    'div',
    { class: `channel-strip ${isRef ? 'ref' : ''}`, style: `border-top:3px solid ${color}` },
    h('div', { class: 'ch-name', title: track.name }, track.name + (isRef ? ' ★' : '')),
    meter,
    h(
      'div',
      { class: 'knob-row' },
      h('label', {}, '音量'),
      h('input', {
        type: 'range',
        min: '0',
        max: '2',
        step: '0.01',
        value: String(track.volume),
        oninput: (e: Event) => {
          const v = Number((e.target as HTMLInputElement).value);
          volLabel.textContent = v.toFixed(2);
          void patch({ volume: v });
        },
      }),
      volLabel,
    ),
    h(
      'div',
      { class: 'knob-row' },
      h('label', {}, '声像'),
      h('input', {
        type: 'range',
        min: '-1',
        max: '1',
        step: '0.02',
        value: String(track.pan),
        oninput: (e: Event) => {
          const v = Number((e.target as HTMLInputElement).value);
          panLabel.textContent = v === 0 ? 'C' : v < 0 ? `L${Math.round(-v * 100)}` : `R${Math.round(v * 100)}`;
          void patch({ pan: v });
        },
      }),
      panLabel,
    ),
    h(
      'div',
      { class: 'btn-row' },
      h(
        'button',
        {
          class: track.muted ? 'mute-on' : '',
          onclick: () => {
            void patch({ muted: !track.muted });
            if (track.muted) toast(`已取消静音：${track.name}`, 'info', 1400);
          },
        },
        '静音',
      ),
      h(
        'button',
        {
          class: track.solo ? 'solo-on' : '',
          onclick: () => void patch({ solo: !track.solo }),
        },
        '独奏',
      ),
    ),
    h(
      'button',
      {
        class: 'ghost danger',
        style: 'width:100%;padding:4px',
        onclick: () => {
          if (confirm(`删除轨道「${track.name}」？素材文件保留。`)) {
            void store.removeTrack(reh.id, track.id).then(() => app.refresh());
          }
        },
      },
      '删轨',
    ),
  );
}

