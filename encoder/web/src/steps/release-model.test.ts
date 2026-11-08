// SPDX-License-Identifier: LGPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import type { CachedRelease, MatchRow } from '../api-types';
import { anyEpisodeHasFile, refetchNotice, releaseSummary, sourceText } from './release-model';

const track = (id: string, path: string, language = 'eng') => ({ id, name: 'Full', language, path, kind: 'full' as const, dialogueLines: 100 });

const groupA: CachedRelease = {
  key: 'tosho-1',
  source: 'tosho',
  label: 'GroupA release',
  group: 'GroupA',
  files: [
    { id: 'f1', name: 'Lantern Harbor - 01.mkv', tracks: [track('2', 'a/1/2.ass'), track('3', 'a/1/3.ass')] },
    { id: 'f2', name: 'Lantern Harbor - 02.mkv', tracks: [track('2', 'a/2/2.ass')] },
  ],
  fonts: [{ name: 'Font.ttf', path: 'a/fonts/Font.ttf' }],
};
const rows: MatchRow[] = [
  { episode: 1, fileId: 'f1', candidates: ['f1'] },
  { episode: 2, fileId: 'f2', candidates: ['f2'] },
];

describe('releaseSummary', () => {
  it('counts a fully matched release', () => {
    expect(releaseSummary(groupA, rows)).toEqual({ episodes: 2, tracks: 3, languages: ['eng'], fonts: 1, unmatched: 0 });
  });

  it('counts files no episode uses as unmatched and leaves their tracks out', () => {
    const extra: CachedRelease = { ...groupA, files: [...groupA.files, { id: 'f3', name: 'NCOP.mkv', tracks: [track('2', 'a/3/2.ass', 'jpn')] }] };
    expect(releaseSummary(extra, rows)).toEqual({ episodes: 2, tracks: 3, languages: ['eng'], fonts: 1, unmatched: 1 });
  });

  it('does not count an episode with no file', () => {
    const s = releaseSummary(groupA, [rows[0]!, { episode: 2, fileId: null, candidates: [] }]);
    expect(s.episodes).toBe(1);
    expect(s.unmatched).toBe(1);
  });
});

describe('sourceText', () => {
  it('names each source', () => {
    expect(['seadex', 'tosho', 'local'].map((x) => sourceText(x as 'seadex'))).toEqual(['SeaDex', 'Anime Tosho', 'Your files']);
  });
});

describe('anyEpisodeHasFile', () => {
  it('counts a file, not an episode marked none', () => {
    expect(anyEpisodeHasFile({ choices: {} })).toBe(false);
    expect(anyEpisodeHasFile({ choices: { 1: 'none' } })).toBe(false);
    expect(anyEpisodeHasFile({ choices: { 1: 'none', 2: { releaseKey: 'k', fileId: 'f', trackIds: [] } } })).toBe(true);
  });
});

describe('refetchNotice', () => {
  it('names the releases that failed', () => {
    expect(refetchNotice([])).toBeNull();
    expect(refetchNotice(['A'])).toBe('Could not fetch A again at the new offset. It keeps the match from the old offset.');
    expect(refetchNotice(['A', 'B'])).toMatch(/A, B again.*They keep/);
  });
});
