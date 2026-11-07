// SPDX-License-Identifier: LGPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import type { EpisodesAnswer, ReleaseAnswer, SessionInfo, TitleHit } from './api-types';
import { canEnter, fromRecord, initialState, reduce, toRecord, type HelperAction, type HelperState } from './helper-model';
import { defaultMetadata } from './metadata/metadata-model';

const session: SessionInfo = { discKey: `f.${'a'.repeat(32)}`, label: 'LANTERN_HARBOR_D1', playlistId: '00000', episodeSpec: '1-3,4-5', toolsReady: true };

const episodes: EpisodesAnswer = {
  episodes: [
    { index: 1, startUs: 0, durationUs: 60_000_000, chapters: [{ startUs: 0 }, { startUs: 20_000_000 }, { startUs: 40_000_000 }] },
    { index: 2, startUs: 60_000_000, durationUs: 40_000_000, chapters: [{ startUs: 60_000_000 }, { startUs: 80_000_000 }] },
  ],
  audio: [{ pid: 0x1100, codingType: 0x80, language: 'jpn' }],
  pgCount: 0,
};

const title: TitleHit = { alId: 900101, title: 'Lantern Harbor', nativeTitle: null, year: 2024, format: 'TV', episodes: 12, poster: null };

const track = (file: string, id: string, name: string, kind: 'full' | 'signs') => ({
  id,
  name,
  language: 'eng',
  path: `releases/tosho-7/${file}-${id}.ass`,
  kind,
  dialogueLines: 100,
});

const release: ReleaseAnswer = {
  key: 'tosho-7',
  source: 'tosho',
  label: '[GroupA] Lantern Harbor (BD 1080p)',
  group: 'GroupA',
  files: [
    { id: '11', name: '[GroupA] Lantern Harbor - 01.mkv', tracks: [track('11', 't1', 'English', 'full'), track('11', 't2', 'Signs', 'signs')] },
    { id: '12', name: '[GroupA] Lantern Harbor - 02.mkv', tracks: [track('12', 't1', 'English', 'full')] },
    { id: '13', name: '[GroupA] Lantern Harbor - NCOP.mkv', tracks: [track('13', 't1', 'English', 'full')] },
  ],
  fonts: [{ name: 'Harbor.ttf', path: 'fonts/abc.ttf' }],
  match: {
    rows: [
      { episode: 1, fileId: '11', candidates: ['11'] },
      { episode: 2, fileId: '12', candidates: ['12'] },
    ],
    unmatched: [],
  },
};

function run(state: HelperState, ...actions: HelperAction[]): HelperState {
  return actions.reduce(reduce, state);
}

function withRelease(): HelperState {
  return run(initialState(), { type: 'setTitle', title }, { type: 'setRelease', release, from: 'seadex' });
}

describe('reduce', () => {
  it('picking a release resets matches and timings', () => {
    const before = run(withRelease(), { type: 'setTiming', episode: 1, alignment: { kind: 'offset', offsetMs: 1200, confidence: 0.9 } }, { type: 'markNone', episode: 2 });
    const other: ReleaseAnswer = { ...release, key: 'tosho-8', match: { rows: [{ episode: 1, fileId: null, candidates: [] }, { episode: 2, fileId: '12', candidates: ['12'] }], unmatched: [] } };
    const after = reduce(before, { type: 'setRelease', release: other, from: 'tosho' });
    expect(after.release?.key).toBe('tosho-8');
    expect(after.releaseSource).toBe('tosho');
    expect(after.match).toEqual(other.match.rows);
    expect(after.timing).toEqual({});
    expect(after.choices).toEqual({ 2: { trackIds: ['t1'] } });
    expect(after.dirty).toBe(true);
  });

  it('a release ticks every track of each matched file', () => {
    expect(withRelease().choices).toEqual({ 1: { trackIds: ['t1', 't2'] }, 2: { trackIds: ['t1'] } });
  });

  it('nudge accumulates and marks dirty', () => {
    const start = { ...run(withRelease(), { type: 'setTiming', episode: 1, alignment: { kind: 'offset', offsetMs: 1200, confidence: 0.9 } }), dirty: false };
    const after = run(start, { type: 'nudge', episode: 1, deltaMs: 42 }, { type: 'nudge', episode: 1, deltaMs: 42 }, { type: 'nudge', episode: 1, deltaMs: -10 });
    expect(after.timing[1]!.nudgeMs).toBe(74);
    expect(after.timing[1]!.alignment).toEqual({ kind: 'offset', offsetMs: 1200, confidence: 0.9 });
    expect(after.dirty).toBe(true);
  });

  it('nudging an episode not yet lined up keeps its original timing', () => {
    const after = reduce(withRelease(), { type: 'nudge', episode: 2, deltaMs: 42 });
    expect(after.timing[2]).toEqual({ alignment: { kind: 'original' }, nudgeMs: 42, accepted: false });
  });

  it('marking an episode none clears its tracks', () => {
    const after = run(withRelease(), { type: 'setTiming', episode: 1, alignment: { kind: 'original' } }, { type: 'markNone', episode: 1 });
    expect(after.choices[1]).toBe('none');
    expect(after.timing[1]).toBeUndefined();
  });

  it('choosing another file resets the episode to that file and its tracks', () => {
    const after = run(withRelease(), { type: 'setTiming', episode: 1, alignment: { kind: 'original' } }, { type: 'chooseFile', episode: 1, fileId: '13' });
    expect(after.match[0]).toEqual({ episode: 1, fileId: '13', candidates: ['11'] });
    expect(after.choices[1]).toEqual({ trackIds: ['t1'] });
    expect(after.timing[1]).toBeUndefined();
  });

  it('changing the show drops the release', () => {
    const after = reduce(withRelease(), { type: 'setTitle', title: { ...title, alId: 900102 } });
    expect(after.release).toBeNull();
    expect(after.match).toEqual([]);
    expect(after.choices).toEqual({});
  });

  it('use original keeps the nudge, and accept marks it accepted', () => {
    const after = run(
      withRelease(),
      { type: 'setTiming', episode: 1, alignment: { kind: 'offset', offsetMs: 1200, confidence: 0.9 } },
      { type: 'nudge', episode: 1, deltaMs: 42 },
      { type: 'useOriginal', episode: 1 },
      { type: 'accept', episode: 1 },
    );
    expect(after.timing[1]).toEqual({ alignment: { kind: 'original' }, nudgeMs: 42, accepted: true });
  });

  it('moving between steps does not mark the state dirty', () => {
    const after = reduce({ ...withRelease(), dirty: false }, { type: 'goTo', step: 2 });
    expect(after.step).toBe(2);
    expect(after.dirty).toBe(false);
  });

  it('refuses a step it cannot enter', () => {
    expect(reduce(initialState(), { type: 'goTo', step: 3 }).step).toBe(1);
  });
});

describe('canEnter', () => {
  it('step 1 is always open', () => {
    expect(canEnter(initialState(), 1)).toBe(true);
  });

  it('step 2 needs a release', () => {
    expect(canEnter(initialState(), 2)).toBe(false);
    expect(canEnter(withRelease(), 2)).toBe(true);
  });

  it('step 3 needs an episode with tracks or marked none', () => {
    const empty = { ...withRelease(), choices: {} };
    expect(canEnter(empty, 3)).toBe(false);
    expect(canEnter({ ...empty, choices: { 1: { trackIds: [] } } }, 3)).toBe(false);
    expect(canEnter({ ...empty, choices: { 2: 'none' } }, 3)).toBe(true);
    expect(canEnter(withRelease(), 3)).toBe(true);
  });
});

function fullState(): HelperState {
  const metadata = defaultMetadata({
    show: 'Lantern Harbor',
    episodes: [
      { index: 1, title: 'Arrival', chapterCount: 3 },
      { index: 2, title: 'The Lighthouse', chapterCount: 2 },
    ],
    audio: [{ pid: 0x1100, language: 'jpn' }],
    tracks: {
      1: [
        { name: 'English', kind: 'full', language: 'eng', group: 'GroupA', key: 'releases/tosho-7/11-t1.ass' },
        { name: 'Signs', kind: 'signs', language: 'eng', group: 'GroupA', key: 'releases/tosho-7/11-t2.ass' },
      ],
      2: [{ name: 'English', kind: 'full', language: 'eng', group: 'GroupA', key: 'releases/tosho-7/12-t1.ass' }],
    },
  });
  const ep1 = metadata.episodes[1]!;
  const edited = {
    ...metadata,
    episodes: {
      ...metadata.episodes,
      1: { ...ep1, tracks: [{ ...ep1.tracks[1]!, name: 'Songs only' }, { ...ep1.tracks[0]!, included: false }] },
    },
    edited: new Set(['episodes.1.tracks']),
  };
  return run(
    withRelease(),
    { type: 'setOffset', offset: 0 },
    { type: 'setMetadata', metadata: edited },
    { type: 'setTiming', episode: 1, alignment: { kind: 'offset', offsetMs: 1200, confidence: 0.9 } },
    { type: 'nudge', episode: 1, deltaMs: 42 },
    { type: 'accept', episode: 1 },
    { type: 'setTiming', episode: 2, alignment: { kind: 'split', parts: [{ fromMs: 0, offsetMs: 1000 }, { fromMs: 30_000, offsetMs: 500 }], confidence: 0.8 } },
  );
}

describe('toRecord and fromRecord', () => {
  it('toRecord then fromRecord keeps choices, timings and metadata', () => {
    const state = fullState();
    const record = toRecord(state, session, episodes);
    expect(record.disc).toEqual({ key: session.discKey, label: session.label });
    expect(record.anilist).toEqual({ id: 900101, title: 'Lantern Harbor', episodeOffset: 0 });
    expect(record.release).toEqual({ source: 'seadex', id: 'tosho-7', group: 'GroupA', label: release.label });
    expect(record.fonts).toEqual(['fonts/abc.ttf']);
    expect(record.episodes[0]!.title).toBe('Arrival');
    expect(record.episodes[0]!.tracks).toEqual([
      { file: 'releases/tosho-7/11-t2.ass', kind: 'signs', language: 'eng', name: 'Songs only', shiftMs: 1200, nudgeMs: 42, split: null, included: true },
      { file: 'releases/tosho-7/11-t1.ass', kind: 'full', language: 'eng', name: 'GroupA full', shiftMs: 1200, nudgeMs: 42, split: null, included: false },
    ]);
    expect(record.episodes[1]!.tracks[0]!.split).toEqual([{ fromMs: 0, offsetMs: 1000 }, { fromMs: 30_000, offsetMs: 500 }]);
    expect(record.episodes[1]!.tracks[0]!.shiftMs).toBe(0);

    const restored = fromRecord(record, release);
    expect(restored.title?.alId).toBe(900101);
    expect(restored.release?.key).toBe('tosho-7');
    expect(restored.releaseSource).toBe('seadex');
    expect(restored.choices).toEqual(state.choices);
    expect(restored.match).toEqual(state.match);
    expect(restored.timing[1]).toEqual({ alignment: { kind: 'offset', offsetMs: 1200, confidence: 1 }, nudgeMs: 42, accepted: true });
    expect(restored.timing[2]!.alignment).toEqual({ kind: 'split', parts: [{ fromMs: 0, offsetMs: 1000 }, { fromMs: 30_000, offsetMs: 500 }], confidence: 1 });
    expect(restored.dirty).toBe(false);
    // the restored state saves the same record again
    expect(toRecord(restored, session, episodes).episodes).toEqual(record.episodes);
    expect(restored.metadata.episodes[1]!.tracks.map((t) => t.name)).toEqual(['Songs only', 'GroupA full']);
  });

  it('toRecord writes shiftMs 0 and split null for alignment none and original', () => {
    const state = run(
      withRelease(),
      { type: 'setTiming', episode: 1, alignment: { kind: 'none', reason: 'low-confidence' } },
      { type: 'nudge', episode: 1, deltaMs: -10 },
      { type: 'setTiming', episode: 2, alignment: { kind: 'original' } },
    );
    const record = toRecord(state, session, episodes);
    for (const t of record.episodes.flatMap((e) => e.tracks)) {
      expect(t.shiftMs).toBe(0);
      expect(t.split).toBeNull();
    }
    expect(record.episodes[0]!.tracks[0]!.nudgeMs).toBe(-10);
  });

  it('an episode marked none or without a release saves no tracks but its metadata', () => {
    const record = toRecord(reduce(withRelease(), { type: 'markNone', episode: 2 }), session, episodes);
    expect(record.episodes[1]!.tracks).toEqual([]);
    expect(record.episodes[1]!.metadata.chapters).toEqual(['Chapter 1', 'Chapter 2']);
    const bare = toRecord(initialState(), session, episodes);
    expect(bare.release).toBeNull();
    expect(bare.anilist).toBeNull();
    expect(bare.episodes.map((e) => e.title)).toEqual(['Episode 1', 'Episode 2']);
    expect(bare.episodes[0]!.metadata.audio).toEqual([{ pid: 0x1100, name: 'Japanese', language: 'jpn', included: true }]);
  });

  it('fromRecord without its release keeps the metadata and timings', () => {
    const record = toRecord(fullState(), session, episodes);
    const restored = fromRecord(record);
    expect(restored.release).toBeNull();
    expect(restored.choices).toEqual({});
    expect(restored.timing[1]!.nudgeMs).toBe(42);
    expect(restored.metadata.episodes[1]!.tracks[0]!.name).toBe('Songs only');
  });
});
