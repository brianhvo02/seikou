// SPDX-License-Identifier: LGPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import { defaultMetadata, defaultTrackName, languageName, mergeDefaults, move, withUserEdit, type MetadataDraft } from './metadata-model';

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

describe('move', () => {
  it('moves an item forward and back', () => {
    expect(move(['a', 'b', 'c', 'd'], 0, 2)).toEqual(['b', 'c', 'a', 'd']);
    expect(move(['a', 'b', 'c', 'd'], 3, 1)).toEqual(['a', 'd', 'b', 'c']);
  });

  it('answers a copy when nothing moves', () => {
    const list = ['a', 'b'];
    const same = move(list, 1, 1);
    expect(same).toEqual(list);
    expect(same).not.toBe(list);
  });

  it('keeps the target inside the list and ignores a source outside it', () => {
    expect(move(['a', 'b', 'c'], 0, 9)).toEqual(['b', 'c', 'a']);
    expect(move(['a', 'b', 'c'], 2, -1)).toEqual(['c', 'a', 'b']);
    expect(move(['a', 'b', 'c'], 5, 0)).toEqual(['a', 'b', 'c']);
  });
});

describe('withUserEdit and mergeDefaults', () => {
  const input = (show: string | null, title: string | null) => ({
    show,
    episodes: [{ index: 1, title, chapterCount: 2 }],
    audio: [
      { pid: 0x1100, language: 'jpn' },
      { pid: 0x1101, language: 'eng' },
    ],
    tracks: { 1: [{ name: 'x', kind: 'full' as const, language: 'eng', group: 'GroupA', key: 'k1' }] },
  });

  it('a user edit survives mergeDefaults', () => {
    const start = defaultMetadata(input(null, null));
    const edited = withUserEdit(start, 'episodes.1.chapters.1', 'Ending');
    expect(edited.episodes[1]!.chapters).toEqual(['Chapter 1', 'Ending']);
    expect(edited.edited.has('episodes.1.chapters')).toBe(true);
    expect(start.episodes[1]!.chapters).toEqual(['Chapter 1', 'Chapter 2']);

    const merged = mergeDefaults(edited, defaultMetadata(input('Lantern Harbor', 'Arrival')));
    expect(merged.episodes[1]!.chapters).toEqual(['Chapter 1', 'Ending']);
    // an untouched field takes the new default
    expect(merged.episodes[1]!.title).toBe('Lantern Harbor - 01 - Arrival');
    expect(merged.episodes[1]!.episodeTitle).toBe('Arrival');
  });

  it('a typed title is kept when the show arrives', () => {
    const typed = withUserEdit(defaultMetadata(input(null, null)), 'episodes.1.title', 'My cut');
    const merged = mergeDefaults(typed, defaultMetadata(input('Lantern Harbor', 'Arrival')));
    expect(merged.episodes[1]!.title).toBe('My cut');
    expect(merged.edited).toEqual(new Set(['episodes.1.title']));
  });

  it('reordered audio keeps its order and follows the disc streams', () => {
    const start = defaultMetadata(input(null, null));
    const reordered = withUserEdit(start, 'episodes.1.audio', move(start.episodes[1]!.audio, 1, 0));
    const merged = mergeDefaults(reordered, defaultMetadata(input('Lantern Harbor', null)));
    expect(merged.episodes[1]!.audio.map((a) => a.pid)).toEqual([0x1101, 0x1100]);
  });

  it('edited tracks keep their order and names, drop tracks no longer chosen and add new ones', () => {
    const start = defaultMetadata({
      ...input(null, null),
      tracks: {
        1: [
          { name: 'x', kind: 'full', language: 'eng', group: 'GroupA', key: 'k1' },
          { name: 'y', kind: 'signs', language: 'eng', group: 'GroupA', key: 'k2' },
        ],
      },
    });
    const tracks = start.episodes[1]!.tracks;
    const edited = withUserEdit(start, 'episodes.1.tracks', [{ ...tracks[1]!, name: 'Songs' }, tracks[0]!]);
    const next = defaultMetadata({
      ...input(null, null),
      tracks: {
        1: [
          { name: 'y', kind: 'signs', language: 'eng', group: 'GroupA', key: 'k2' },
          { name: 'z', kind: 'full', language: 'spa', group: 'GroupA', key: 'k3' },
        ],
      },
    });
    const merged = mergeDefaults(edited, next);
    expect(merged.episodes[1]!.tracks.map((t) => [t.key, t.name])).toEqual([
      ['k2', 'Songs'],
      ['k3', 'GroupA full'],
    ]);
  });

  it('unedited tracks follow the defaults', () => {
    const merged = mergeDefaults(defaultMetadata(input(null, null)), defaultMetadata({ ...input(null, null), tracks: {} }));
    expect(merged.episodes[1]!.tracks).toEqual([]);
  });

  it('answers the same draft when the defaults change nothing', () => {
    const draft: MetadataDraft = defaultMetadata(input('Lantern Harbor', 'Arrival'));
    expect(mergeDefaults(draft, defaultMetadata(input('Lantern Harbor', 'Arrival')))).toBe(draft);
  });
});
