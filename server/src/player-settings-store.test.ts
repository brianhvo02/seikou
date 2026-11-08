// SPDX-License-Identifier: LGPL-3.0-or-later
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { isPlayerSettings, PlayerSettingsStore } from './player-settings-store';

let tmp: string;
beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'player-settings-'));
});
afterEach(() => rmSync(tmp, { recursive: true, force: true }));

describe('PlayerSettingsStore', () => {
  it('player settings default to countdown off and are per person', () => {
    const store = new PlayerSettingsStore(tmp);
    expect(store.get('mika')).toEqual({ nextEpisodeCountdown: false });
    store.put('mika', { nextEpisodeCountdown: true });
    expect(store.get('mika')).toEqual({ nextEpisodeCountdown: true });
    expect(store.get('sora')).toEqual({ nextEpisodeCountdown: false });
    expect(JSON.parse(readFileSync(join(tmp, 'users', 'mika', 'player-settings.json'), 'utf8'))).toEqual({ nextEpisodeCountdown: true });
    expect(() => store.get('../x')).toThrow();
  });

  it('ignores unknown fields and falls back to the default for a broken file', () => {
    const store = new PlayerSettingsStore(tmp);
    mkdirSync(join(tmp, 'users', 'mika'), { recursive: true });
    writeFileSync(join(tmp, 'users', 'mika', 'player-settings.json'), JSON.stringify({ nextEpisodeCountdown: true, later: 3 }));
    expect(store.get('mika')).toEqual({ nextEpisodeCountdown: true });
    writeFileSync(join(tmp, 'users', 'mika', 'player-settings.json'), '{not json');
    expect(store.get('mika')).toEqual({ nextEpisodeCountdown: false });
    writeFileSync(join(tmp, 'users', 'mika', 'player-settings.json'), JSON.stringify({ nextEpisodeCountdown: 'yes' }));
    expect(store.get('mika')).toEqual({ nextEpisodeCountdown: false });
  });

  it('isPlayerSettings takes exactly the known fields', () => {
    expect(isPlayerSettings({ nextEpisodeCountdown: false })).toBe(true);
    for (const bad of [null, [], {}, { nextEpisodeCountdown: 1 }, { nextEpisodeCountdown: true, other: 1 }, 'x']) expect(isPlayerSettings(bad)).toBe(false);
  });
});
