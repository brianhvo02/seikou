// SPDX-License-Identifier: LGPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import { episodeOfFile, fileVersion, isExtraFile } from '@seikou/fansubs/episode-files';
import { matchRelease, trackKind, type ReleaseFileInfo } from '../../src/subs/release-match';

const file = (name: string): ReleaseFileInfo => ({ id: name, name, tracks: [] });

describe('episode-files behaviour the matcher relies on', () => {
  it('reads 02v2 as episode 2 version 2 and NCOP1 as an extra', () => {
    expect(episodeOfFile('[GroupA] Lantern Harbor - 02v2 (BD).mkv')).toBe(2);
    expect(fileVersion('[GroupA] Lantern Harbor - 02v2 (BD).mkv')).toBe(2);
    expect(isExtraFile('[GroupA] Lantern Harbor - NCOP1 (BD).mkv')).toBe(true);
  });
});

describe('matchRelease', () => {
  it('matches by number and prefers the newest version', () => {
    const v1 = file('[GroupA] Lantern Harbor - 02 (BD).mkv');
    const v2 = file('[GroupA] Lantern Harbor - 02v2 (BD).mkv');
    const e1 = file('[GroupA] Lantern Harbor - 01 (BD).mkv');
    const { rows, unmatched } = matchRelease([e1, v1, v2], [1, 2], 0);
    expect(unmatched).toEqual([]);
    expect(rows[0]).toEqual({ episode: 1, fileId: e1.id, candidates: [e1.id] });
    expect(rows[1]).toEqual({ episode: 2, fileId: v2.id, candidates: [v2.id, v1.id] });
  });

  it('puts extras and unnumbered files in unmatched', () => {
    const files = [
      file('[GroupA] Lantern Harbor - NCOP1 (BD).mkv'),
      file('[GroupA] Lantern Harbor - NCED (BD).mkv'),
      file('Lantern Harbor (BD).mkv'),
    ];
    const { rows, unmatched } = matchRelease(files, [1, 2], 0);
    expect(unmatched).toEqual(files);
    expect(rows.map((r) => r.fileId)).toEqual([null, null]);
    expect(rows.map((r) => r.candidates)).toEqual([[], []]);
  });

  it('applies the AniList episode offset', () => {
    const a = file('[GroupA] Lantern Harbor - 13 (BD).mkv');
    const b = file('[GroupA] Lantern Harbor - 14 (BD).mkv');
    const { rows } = matchRelease([a, b], [1, 2], 12);
    expect(rows.map((r) => r.fileId)).toEqual([a.id, b.id]);
  });

  it("leaves numbers outside the disc's episodes unmatched", () => {
    const f = file('[GroupA] Lantern Harbor - 05 (BD).mkv');
    const { rows, unmatched } = matchRelease([f], [1, 2], 0);
    expect(unmatched).toEqual([f]);
    expect(rows.map((r) => r.fileId)).toEqual([null, null]);
  });
});

describe('trackKind', () => {
  it('labels signs, songs and forced tracks', () => {
    expect(trackKind('Signs & Songs')).toBe('signs');
    expect(trackKind('English')).toBe('full');
    expect(trackKind('Forced')).toBe('signs');
    expect(trackKind('S&S')).toBe('signs');
  });
});
