// SPDX-License-Identifier: LGPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import { parsePlaceKey } from './place-key';

describe('parsePlaceKey', () => {
  it('reads disc keys and encode keys, and nothing else', () => {
    const fp = 'A'.repeat(32);
    expect(parsePlaceKey(`f.${fp}`)).toEqual({ kind: 'disc', key: { kind: 'fingerprint', fingerprint: fp } });
    expect(parsePlaceKey('d.0123456789abcdef')).toEqual({ kind: 'disc', key: { kind: 'disc', discId: '0123456789abcdef' } });
    expect(parsePlaceKey('e.990001.12')).toEqual({ kind: 'encode', title: { source: 'anilist', anilistId: 990001 }, episode: 12 });
    expect(parsePlaceKey('e.tv990002s1.3')).toEqual({ kind: 'encode', title: { source: 'tmdb-tv', tmdbId: 990002, season: 1 }, episode: 3 });
    expect(parsePlaceKey('e.mv990003.1')).toEqual({ kind: 'encode', title: { source: 'tmdb-movie', tmdbId: 990003 }, episode: 1 });
    for (const bad of ['', 'e.0.1', 'e.1.0', 'e.1', 'e.1.2.3', 'e.-1.2', 'e.1-2', 'x.1.2', 'd.ABC', 'e.tv1.2', 'e.mv0.1']) expect(parsePlaceKey(bad), bad).toBeNull();
  });
});
