// SPDX-License-Identifier: LGPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import { VIDEO_OUTPUT_KEY, VideoOutputSetting, initialVideoPath } from './video-output';

function memory(): Storage {
  const map = new Map<string, string>();
  return { getItem: (k: string) => map.get(k) ?? null, setItem: (k: string, v: string) => void map.set(k, v) } as unknown as Storage;
}
const throwing = (): Storage => {
  const fail = (): never => {
    throw new Error('blocked');
  };
  return { getItem: fail, setItem: fail } as unknown as Storage;
};
const setting = (storage: Storage | null, query = ''): VideoOutputSetting => new VideoOutputSetting({ storage: () => storage, params: new URLSearchParams(query) });

describe('VideoOutputSetting', () => {
  it('is auto on a new device', () => {
    expect(setting(memory()).get()).toBe('auto');
  });

  it('saves a choice under bluray-web:video-output and reads it back in a new instance', () => {
    const storage = memory();
    const a = setting(storage);
    a.choose('canvas');
    expect(a.get()).toBe('canvas');
    expect(storage.getItem(VIDEO_OUTPUT_KEY)).toBe('canvas');
    expect(VIDEO_OUTPUT_KEY).toBe('bluray-web:video-output');
    expect(setting(storage).get()).toBe('canvas');
  });

  it('treats an unknown stored value as auto', () => {
    const storage = memory();
    storage.setItem(VIDEO_OUTPUT_KEY, 'webgl');
    expect(setting(storage).get()).toBe('auto');
  });

  it('works when storage is missing or throws', () => {
    for (const storage of [null, throwing()]) {
      const s = setting(storage);
      expect(s.get()).toBe('auto');
      s.choose('element');
      expect(s.get()).toBe('element');
    }
  });

  it('lets ?videopath= override the saved choice without saving it', () => {
    const storage = memory();
    storage.setItem(VIDEO_OUTPUT_KEY, 'canvas');
    const s = setting(storage, 'videopath=element');
    expect(s.get()).toBe('element');
    expect(storage.getItem(VIDEO_OUTPUT_KEY)).toBe('canvas');
    s.choose('auto'); // a pick in the menu is the viewer's own choice and takes over
    expect(s.get()).toBe('auto');
    expect(storage.getItem(VIDEO_OUTPUT_KEY)).toBe('auto');
  });

  it('ignores a flag that names no path, and tells subscribers about a choice', () => {
    const s = setting(memory(), 'videopath=webgl');
    expect(s.get()).toBe('auto');
    let calls = 0;
    const off = s.subscribe(() => calls++);
    s.choose('canvas');
    off();
    s.choose('element');
    expect(calls).toBe(1);
  });
});

describe('initialVideoPath', () => {
  it('is the setting: the flag, else the saved choice, else auto', () => {
    const storage = memory();
    expect(initialVideoPath(new VideoOutputSetting({ storage: () => storage, params: new URLSearchParams('') }))).toBe('auto');
    storage.setItem(VIDEO_OUTPUT_KEY, 'element');
    expect(initialVideoPath(new VideoOutputSetting({ storage: () => storage, params: new URLSearchParams('') }))).toBe('element');
  });
});
