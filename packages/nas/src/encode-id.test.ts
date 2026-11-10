// SPDX-License-Identifier: LGPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import { encodeId, encodePlaceKey, parseEncodeId, parseEncodePlaceKey } from './encode-id';

const HEX = '0f0e0d0c0b0a49088706050403020100';

describe('encode ids', () => {
  it('keeps the AniList forms of an id and a place key', () => {
    const title = { source: 'anilist', anilistId: 990001 } as const;
    expect(encodeId(title, 2)).toBe('990001-2');
    expect(encodeId(title, 3)).toBe('990001-3');
    expect(parseEncodeId('990001-2')).toEqual({ title, episode: 2 });
    expect(encodePlaceKey(title, 2)).toBe('e.990001.2');
    expect(encodePlaceKey(title, 3)).toBe('e.990001.3');
    expect(parseEncodePlaceKey('e.990001.2')).toEqual({ title, episode: 2 });
  });
  it('names encodes of TMDB and own titles', () => {
    const tv = { source: 'tmdb-tv', tmdbId: 990002, season: 2 } as const;
    expect(encodeId(tv, 5)).toBe('tv990002s2-5');
    expect(parseEncodeId('tv1399s2-5')).toEqual({ title: { source: 'tmdb-tv', tmdbId: 1399, season: 2 }, episode: 5 });
    expect(encodePlaceKey(tv, 5)).toBe('e.tv990002s2.5');
    expect(parseEncodePlaceKey('e.tv990002s2.5')).toEqual({ title: tv, episode: 5 });
    expect(encodeId({ source: 'tmdb-movie', tmdbId: 990003 }, 1)).toBe('mv990003-1');
    expect(parseEncodeId('mv990003-1')).toEqual({ title: { source: 'tmdb-movie', tmdbId: 990003 }, episode: 1 });
    const own = { source: 'own', ownId: '0f0e0d0c-0b0a-4908-8706-050403020100', season: null } as const;
    expect(encodeId(own, 4)).toBe(`own${HEX}-4`);
    expect(parseEncodeId(`own${HEX}-4`)).toEqual({ title: own, episode: 4 });
    expect(parseEncodePlaceKey(`e.own${HEX}s3.4`)).toEqual({ title: { ...own, season: 3 }, episode: 4 });
  });
  it('refuses anything else', () => {
    const badIds = [
      '', '1', '1-', '-1', '0-1', '1-0', '990001-0', '1-2-3', 'a-1', '1-1.5', '01-1', '1- 1', '../1-1',
      'tv1399-5', 'mv603s1-1', `own${HEX.slice(1)}-1`, `own${HEX.toUpperCase()}-1`, `own${HEX}s0-1`, 'TV1399s2-5',
    ];
    for (const bad of badIds) expect(parseEncodeId(bad), bad).toBeNull();
    const badKeys = ['', 'e.1', 'e.0.1', 'e.1.0', 'e.1.2.3', 'd.1.2', 'f.1.2', 'e.a.b', 'e.tv1399.5', 'e.tv1399s2-5', `e.own${HEX.slice(1)}.1`];
    for (const bad of badKeys) expect(parseEncodePlaceKey(bad), bad).toBeNull();
  });
});
