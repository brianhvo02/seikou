import { describe, expect, it } from 'vitest';
import type { DiscEvidence } from './disc-evidence';
import { guessEpisodes } from './episodes';

type Playlist = DiscEvidence['playlists'][number];

const pl = (id: string, minutes: number, clips: readonly string[]): Playlist => ({ id, durationS: minutes * 60, chapters: 6, clips });

/** Three 24-minute episodes, a 72-minute play-all over them and a 1.5-minute preview. */
const disc = (discId: string): { discId: string; playlists: Playlist[] } => ({
  discId,
  playlists: [
    pl('00001', 24, ['00001']),
    pl('00002', 24.3, ['00002']),
    pl('00003', 23.8, ['00003']),
    pl('00004', 72.1, ['00001', '00002', '00003']),
    pl('00005', 1.5, ['00010']),
  ],
});

const SEASON = { episodes: 12, runtimeMin: 24 };
const fourDiscs = ['d1', 'd2', 'd3', 'd4'].map(disc);

describe('guessEpisodes', () => {
  it('numbers the episode-length playlists of a disc, leaving out the play-all and the preview', () => {
    const eps = guessEpisodes(SEASON, fourDiscs, 1)!;
    expect(eps.filter((e) => e.discId === 'd1')).toEqual([
      { number: 1, name: null, runtimeMin: 24, discId: 'd1', playlistId: '00001' },
      { number: 2, name: null, runtimeMin: 24, discId: 'd1', playlistId: '00002' },
      { number: 3, name: null, runtimeMin: 24, discId: 'd1', playlistId: '00003' },
    ]);
  });

  it('continues the numbering on the next disc', () => {
    const eps = guessEpisodes(SEASON, fourDiscs, 1)!;
    expect(eps.filter((e) => e.discId === 'd2').map((e) => [e.number, e.playlistId])).toEqual([[4, '00001'], [5, '00002'], [6, '00003']]);
    expect(eps.map((e) => e.number)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);
  });

  it('starts from firstNumber', () => {
    expect(guessEpisodes({ episodes: 3, runtimeMin: 24 }, [disc('d1')], 13)!.map((e) => e.number)).toEqual([13, 14, 15]);
  });

  it('is null when the total is not the season\'s episode count', () => {
    expect(guessEpisodes(SEASON, fourDiscs.slice(0, 3), 1)).toBeNull();
    expect(guessEpisodes({ episodes: 9, runtimeMin: 24 }, fourDiscs, 1)).toBeNull();
  });

  it('is null without a runtime or an episode count', () => {
    expect(guessEpisodes({ episodes: 12, runtimeMin: null }, fourDiscs, 1)).toBeNull();
    expect(guessEpisodes({ episodes: null, runtimeMin: 24 }, fourDiscs, 1)).toBeNull();
  });

  it('counts playlists with the same clip list once', () => {
    const withDupes = fourDiscs.map((d) => ({ ...d, playlists: [...d.playlists, pl('00006', 24.3, ['00002']), pl('00007', 24, ['00003'])] }));
    const eps = guessEpisodes(SEASON, withDupes, 1)!;
    expect(eps.filter((e) => e.discId === 'd1').map((e) => e.playlistId)).toEqual(['00001', '00002', '00003']);
  });

  it('counts runtimes within 25% of the season runtime as episodes', () => {
    const d = { discId: 'd1', playlists: [pl('00001', 18.5, ['00001']), pl('00002', 29.5, ['00002']), pl('00003', 14, ['00003']), pl('00004', 39, ['00004'])] };
    expect(guessEpisodes({ episodes: 2, runtimeMin: 24 }, [d], 1)!.map((e) => e.playlistId)).toEqual(['00001', '00002']);
  });

  it('orders episodes that share an opening and an ending clip by their own clips', () => {
    const d = { discId: 'd1', playlists: [pl('00001', 24, ['00090', '00001', '00091']), pl('00002', 24, ['00090', '00002', '00091'])] };
    expect(guessEpisodes({ episodes: 2, runtimeMin: 24 }, [d], 1)!.map((e) => e.playlistId)).toEqual(['00001', '00002']);
  });

  it('is null when overlapping clip lists cannot be ordered', () => {
    // 00003 holds only clips the others hold too
    const overlap = { discId: 'd1', playlists: [pl('00001', 24, ['00001', '00002']), pl('00002', 24, ['00003', '00004']), pl('00003', 24, ['00002', '00003'])] };
    expect(guessEpisodes({ episodes: 3, runtimeMin: 24 }, [overlap], 1)).toBeNull();
    // the playlists' own clips run against their playlist order
    const crossed = { discId: 'd1', playlists: [pl('00001', 24, ['00002']), pl('00002', 24, ['00001'])] };
    expect(guessEpisodes({ episodes: 2, runtimeMin: 24 }, [crossed], 1)).toBeNull();
  });
});

describe('guessEpisodes uncertain runtimes (ruling T7g)', () => {
  it('is null when a playlist is neither clearly an episode nor clearly not one', () => {
    const special = { discId: 'd1', playlists: [...disc('d1').playlists, pl('00006', 23, ['00011'])] };
    const finale = { discId: 'd4', playlists: [pl('00001', 24, ['00001']), pl('00002', 24, ['00002']), pl('00003', 32, ['00003'])] };
    expect(guessEpisodes(SEASON, [special, disc('d2'), disc('d3'), finale], 1)).toBeNull();
    const longish = { discId: 'd1', playlists: [pl('00001', 24, ['00001']), pl('00002', 15, ['00002'])] };
    expect(guessEpisodes({ episodes: 1, runtimeMin: 24 }, [longish], 1)).toBeNull();
  });

  it('lets a play-all in the uncertain band pass', () => {
    const d = { discId: 'd1', playlists: [pl('00001', 18.5, ['00001']), pl('00002', 19, ['00002']), pl('00003', 37.5, ['00001', '00002'])] };
    expect(guessEpisodes({ episodes: 2, runtimeMin: 24 }, [d], 1)!.map((e) => e.playlistId)).toEqual(['00001', '00002']);
  });
});
