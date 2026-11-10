import { describe, expect, it } from 'vitest';
import { nasRoutePath, parseNasRoute, seasonIdOf, seasonKeyOf, type NasRoute } from './nas-route';

const u = (p: string): URL => new URL(p, 'https://player.example');

const ROUTES: NasRoute[] = [
  { kind: 'library', shelf: null, q: '' },
  { kind: 'library', shelf: 'movie', q: '' },
  { kind: 'library', shelf: null, q: 'star fall & 100%' },
  { kind: 'library', shelf: 'music', q: '星降り' },
  { kind: 'title', titleId: 'anilist:21' },
  { kind: 'title', titleId: 'own:a/b #1' },
  { kind: 'season', titleId: 'anilist:21', seasonKey: 's2' },
  { kind: 'season', titleId: 'anilist:21', seasonKey: 'discs' },
  { kind: 'extras', titleId: 'anilist:21' },
  { kind: 'folders', path: '' },
  { kind: 'folders', path: 'syn/Anime/Starfall Wanderer (星降りの旅人)/Vol.1 #2 100%' },
  { kind: 'unsorted' },
  { kind: 'hidden' },
  { kind: 'settings' },
  { kind: 'artist', artistId: 'name:neon harbor' },
  { kind: 'artist', artistId: 'various' },
  { kind: 'play', discKey: 'f.abc123', playlistId: null, timeS: null, resume: false },
  { kind: 'play', discKey: 'd.abc123', playlistId: '00001', timeS: null, resume: false },
  { kind: 'play', discKey: 'f.abc123', playlistId: null, timeS: 90, resume: false },
  { kind: 'play', discKey: 'f.abc123', playlistId: '00001', timeS: 0, resume: false },
  { kind: 'play', discKey: 'f.abc123', playlistId: '00001', timeS: 754, resume: true },
  { kind: 'encodes', q: '' },
  { kind: 'encodes', q: 'star fall & 100%' },
  { kind: 'encodeShow', showId: '21' },
  { kind: 'encodePlay', encodeId: '21-3', timeS: null, resume: false },
  { kind: 'encodePlay', encodeId: '21-3', timeS: 754, resume: true },
  { kind: 'encodePlay', encodeId: '21-3', timeS: 0, resume: false },
  { kind: 'encodeShow', showId: 'tv990101' },
  { kind: 'encodeShow', showId: 'mv990102' },
  { kind: 'encodeShow', showId: 'own0f1e2d3c4b5a69788796a5b4c3d2e1f0' },
  { kind: 'encodePlay', encodeId: 'tv990101s1-2', timeS: null, resume: false },
  { kind: 'encodePlay', encodeId: 'mv990102-1', timeS: 754, resume: true },
  { kind: 'encodePlay', encodeId: 'own0f1e2d3c4b5a69788796a5b4c3d2e1f0s2-4', timeS: null, resume: false },
];

describe('nas route', () => {
  it.each(ROUTES)('round-trips %j', (route) => {
    expect(parseNasRoute(u(nasRoutePath(route)))).toEqual(route);
  });

  it('formats the documented paths', () => {
    expect(nasRoutePath({ kind: 'library', shelf: null, q: '' })).toBe('/nas');
    expect(nasRoutePath({ kind: 'library', shelf: 'movie', q: '' })).toBe('/nas?shelf=movie');
    expect(nasRoutePath({ kind: 'library', shelf: null, q: 'a' })).toBe('/nas?q=a');
    expect(nasRoutePath({ kind: 'library', shelf: 'movie', q: 'a' })).toBe('/nas?shelf=movie&q=a');
    expect(nasRoutePath({ kind: 'title', titleId: 'anilist:21' })).toBe('/nas/title/anilist%3A21');
    expect(nasRoutePath({ kind: 'extras', titleId: 'x' })).toBe('/nas/title/x/extras');
    expect(nasRoutePath({ kind: 'folders', path: 'a/b' })).toBe('/nas/folders/a/b');
    expect(nasRoutePath({ kind: 'artist', artistId: 'name:neon harbor' })).toBe('/nas/artist/name%3Aneon%20harbor');
    expect(nasRoutePath({ kind: 'play', discKey: 'f.1', playlistId: '2', timeS: 3.9, resume: false })).toBe(
      '/nas/play/f.1?pl=2&t=3',
    );
    expect(nasRoutePath({ kind: 'play', discKey: 'f.1', playlistId: '2', timeS: 60, resume: true })).toBe('/nas/play/f.1?pl=2&t=60&resume=1');
  });

  it('formats the encodes paths', () => {
    expect(nasRoutePath({ kind: 'encodes', q: '' })).toBe('/nas/encodes');
    expect(nasRoutePath({ kind: 'encodes', q: 'a b' })).toBe('/nas/encodes?q=a+b');
    expect(nasRoutePath({ kind: 'encodeShow', showId: '21' })).toBe('/nas/encodes/show/21');
    expect(nasRoutePath({ kind: 'encodePlay', encodeId: '21-3', timeS: null, resume: false })).toBe('/nas/encodes/play/21-3');
    expect(nasRoutePath({ kind: 'encodePlay', encodeId: '21-3', timeS: 60.7, resume: true })).toBe('/nas/encodes/play/21-3?t=60&resume=1');
  });

  it('takes encode ids and show ids of any title', () => {
    expect(parseNasRoute(u('/nas/encodes/play/tv990101s1-2'))).toEqual({ kind: 'encodePlay', encodeId: 'tv990101s1-2', timeS: null, resume: false });
    expect(parseNasRoute(u('/nas/encodes/show/own0f1e2d3c4b5a69788796a5b4c3d2e1f0'))).toEqual({ kind: 'encodeShow', showId: 'own0f1e2d3c4b5a69788796a5b4c3d2e1f0' });
    expect(nasRoutePath({ kind: 'encodePlay', encodeId: 'tv990101s1-2', timeS: 60, resume: true })).toBe('/nas/encodes/play/tv990101s1-2?t=60&resume=1');
  });

  it('falls back to the encodes list for an unknown encodes path', () => {
    expect(parseNasRoute(u('/nas/encodes/show'))).toEqual({ kind: 'encodes', q: '' });
    expect(parseNasRoute(u('/nas/encodes/bogus/1'))).toEqual({ kind: 'encodes', q: '' });
  });

  it('treats /nas and /nas/ as the library', () => {
    expect(parseNasRoute(u('/nas'))).toEqual({ kind: 'library', shelf: null, q: '' });
    expect(parseNasRoute(u('/nas/'))).toEqual({ kind: 'library', shelf: null, q: '' });
  });

  it('returns null outside /nas', () => {
    expect(parseNasRoute(u('/'))).toBeNull();
    expect(parseNasRoute(u('/nasx'))).toBeNull();
    expect(parseNasRoute(u('/probe.html'))).toBeNull();
  });

  it('falls back to the library for unknown input', () => {
    const lib = { kind: 'library', shelf: null, q: '' };
    expect(parseNasRoute(u('/nas?shelf=bogus'))).toEqual(lib);
    expect(parseNasRoute(u('/nas/title/x/season'))).toEqual(lib);
    expect(parseNasRoute(u('/nas/unknown'))).toEqual(lib);
    expect(parseNasRoute(u('/nas/title/%E0%A4%A'))).toEqual(lib);
  });

  it('reads t as whole seconds or null', () => {
    const t = (v: string): unknown => (parseNasRoute(u(`/nas/play/f.1?t=${v}`)) as { timeS: unknown }).timeS;
    expect(t('-3')).toBeNull();
    expect(t('abc')).toBeNull();
    expect(t('1e99')).toBeNull();
    expect(t('12.9')).toBe(12);
  });

  it('converts season ids and keys', () => {
    expect(seasonKeyOf('anilist:21', 'anilist:21#s2')).toBe('s2');
    expect(seasonIdOf('anilist:21', 's2')).toBe('anilist:21#s2');
  });

  it('gives each season of an AniList series its own key', () => {
    // a series' seasons are its member entries, `<member id>#season`, so the text after '#' is the same for all
    const ids = ['anilist:21#season', 'anilist:22#season', 'anilist:23#season'];
    const keys = ids.map((id) => seasonKeyOf('anilist:21', id));
    expect(new Set(keys).size).toBe(3);
    for (const [i, id] of ids.entries()) {
      expect(seasonIdOf('anilist:21', keys[i]!)).toBe(id);
      const route: NasRoute = { kind: 'season', titleId: 'anilist:21', seasonKey: keys[i]! };
      expect(parseNasRoute(u(nasRoutePath(route)))).toEqual(route);
    }
  });
});
