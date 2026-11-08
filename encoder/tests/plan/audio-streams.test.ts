// SPDX-License-Identifier: LGPL-3.0-or-later
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { loadPlaylist, type Playlist } from '../../src/disc/playlist';
import { probeClip, type ClipProbe } from '../../src/disc/probe';
import { selectAudio } from '../../src/plan/audio-streams';
import type { RecordMetadata, SubtitleRecord } from '../../src/subs/record';
import { fx } from '../paths';

let playlist: Playlist;
let probes: Map<string, ClipProbe>;

beforeAll(async () => {
  playlist = await loadPlaylist(fx('fixtures/disc3'), '00000');
  probes = new Map([['00001', await probeClip(playlist.items[0]!)]]);
});

function recordWith(audio: RecordMetadata['audio'], index = 2): SubtitleRecord {
  const episode = (i: number, a: RecordMetadata['audio']) => ({
    index: i,
    title: `Episode ${i}`,
    tracks: [],
    metadata: { title: `Starfall Wanderer ${i}`, video: { name: '', language: 'jpn' }, audio: a, chapters: [] },
  });
  return {
    disc: { key: 'f.0', label: 'STARFALL_WANDERER' },
    playlist: '00000',
    episodeSpec: '1,2',
    anilist: null,
    releases: [],
    fonts: [],
    episodes: [episode(1, []), episode(index, audio)],
    savedAt: '2026-11-07T00:00:00Z',
  };
}

describe('selectAudio', () => {
  it('selectAudio without a record takes every stream, first default', () => {
    expect(selectAudio(playlist, probes, null, 1)).toEqual([
      { pid: 0x1100, name: 'Japanese', language: 'jpn', isDefault: true, codingType: 0x80, channels: 2, sampleRate: 48000 },
      { pid: 0x1101, name: 'English', language: 'eng', isDefault: false, codingType: 0x81, channels: 6, sampleRate: 48000 },
      { pid: 0x1102, name: 'English', language: 'eng', isDefault: false, codingType: 0x83, channels: 2, sampleRate: 48000 },
      { pid: 0x1103, name: 'French', language: 'fra', isDefault: false, codingType: 0x82, channels: 6, sampleRate: 48000 },
    ]);
  });

  it("selectAudio follows the record's order and ticks", () => {
    const record = recordWith([
      { pid: 0x1103, name: 'Starfall dub', language: 'fra', included: true },
      { pid: 0x1100, name: 'Original', language: 'jpn', included: true },
      { pid: 0x1101, name: 'Commentary', language: 'eng', included: false },
      { pid: 0x1102, name: '', language: '', included: true },
    ]);
    const warn = vi.fn();
    expect(selectAudio(playlist, probes, record, 2, warn).map((a) => [a.pid, a.name, a.language, a.isDefault, a.codingType])).toEqual([
      [0x1103, 'Starfall dub', 'fra', true, 0x82],
      [0x1100, 'Original', 'jpn', false, 0x80],
      [0x1102, 'Unknown', 'und', false, 0x83],
    ]);
    expect(warn).not.toHaveBeenCalled();
  });

  it('a stream missing from the record is left out with a warning', () => {
    const record = recordWith([
      { pid: 0x1100, name: 'Japanese', language: 'jpn', included: true },
      { pid: 0x1101, name: 'English', language: 'eng', included: true },
      { pid: 0x1103, name: 'French', language: 'fra', included: true },
      { pid: 0x1104, name: 'Gone', language: 'deu', included: true },
    ]);
    const warn = vi.fn();
    expect(selectAudio(playlist, probes, record, 2, warn).map((a) => a.pid)).toEqual([0x1100, 0x1101, 0x1103]);
    expect(warn.mock.calls.map((c) => String(c[0]))).toEqual([
      expect.stringMatching(/^Episode 2: .*0x1104.*not in playlist 00000/),
      expect.stringMatching(/^Episode 2: .*0x1102.*not in the saved record.*left out/),
    ]);
  });

  it('fails when the record has no such episode', () => {
    expect(() => selectAudio(playlist, probes, recordWith([]), 3)).toThrow(/episode 3/);
  });

  it('a playlist with no audio selects nothing', () => {
    const silent = { ...playlist, items: playlist.items.map((i) => ({ ...i, audioPids: [], audioLanguages: [] })) };
    expect(selectAudio(silent, probes, null, 1)).toEqual([]);
  });
});
