// SPDX-License-Identifier: LGPL-3.0-or-later
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { isPlayerSettingsBody, PlayerSettingsStore } from './player-settings-store';

let tmp: string;
beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'player-settings-'));
});
afterEach(() => rmSync(tmp, { recursive: true, force: true }));

describe('PlayerSettingsStore', () => {
  it('player settings default to countdown off and are per person', () => {
    const store = new PlayerSettingsStore(tmp);
    expect(store.get('mika')).toEqual({ nextEpisodeCountdown: false, discPreferences: null });
    store.put('mika', { nextEpisodeCountdown: true });
    expect(store.get('mika')).toEqual({ nextEpisodeCountdown: true, discPreferences: null });
    expect(store.get('sora')).toEqual({ nextEpisodeCountdown: false, discPreferences: null });
    expect(JSON.parse(readFileSync(join(tmp, 'users', 'mika', 'player-settings.json'), 'utf8'))).toEqual({ nextEpisodeCountdown: true });
    expect(() => store.get('../x')).toThrow();
  });

  it('ignores unknown fields and falls back to the default for a broken file', () => {
    const store = new PlayerSettingsStore(tmp);
    mkdirSync(join(tmp, 'users', 'mika'), { recursive: true });
    writeFileSync(join(tmp, 'users', 'mika', 'player-settings.json'), JSON.stringify({ nextEpisodeCountdown: true, later: 3 }));
    expect(store.get('mika')).toEqual({ nextEpisodeCountdown: true, discPreferences: null });
    writeFileSync(join(tmp, 'users', 'mika', 'player-settings.json'), '{not json');
    expect(store.get('mika')).toEqual({ nextEpisodeCountdown: false, discPreferences: null });
    writeFileSync(join(tmp, 'users', 'mika', 'player-settings.json'), JSON.stringify({ nextEpisodeCountdown: 'yes' }));
    expect(store.get('mika')).toEqual({ nextEpisodeCountdown: false, discPreferences: null });
  });

  const pinned = { audioLanguage: 'jpn', subtitleLanguage: 'eng', menuLanguage: 'auto', country: 'us', region: 'A' } as const;
  const auto = { audioLanguage: 'auto', subtitleLanguage: 'auto', menuLanguage: 'auto', country: 'auto', region: 'auto' } as const;

  it('keeps disc preferences, and a body with only the countdown keeps the stored ones', () => {
    const store = new PlayerSettingsStore(tmp);
    store.put('mika', { nextEpisodeCountdown: true, discPreferences: pinned });
    expect(store.get('mika')).toEqual({ nextEpisodeCountdown: true, discPreferences: pinned });
    store.put('mika', { nextEpisodeCountdown: false });
    expect(store.get('mika')).toEqual({ nextEpisodeCountdown: false, discPreferences: pinned });
  });

  it('reads a stored preference of the wrong kind as auto', () => {
    const store = new PlayerSettingsStore(tmp);
    mkdirSync(join(tmp, 'users', 'mika'), { recursive: true });
    writeFileSync(join(tmp, 'users', 'mika', 'player-settings.json'), JSON.stringify({ nextEpisodeCountdown: true, discPreferences: { audioLanguage: 7, region: 'Z', country: 'USA' } }));
    expect(store.get('mika')).toEqual({ nextEpisodeCountdown: true, discPreferences: auto });
  });

  it('isPlayerSettingsBody takes the countdown alone or with valid disc preferences', () => {
    expect(isPlayerSettingsBody({ nextEpisodeCountdown: false })).toBe(true);
    expect(isPlayerSettingsBody({ nextEpisodeCountdown: false, discPreferences: pinned })).toBe(true);
    expect(isPlayerSettingsBody({ nextEpisodeCountdown: false, discPreferences: auto })).toBe(true);
    for (const bad of [
      null, [], {}, 'x', { nextEpisodeCountdown: 1 }, { nextEpisodeCountdown: true, other: 1 },
      { nextEpisodeCountdown: true, discPreferences: null },
      { nextEpisodeCountdown: true, discPreferences: { ...pinned, audioLanguage: 'english' } },
      { nextEpisodeCountdown: true, discPreferences: { ...pinned, country: 'USA' } },
      { nextEpisodeCountdown: true, discPreferences: { ...pinned, region: 'D' } },
      { nextEpisodeCountdown: true, discPreferences: { ...pinned, extra: 1 } },
    ]) expect(isPlayerSettingsBody(bad)).toBe(false);
  });
});
