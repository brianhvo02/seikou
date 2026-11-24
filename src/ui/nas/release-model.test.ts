// SPDX-License-Identifier: LGPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import type { MkvTextExtract, MkvTextTrack } from '@seikou/engine/subs/mkv-extract';
import { canUpload, releaseGroup, releaseRow, withExtract } from './release-model';

const file = (name: string): File => new File(['x'], name);
const track = (number: number, kind: 'ass' | 'srt', language: string): MkvTextTrack => ({
  number, kind, name: null, language, isDefault: false, isForced: false, dialogueLines: 3, text: 'text',
});
const extract = (tracks: MkvTextTrack[]): MkvTextExtract => ({ tracks, fonts: [], via: 'cues' });
const season = { count: 12, before: 12 };

describe('release rows', () => {
  it('guesses the episode from the file name and maps it onto the season', () => {
    expect(releaseRow(file('[Group] Show - 03 [1080p].mkv'), season).episode).toBe(3);
    expect(releaseRow(file('[Group] Show - 15 [1080p].mkv'), season).episode).toBe(3);
    expect(releaseRow(file('[Group] Show - 40 [1080p].mkv'), season).episode).toBeNull();
  });

  it("a file with no episode number waits for one, and Upload stays off", () => {
    const row = withExtract(releaseRow(file('movie.mkv'), season), extract([track(2, 'ass', 'eng')]), ['en']);
    expect(row.episode).toBeNull();
    expect(canUpload([row])).toBe(false);
    expect(canUpload([{ ...row, episode: 4 }])).toBe(true);
  });

  it('ticks the ASS tracks in the fansub languages', () => {
    const row = withExtract(
      releaseRow(file('[G] Show - 01.mkv'), season),
      extract([track(2, 'ass', 'eng'), track(3, 'ass', 'jpn'), track(4, 'srt', 'eng')]),
      ['en'],
    );
    expect([...row.ticked]).toEqual([2]);
    const ja = withExtract(row, extract([track(2, 'ass', 'eng'), track(3, 'ass', 'jpn')]), ['ja']);
    expect([...ja.ticked]).toEqual([2, 3]);
  });

  it("a file with no text tracks offers nothing and doesn't block the others", () => {
    const empty = withExtract(releaseRow(file('[G] Show - 01.mkv'), season), extract([]), ['en']);
    const ready = withExtract(releaseRow(file('[G] Show - 02.mkv'), season), extract([track(2, 'ass', 'eng')]), ['en']);
    expect(canUpload([empty])).toBe(false);
    expect(canUpload([empty, ready])).toBe(true);
    expect(canUpload([{ ...empty, state: 'failed' }, ready])).toBe(true);
    expect(canUpload([releaseRow(file('[G] Show - 03.mkv'), season), ready])).toBe(false);
  });

  it('releaseGroup reads the bracketed group', () => {
    expect(releaseGroup('[Group] x.mkv')).toBe('Group');
    expect(releaseGroup('x.mkv')).toBeNull();
  });
});
