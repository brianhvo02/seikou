// SPDX-License-Identifier: LGPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import type { MkvTextExtract, MkvTextTrack } from '@seikou/engine/subs/mkv-extract';
import { canUpload, releaseGroup, releaseLanguage, releaseRow, withExtract } from './release-model';

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
      ['eng'],
    );
    expect([...row.ticked]).toEqual([2]);
    const ja = withExtract(row, extract([track(2, 'ass', 'eng'), track(3, 'ass', 'jpn')]), ['eng', 'jpn']);
    expect([...ja.ticked]).toEqual([2, 3]);
  });

  it('takes the NAS fansub languages as ISO 639-2 codes, as the NAS keeps them', () => {
    const row = withExtract(
      releaseRow(file('[G] Show - 01.mkv'), season),
      extract([track(2, 'ass', 'eng'), track(3, 'ass', 'spa'), track(4, 'ass', 'ger'), track(5, 'ass', 'es')]),
      ['eng', 'spa'],
    );
    expect([...row.ticked]).toEqual([2, 3, 5]);
  });

  it('releaseLanguage maps ISO 639-2 to the short code, keeps others and gives und for none', () => {
    expect(releaseLanguage('eng')).toBe('en');
    expect(releaseLanguage('SPA')).toBe('es');
    expect(releaseLanguage('fra')).toBe('fr');
    expect(releaseLanguage('es')).toBe('es');
    expect(releaseLanguage('tlh')).toBe('tlh');
    expect(releaseLanguage(null)).toBe('und');
    expect(releaseLanguage('  ')).toBe('und');
    expect(releaseLanguage('und')).toBe('und');
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
