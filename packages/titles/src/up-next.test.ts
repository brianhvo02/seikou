import { describe, expect, it } from 'vitest';
import type { DiscSlot, EpisodeRef, PlaybackPlace, SeasonDetail, TitleDetail, TitleKind, TitleSummary } from '@seikou/nas/nas-api';
import type { Catalogue } from './catalogue';
import { continueWatching, titleProgress } from './up-next';

// Every name here is made up.

const summary = (id: string, kind: TitleKind, display: string): TitleSummary => ({
  id, kind, names: { english: null, romaji: null, native: null, synonyms: [], display }, poster: `art-${id}`, year: null, seasons: 1, discs: 1, addedAt: 0, own: false,
});
const ep = (number: number, discId: string, playlistId: string): EpisodeRef => ({ number, name: null, runtimeMin: 24, discId, playlistId });
const slot = (discId: string, ...copies: string[]): DiscSlot => ({ number: 1, label: 'Disc 1', copies: [discId, ...copies].map((d) => ({ discId: d, root: 'r', folder: d, displayName: null })) });
const season = (id: string, number: number | null, discs: DiscSlot[], episodes: EpisodeRef[] | null): SeasonDetail => ({ id, label: '', number, discs, episodes, extras: [] });

const star = summary('star', 'series', 'Starfall Wanderer');
const starDetail: TitleDetail = {
  title: star, banner: null, related: [], extras: [],
  seasons: [
    season('s1', 1, [slot('dA', 'dA2'), slot('dB')], [ep(1, 'dA', '00001'), ep(2, 'dA', '00002'), ep(3, 'dB', '00001')]),
    season('s2', 2, [slot('dC')], [ep(1, 'dC', '00001')]),
  ],
};
const unknown = summary('unk', 'series', 'Moon Harbor');
const unknownDetail: TitleDetail = {
  title: unknown, banner: null, related: [], extras: [],
  seasons: [season('u1', 1, [slot('dU')], [ep(1, 'dU', '00001')]), season('u2', 2, [slot('dV')], null)],
};
const film = summary('film', 'movie', 'Lantern Road');
const filmDetail: TitleDetail = { title: film, banner: null, related: [], extras: [], seasons: [season('m', null, [slot('dM')], [ep(1, 'dM', '00001')])] };

const catalogue: Catalogue = {
  titles: [star, unknown, film],
  detail: (id) => ({ star: starDetail, unk: unknownDetail, film: filmDetail })[id] ?? null,
  unsorted: [], hidden: [], art: () => null, provisional: [],
};

const settings = { pgLanguage: null, textFiles: [], audioLanguage: null, psr1: 1, psr2: 2, psr3: 3, textOn: false, textScale: 1, shaderSet: null, volume: 1, muted: false };
const place = (discId: string, playlistId: string, over: Partial<PlaybackPlace> = {}): PlaybackPlace => ({
  discKey: `d.${discId.padEnd(16, '0')}`, discId, playlistId, timeUs: 5_000_000, durationUs: 60_000_000, finished: false, mode: 'none', title: null,
  psrs: [], gprs: null, settings, updatedAt: 1000, deviceName: 'Phone', ...over,
});
const discsOf = (key: string): string[] => (key.startsWith('d.') ? [key.slice(2, 2 + key.slice(2).replace(/0+$/, '').length)] : key === 'f.COPY' ? ['dA', 'dA2'] : []);
const run = (places: PlaybackPlace[]) => continueWatching(places, catalogue, discsOf, (id) => `d.${id}`);

describe('continueWatching', () => {
  it('shows an unfinished place as a resume card with its catalogue fields', () => {
    const [item] = run([place('dA', '00002')]);
    expect(item).toMatchObject({
      kind: 'resume', discId: 'dA', playlistId: '00002', timeUs: 5_000_000, titleId: 'star', titleName: 'Starfall Wanderer', poster: 'art-star',
      seasonId: 's1', seasonNumber: 1, episode: 2, kindOfTitle: 'series',
    });
  });

  it('keeps null catalogue fields for a place the catalogue does not know', () => {
    const [item] = run([place('dZ', '00009')]);
    expect(item).toMatchObject({ kind: 'resume', titleId: null, titleName: null, poster: null, seasonId: null, seasonNumber: null, episode: null, kindOfTitle: null });
  });

  it('offers the next episode of the season after a finished one', () => {
    const items = run([place('dA', '00001', { finished: true, updatedAt: 2000 })]);
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ kind: 'up-next', discId: 'dA', playlistId: '00002', discKey: 'd.dA', timeUs: 0, durationUs: 24 * 60_000_000, episode: 2, seasonNumber: 1, updatedAt: 2000, deviceName: 'Phone' });
  });

  it('moves on to the next season\'s first episode, on another disc', () => {
    const [item] = run([place('dB', '00001', { finished: true })]);
    expect(item).toMatchObject({ kind: 'up-next', discId: 'dC', playlistId: '00001', seasonId: 's2', seasonNumber: 2, episode: 1 });
  });

  it('leaves out a place near its start, which then holds back no Up next card', () => {
    expect(run([place('dA', '00002', { timeUs: 2_999_999 })])).toEqual([]); // under 5% of 60 s
    expect(run([place('dA', '00002', { timeUs: 3_000_000 })])).toHaveLength(1);
    const items = run([place('dA', '00001', { finished: true, updatedAt: 2000 }), place('dA', '00002', { timeUs: 1_000_000, updatedAt: 3000 })]);
    expect(items.map((i) => [i.kind, i.playlistId])).toEqual([['up-next', '00002']]);
  });

  it("carries the finished episode's settings on an Up next card, and none on a resume card", () => {
    const chosen = { ...settings, audioLanguage: 'jpn', shaderSet: 'Mode A', volume: 0.5 };
    const items = run([place('dB', '00001', { finished: true, settings: chosen, updatedAt: 2000 }), place('dZ', '00009')]);
    expect(items.map((i) => [i.kind, i.settings])).toEqual([['up-next', chosen], ['resume', null]]);
  });

  it('drops a series whose last episode is finished', () => {
    expect(run([place('dC', '00001', { finished: true })])).toEqual([]);
  });

  it('drops a series whose next episode is unknown', () => {
    expect(run([place('dU', '00001', { finished: true })])).toEqual([]);
  });

  it('drops a finished movie', () => {
    expect(run([place('dM', '00001', { finished: true })])).toEqual([]);
  });

  it('is suppressed by a newer place of the series, or a place of the next episode', () => {
    const finished = place('dA', '00001', { finished: true, updatedAt: 2000 });
    expect(run([finished, place('dB', '00001', { updatedAt: 3000 })]).map((i) => i.kind)).toEqual(['resume']);
    expect(run([finished, place('dA', '00002', { updatedAt: 1500 })]).map((i) => i.kind)).toEqual(['resume']);
  });

  it('leads on only from the series\' newest finished episode', () => {
    const items = run([place('dA', '00001', { finished: true, updatedAt: 1000 }), place('dA', '00002', { finished: true, updatedAt: 2000 })]);
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ kind: 'up-next', discId: 'dB', episode: 3 });
  });

  it('finds an episode through a place on another copy with the same fingerprint', () => {
    const copy = place('dA2', '00001', { discKey: 'f.COPY', finished: true });
    expect(run([copy])[0]).toMatchObject({ kind: 'up-next', discId: 'dA', episode: 2 });
    expect(run([place('dA2', '00001', { discKey: 'f.COPY' })])[0]).toMatchObject({ kind: 'resume', episode: 1, titleId: 'star' });
  });

  it('lists 50 cards at most, newest first', () => {
    const places = Array.from({ length: 51 }, (_, i) => place('dZ', String(i).padStart(5, '0'), { updatedAt: 1000 + i }));
    const items = run(places);
    expect(items).toHaveLength(50);
    expect(items[0]!.updatedAt).toBe(1050);
    expect(items[49]!.updatedAt).toBe(1001);
  });
});

describe('titleProgress', () => {
  it('maps each copy of a title\'s discs and playlists to the place', () => {
    const progress = titleProgress(
      [place('dA2', '00001', { discKey: 'f.COPY', timeUs: 7, durationUs: 9 }), place('dB', '00001', { finished: true }), place('dZ', '00001')],
      starDetail, discsOf,
    );
    expect(progress).toEqual({
      dA: { '00001': { timeUs: 7, durationUs: 9, finished: false } },
      dA2: { '00001': { timeUs: 7, durationUs: 9, finished: false } },
      dB: { '00001': { timeUs: 5_000_000, durationUs: 60_000_000, finished: true } },
    });
  });
});
