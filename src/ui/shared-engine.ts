import { AudioEngine } from '../audio/engine.ts';

let singleton: AudioEngine | null = null;

/** 全局共享一个 AudioContext（浏览器对上下文数量有限制）。 */
export async function sharedEngine(): Promise<AudioEngine> {
  if (!singleton) singleton = await AudioEngine.create();
  return singleton;
}
