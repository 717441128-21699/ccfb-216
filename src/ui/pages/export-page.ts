import type { Rehearsal } from '../../model/types.ts';
import { store } from '../../model/project.ts';
import { h, download } from '../dom.ts';
import { toast } from '../toast.ts';
import type { AppContext } from '../app.ts';
import { sharedEngine } from '../shared-engine.ts';
import { AudioEngine, type SchedTrack } from '../../audio/engine.ts';
import { encodeWav, type WavBitDepth } from '../../dsp/wav.ts';

export function renderExport(host: HTMLElement, app: AppContext, rehearsal: Rehearsal): void {
  host.replaceChildren();

  if (rehearsal.trackOrder.length === 0) {
    host.append(
      h('div', { class: 'page-head' }, h('h1', {}, '导出')),
      h('div', { class: 'empty' }, '还没有轨道可以导出。'),
    );
    return;
  }

  const bitSel = h('select', {}, h('option', { value: '16' }, '16-bit PCM'), h('option', { value: '24' }, '24-bit PCM'), h('option', { value: '32' }, '32-bit PCM')) as HTMLSelectElement;
  bitSel.value = '16';
  const srNote = h('span', { class: 'faint' }, '');
  const progress = h('div', { class: 'faint', style: 'font-size:13px;min-height:20px' });

  const setProgress = (msg: string) => {
    progress.textContent = msg;
  };

  host.append(
    h('div', { class: 'page-head' }, h('h1', {}, '导出')),

    h(
      'div',
      { class: 'card' },
      h('h2', {}, '混音导出'),
      h('div', { class: 'row' }, h('label', {}, '位深'), bitSel, srNote, h('div', { class: 'spacer' }),
        h(
          'button',
          { class: 'primary', onclick: () => void exportMix(rehearsal, bitSel, setProgress) },
          '导出立体声混音 WAV',
        ),
      ),
      h('div', { class: 'context-tip' }, '静音/独奏、音量、声像和剪辑都会生效；所有轨道已在同一时间轴上对齐。'),
    ),

    h(
      'div',
      { class: 'card' },
      h('h2', {}, '分轨导出'),
      h('p', { class: 'muted', style: 'margin:0 0 12px' }, '每条轨导出一个 WAV：保留该轨的音量与剪辑，对齐偏移通过前置/后置补零体现，分轨拖进任何 DAW 都是对齐的。'),
      h(
        'button',
        { onclick: () => void exportStems(rehearsal, bitSel, setProgress) },
        `导出全部 ${rehearsal.trackOrder.length} 条分轨（逐个下载）`,
      ),
    ),

    h(
      'div',
      { class: 'card' },
      h('h2', {}, '工程打包'),
      h('p', { class: 'muted', style: 'margin:0 0 12px' }, '把工程数据与全部原始录音打成一个 .camx 文件，别人在首页「导入工程文件」即可打开，继续对齐和混音。'),
      h(
        'button',
        {
          onclick: () => void exportProject(rehearsal, app),
        },
        '打包导出 .camx',
      ),
    ),
    progress,
  );

  void sharedEngine().then((engine) => {
    srNote.textContent = `输出采样率 ${engine.sampleRate} Hz（与播放引擎一致）`;
  });
}

async function loadSched(engine: AudioEngine, rehearsal: Rehearsal): Promise<SchedTrack[]> {
  const out: SchedTrack[] = [];
  for (const id of rehearsal.trackOrder) {
    const track = rehearsal.tracks[id];
    const cached = engine.getCached(track.materialId);
    const buffer = cached ?? (await store.loadAudioBuffer(rehearsal.id, track.materialId));
    if (!cached) engine.cacheBuffer(track.materialId, buffer);
    out.push({ track, buffer });
  }
  return out;
}

function audioBufferToChannels(buf: AudioBuffer): Float64Array[] {
  const chans: Float64Array[] = [];
  for (let c = 0; c < buf.numberOfChannels; c++) {
    const data = buf.getChannelData(c);
    chans.push(Float64Array.from(data));
  }
  return chans;
}

async function exportMix(
  rehearsal: Rehearsal,
  bitSel: HTMLSelectElement,
  setProgress: (s: string) => void,
): Promise<void> {
  try {
    await store.flush(rehearsal.id);
    const engine = await sharedEngine();
    setProgress('解码素材…');
    const tracks = await loadSched(engine, rehearsal);
    setProgress('离线渲染混音…');
    const rendered = await engine.render(tracks, { channels: 2 });
    const wav = encodeWav(audioBufferToChannels(rendered), rendered.sampleRate, Number(bitSel.value) as WavBitDepth);
    download(wav, `${safeName(rehearsal.name)}_mix.wav`, 'audio/wav');
    setProgress(`混音已导出（${rendered.length} 采样 · ${rendered.sampleRate} Hz）`);
    toast('混音导出成功', 'success');
  } catch (e) {
    setProgress('');
    toast(`导出失败：${(e as Error).message}`, 'error', 6000);
  }
}

async function exportStems(
  rehearsal: Rehearsal,
  bitSel: HTMLSelectElement,
  setProgress: (s: string) => void,
): Promise<void> {
  try {
    await store.flush(rehearsal.id);
    const engine = await sharedEngine();
    const tracks = await loadSched(engine, rehearsal);
    // 分轨统一渲染同一区间，保证彼此严格对齐
    const bounds = tracks.map((x) => {
      const off = AudioEngine.effectiveOffset(x.track);
      const rate = 1 + x.track.driftPpm / 1e6;
      return [off, off + x.buffer.duration * rate] as [number, number];
    });
    const startSec = Math.min(0, ...bounds.map((b) => b[0]));
    const endSec = Math.max(...bounds.map((b) => b[1]));

    for (let i = 0; i < tracks.length; i++) {
      const st = tracks[i];
      setProgress(`渲染分轨 ${i + 1}/${tracks.length}：${st.track.name}`);
      const rendered = await engine.render(tracks, {
        onlyTrackId: st.track.id,
        startSec,
        endSec,
        channels: st.buffer.numberOfChannels >= 2 ? 2 : 1,
      });
      const wav = encodeWav(audioBufferToChannels(rendered), rendered.sampleRate, Number(bitSel.value) as WavBitDepth);
      download(wav, `${safeName(rehearsal.name)}_${String(i + 1).padStart(2, '0')}_${safeName(st.track.name)}.wav`, 'audio/wav');
      // 给浏览器一点时间处理连续下载
      await new Promise((r) => setTimeout(r, 350));
    }
    setProgress('全部分轨已导出');
    toast('分轨导出完成', 'success');
  } catch (e) {
    setProgress('');
    toast(`分轨导出失败：${(e as Error).message}`, 'error', 6000);
  }
}

async function exportProject(rehearsal: Rehearsal, app: AppContext): Promise<void> {
  try {
    await store.flush(rehearsal.id);
    const bytes = await store.exportProjectFile(rehearsal.id);
    download(bytes, `${safeName(rehearsal.name)}.camx`, 'application/zip');
    toast('工程已打包导出', 'success');
    void app;
  } catch (e) {
    toast(`打包失败：${(e as Error).message}`, 'error');
  }
}

function safeName(name: string): string {
  return name.replace(/[\\/:*?"<>|]+/g, '_').trim() || 'project';
}
