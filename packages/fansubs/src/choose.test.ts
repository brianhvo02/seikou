import { describe, expect, it } from 'vitest';
import { choosePerEpisode, languageTag, normalizeLanguage, rankReleases } from './choose';
import type { Candidate } from './choose';
import type { SeaDexEntry, SeaDexRelease } from './seadex';
import type { ToshoFile, ToshoRelease, ToshoTrack } from './tosho';

const track = (language: string, format = 'ASS'): ToshoTrack => ({
  track: 0, language, name: '', format, url: 'u', isDefault: false, forced: false,
});
const file = (id: number, name: string, tracks: ToshoTrack[], size = 1000): ToshoFile => ({ id, name, size, tracks });
const sx = (over: Partial<SeaDexRelease>): SeaDexRelease => ({
  tracker: 'Nyaa', infoHash: 'a'.repeat(40), isBest: false, dualAudio: false, group: 'G', tags: [], files: [], ...over,
});
const tosho = (files: ToshoFile[]): ToshoRelease => ({
  id: 1, title: 't', infoHash: 'a'.repeat(40), status: 'complete', isSeadex: true, date: 0, files,
});
const ep = (n: number, tracks: ToshoTrack[]): ToshoFile =>
  file(n, `[GroupA] Starfall Wanderer - ${String(n).padStart(2, '0')} [BD].mkv`, tracks);
const cand = (rank: Candidate['rank'], files: ToshoFile[]): Candidate => ({
  release: tosho(files), seadex: sx({ isBest: rank === 'best' }), rank,
});

describe('rankReleases', () => {
  it('orders best, web, other and drops private releases', () => {
    const entry: SeaDexEntry = {
      alId: 1, incomplete: false,
      releases: [
        sx({ group: 'other1' }),
        sx({ group: 'private', infoHash: null, isBest: true }),
        sx({ group: 'web', tags: ['WEB'] }),
        sx({ group: 'best', isBest: true }),
        sx({ group: 'webname', files: [{ name: 'Starfall.Wanderer.S01E01.WEB-DL.mkv', length: 1 }] }),
        sx({ group: 'other2' }),
      ],
    };
    const r = rankReleases(entry);
    expect(r.map((x) => x.release.group)).toEqual(['best', 'web', 'webname', 'other1', 'other2']);
    expect(r.map((x) => x.rank)).toEqual(['best', 'web', 'web', 'other', 'other']);
  });
});

describe('choosePerEpisode', () => {
  const season = { count: 12, before: 0 };
  const eps = Array.from({ length: 12 }, (_, i) => i + 1);
  it('takes missing episodes from the next release', () => {
    const best = cand('best', Array.from({ length: 10 }, (_, i) => ep(i + 1, [track('eng')])));
    const web = cand('web', [11, 12].map((n) => ep(n, [track('eng')])));
    const m = choosePerEpisode([best, web], eps, season, ['eng']);
    expect(m.size).toBe(12);
    expect(m.get(10)?.candidate).toBe(best);
    expect(m.get(11)?.candidate).toBe(web);
    expect(m.get(12)?.candidate).toBe(web);
  });
  it('falls through a release with only SRT tracks', () => {
    const best = cand('best', [ep(1, [track('eng', 'SRT')])]);
    const web = cand('web', [ep(1, [track('eng', 'SSA')])]);
    expect(choosePerEpisode([best, web], [1], season, ['eng']).get(1)?.candidate).toBe(web);
  });
  it('keeps every wanted-language track', () => {
    const c = cand('best', [ep(1, [track('eng'), track('spa'), track('jpn')])]);
    const got = choosePerEpisode([c], [1], season, ['eng', 'spa']).get(1);
    expect(got?.tracks.map((t) => t.language)).toEqual(['eng', 'spa']);
  });
  it('matches languages across code variants', () => {
    const c = cand('best', [ep(1, [track('fra')])]);
    expect(choosePerEpisode([c], [1], season, ['fre']).get(1)?.tracks).toHaveLength(1);
    const d = cand('best', [ep(1, [track('en')])]);
    expect(choosePerEpisode([d], [1], season, ['eng']).get(1)?.tracks).toHaveLength(1);
  });
  it('prefers the highest version of an episode, then the larger file', () => {
    const v1 = file(1, '[GroupA] Starfall Wanderer - 05 [BD].mkv', [track('eng')], 5000);
    const v2 = file(2, '[GroupA] Starfall Wanderer - 05v2 [BD].mkv', [track('eng')], 1000);
    expect(choosePerEpisode([cand('best', [v1, v2])], [5], season, ['eng']).get(5)?.file).toBe(v2);
    const big = file(3, '[GroupA] Starfall Wanderer - 06 [BD].mkv', [track('eng')], 9000);
    const small = file(4, 'Alt/[GroupA] Starfall Wanderer - 06 [BD].mkv', [track('eng')], 100);
    expect(choosePerEpisode([cand('best', [small, big])], [6], season, ['eng']).get(6)?.file).toBe(big);
  });
  it('picks a movie file from the first candidate that has one', () => {
    const none = cand('best', [file(1, 'Extras/NCOP.mkv', [track('eng')])]);
    const film = file(2, 'Starfall Wanderer Movie.mkv', [track('eng')], 9e9);
    const ok = cand('web', [file(3, 'NCED.mkv', [], 1), film]);
    const m = choosePerEpisode([none, ok], [1], null, ['eng']);
    expect(m.get(1)?.file).toBe(film);
    expect(m.get(1)?.candidate).toBe(ok);
  });
});

describe('normalizeLanguage', () => {
  it('maps to 639-2/B', () => {
    expect(normalizeLanguage('fra')).toBe('fre');
    expect(normalizeLanguage('FRE')).toBe('fre');
    expect(normalizeLanguage('en')).toBe('eng');
    expect(normalizeLanguage('zho')).toBe('chi');
    expect(normalizeLanguage('xyz')).toBe('xyz');
    expect(normalizeLanguage('en-US')).toBe('eng');
    expect(normalizeLanguage('pt-BR')).toBe('por');
    expect(normalizeLanguage('zh-Hans')).toBe('chi');
  });
});

describe('languageTag', () => {
  it('stores a code by its two-letter form when it has one, else as ISO 639-2/B', () => {
    expect(['eng', 'en', 'EN-us', 'dut', 'nld', 'pol', 'ger', 'chi', 'tgl', 'fil', 'und', ''].map(languageTag))
      .toEqual(['en', 'en', 'en', 'nl', 'nl', 'pl', 'de', 'zh', 'tl', 'fil', 'und', 'und']);
  });
});
