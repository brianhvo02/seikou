import { describe, expect, it } from 'vitest';
import { AUDIO_CHANNELS_KEY, AudioChannelsSetting } from './audio-channels';

function storage(initial: Record<string, string> = {}): Storage {
  const m = new Map(Object.entries(initial));
  return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v) } as unknown as Storage;
}

describe('AudioChannelsSetting', () => {
  it('is auto by default and keeps a pick', () => {
    const s = storage();
    const setting = new AudioChannelsSetting({ storage: () => s, params: new URLSearchParams() });
    expect(setting.get()).toBe('auto');
    let calls = 0;
    setting.subscribe(() => calls++);
    setting.choose('stereo');
    expect(setting.get()).toBe('stereo');
    expect(s.getItem(AUDIO_CHANNELS_KEY)).toBe('stereo');
    expect(calls).toBe(1);
    expect(new AudioChannelsSetting({ storage: () => s, params: new URLSearchParams() }).outputChoice()).toBe('stereo');
  });

  it('lets the test flag stand in for the choice, and ignores other values', () => {
    expect(new AudioChannelsSetting({ storage: () => null, params: new URLSearchParams('audiochannels=6') }).outputChoice()).toBe(6);
    expect(new AudioChannelsSetting({ storage: () => null, params: new URLSearchParams('audiochannels=5') }).outputChoice()).toBe('auto');
  });

  it('survives a storage that throws', () => {
    const throwing = { getItem: () => { throw new Error('denied'); }, setItem: () => { throw new Error('denied'); } } as unknown as Storage;
    const setting = new AudioChannelsSetting({ storage: () => throwing, params: new URLSearchParams() });
    setting.choose('stereo');
    expect(setting.get()).toBe('stereo');
  });
});
