import { describe, expect, it } from 'vitest';
import { episodeOfFile, fileVersion, mainFile, seasonEpisode } from './episode-files';
import type { ToshoFile } from './tosho';

describe('episodeOfFile', () => {
  const cases: [string, number | null][] = [
    ['[GroupB] Starfall Wanderer - 05 (1080p) [ABCD1234].mkv', 5],
    ['Starfall.Wanderer.S01E12.1080p.WEB-DL.mkv', 12],
    ['[GroupA] Starfall Wanderer - 07v2 [BD 1080p].mkv', 7],
    ['Starfall Wanderer E05.mkv', 5],
    ['[GroupA] Starfall Wanderer 第05話 [BD].mkv', 5],
    ['[GroupA] Starfall Wanderer 05 [BD 1080p].mkv', 5],
    ['Season 1/[GroupA] Starfall Wanderer - 03.mkv', 3],
    ['Extras/[GroupA] Starfall Wanderer - NCOP1.mkv', null],
    ['[GroupA] Starfall Wanderer - NCED2 [BD].mkv', null],
    ['[GroupA] Starfall Wanderer - PV1 [BD].mkv', null],
    ['Specials/[GroupA] Starfall Wanderer - 01.mkv', null],
    ['[GroupA] Starfall Wanderer [BD 1080p].mkv', null],
    ['[GroupB] Starfall Wanderer - 05 (1080p) [5E12FA90].mkv', 5],
    ['[GroupB] Starfall Wanderer - 05 [1080p][A1E23B4C].mkv', 5],
    ['Creditless Opening 01 [BD].mkv', null],
    ['Clean Ending 02 [BD].mkv', null],
    ['[GroupA] Starfall Wanderer - NCOP1v2 [BD].mkv', null],
    ['[GroupA] Starfall Wanderer - NCED2v3 [BD].mkv', null],
    ['Starfall Wanderer EP05.mkv', 5],
    ['Starfall Wanderer Episode 05.mkv', 5],
    ['Starfall_Wanderer_-_05_[BD].mkv', 5],
    ['Starfall_Wanderer_-_NCOP1_[BD].mkv', null],
  ];
  it.each(cases)('%s', (name, want) => expect(episodeOfFile(name)).toBe(want));
});

describe('seasonEpisode', () => {
  it('maps a continuing number into the season', () => {
    expect(seasonEpisode(14, { count: 12, before: 12 })).toBe(2);
    expect(seasonEpisode(5, { count: 12, before: 12 })).toBe(5);
    expect(seasonEpisode(30, { count: 12, before: 12 })).toBeNull();
    expect(seasonEpisode(0, { count: 12, before: 0 })).toBeNull();
  });
});

describe('mainFile', () => {
  const f = (id: number, name: string, size: number): ToshoFile => ({ id, name, size, tracks: [] });
  it('picks the film over a creditless ending', () => {
    const files = [f(1, 'Starfall Wanderer - NCED.mkv', 200e6), f(2, 'Starfall Wanderer Movie.mkv', 9e9)];
    expect(mainFile(files)?.id).toBe(2);
  });
  it('is null with only extras', () => {
    expect(mainFile([f(1, 'Extras/a.mkv', 5)])).toBeNull();
  });
});

describe('fileVersion', () => {
  it('reads vN', () => {
    expect(fileVersion('Starfall Wanderer - 05v2 [BD].mkv')).toBe(2);
    expect(fileVersion('Starfall Wanderer - 05 [BD].mkv')).toBe(1);
  });
});
