// SPDX-License-Identifier: LGPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import { defaultMetadata, defaultTrackName, languageName } from './metadata-model';

describe('defaultMetadata', () => {
  it('defaultMetadata follows the spec', () => {
    const draft = defaultMetadata({
      show: 'Lantern Harbor',
      episodes: [
        { index: 1, title: 'Arrival', chapterCount: 3 },
        { index: 2, title: null, chapterCount: 2 },
      ],
      audio: [
        { pid: 0x1100, language: 'jpn' },
        { pid: 0x1101, language: '' },
      ],
      tracks: {
        1: [
          { name: 'English', kind: 'full', language: 'eng', group: 'GroupA', key: 'releases/tosho-1/10-t1.ass' },
          { name: 'Signs & Songs', kind: 'signs', language: 'eng', group: 'GroupA', key: 'releases/tosho-1/10-t2.ass' },
        ],
      },
    });
    const one = draft.episodes[1]!;
    expect(one.title).toBe('Lantern Harbor - 01 - Arrival');
    expect(one.episodeTitle).toBe('Arrival');
    expect(one.video).toEqual({ name: '', language: 'und' });
    expect(one.audio).toEqual([
      { pid: 0x1100, name: 'Japanese', language: 'jpn', included: true },
      { pid: 0x1101, name: '', language: 'und', included: true },
    ]);
    expect(one.chapters).toEqual(['Chapter 1', 'Chapter 2', 'Chapter 3']);
    expect(one.tracks.map((t) => [t.key, t.name, t.language, t.kind, t.included])).toEqual([
      ['releases/tosho-1/10-t1.ass', 'GroupA full', 'eng', 'full', true],
      ['releases/tosho-1/10-t2.ass', 'GroupA signs', 'eng', 'signs', true],
    ]);
    expect(draft.episodes[2]!.title).toBe('Lantern Harbor - 02');
    expect(draft.episodes[2]!.tracks).toEqual([]);
    expect(draft.edited.size).toBe(0);
  });

  it('drops a missing show and keeps the number', () => {
    const draft = defaultMetadata({ show: null, episodes: [{ index: 3, title: 'Fog', chapterCount: 1 }], audio: [], tracks: {} });
    expect(draft.episodes[3]!.title).toBe('03 - Fog');
  });

  it('names tracks of a release without a group by kind alone', () => {
    expect(defaultTrackName('', 'full')).toBe('full');
    expect(defaultTrackName('GroupB', 'signs')).toBe('GroupB signs');
  });

  it('reads language names in English and leaves unknown codes unnamed', () => {
    expect(languageName('jpn')).toBe('Japanese');
    expect(languageName('eng')).toBe('English');
    expect(languageName('und')).toBe('');
  });

  it('turns a language that is not three letters into und', () => {
    const draft = defaultMetadata({
      show: null,
      episodes: [{ index: 1, title: null, chapterCount: 0 }],
      audio: [{ pid: 1, language: 'JPN' }],
      tracks: { 1: [{ name: 'x', kind: 'full', language: 'en-US', group: 'GroupA' }] },
    });
    expect(draft.episodes[1]!.audio[0]!.language).toBe('jpn');
    expect(draft.episodes[1]!.tracks[0]!.language).toBe('und');
  });
});
