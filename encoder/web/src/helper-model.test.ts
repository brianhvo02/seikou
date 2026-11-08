// SPDX-License-Identifier: LGPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import type { EpisodesAnswer, ReleaseAnswer, SessionInfo, SingleReleaseRecord, TitleHit } from './api-types';
import {
  candidatesFor,
  canEnter,
  episodeFile,
  fromRecord,
  initialState,
  metadataDefaults,
  reduce,
  releaseOf,
  toRecord,
  type HelperAction,
  type HelperState,
} from './helper-model';
import { defaultMetadata, withUserEdit } from './metadata/metadata-model';

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

const track = (file: string, id: string, name: string, kind: 'full' | 'signs', key = 'tosho-7') => ({
  id,
  name,
  language: 'eng',
  path: `releases/${key}/${file}-${id}.ass`,
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

/** A second release whose file ids are the same as `release`'s, with its own tracks and fonts. */
const releaseB: ReleaseAnswer = {
  key: 'tosho-8',
  source: 'tosho',
  label: '[GroupB] Lantern Harbor (BD 1080p)',
  group: 'GroupB',
  files: [
    { id: '11', name: '[GroupB] Lantern Harbor - 01.mkv', tracks: [track('11', 't1', 'English', 'full', 'tosho-8')] },
    { id: '12', name: '[GroupB] Lantern Harbor - 02.mkv', tracks: [track('12', 't1', 'English', 'full', 'tosho-8')] },
  ],
  fonts: [{ name: 'Beacon.ttf', path: 'fonts/def.ttf' }],
  match: {
    rows: [
      { episode: 1, fileId: '11', candidates: ['11'] },
      { episode: 2, fileId: '12', candidates: ['12'] },
    ],
    unmatched: [],
  },
};

/** The user's own files, matched to episode 2 only. */
const own: ReleaseAnswer = {
  key: `local-${'c'.repeat(16)}`,
  source: 'local',
  label: 'Your files',
  group: '',
  files: [{ id: 'harbor-02.ass', name: 'harbor-02.ass', tracks: [track('harbor-02', '0', 'harbor-02', 'full', `local-${'c'.repeat(16)}`)] }],
  fonts: [],
  match: {
    rows: [
      { episode: 1, fileId: null, candidates: [] },
      { episode: 2, fileId: 'harbor-02.ass', candidates: ['harbor-02.ass'] },
    ],
    unmatched: [],
  },
};

function withRelease(): HelperState {
  return run(initialState(), { type: 'setTitle', title }, { type: 'addRelease', release, from: 'seadex' });
}

/** Release A (from SeaDex) for episode 1 and release B (from a search) for episode 2. */
function twoReleases(): HelperState {
  return run(withRelease(), { type: 'addRelease', release: releaseB, from: 'tosho' }, { type: 'chooseFile', episode: 2, releaseKey: 'tosho-8', fileId: '12' });
}

describe('reduce', () => {
  it('a release ticks every track of each matched file', () => {
    expect(withRelease().choices).toEqual({ 1: { releaseKey: 'tosho-7', fileId: '11', trackIds: ['t1', 't2'] }, 2: { releaseKey: 'tosho-7', fileId: '12', trackIds: ['t1'] } });
    expect(withRelease().releases).toEqual([{ release, source: 'seadex' }]);
  });

  it('adding a release fills only episodes without a file', () => {
    const before = run(initialState(), { type: 'addRelease', release: own, from: 'local' }, { type: 'setTiming', episode: 2, alignment: { kind: 'original' } });
    const after = reduce(before, { type: 'addRelease', release: releaseB, from: 'tosho' });
    expect(after.releases.map((p) => [p.release.key, p.source])).toEqual([
      [own.key, 'local'],
      ['tosho-8', 'tosho'],
    ]);
    expect(after.choices[1]).toEqual({ releaseKey: 'tosho-8', fileId: '11', trackIds: ['t1'] });
    expect(after.choices[2]).toEqual({ releaseKey: own.key, fileId: 'harbor-02.ass', trackIds: ['0'] });
    expect(after.timing[2]).toEqual(before.timing[2]);
    expect(after.dirty).toBe(true);
    // an episode marked as having no subtitles keeps that
    const none = run(before, { type: 'markNone', episode: 1 }, { type: 'addRelease', release: releaseB, from: 'tosho' });
    expect(none.choices[1]).toBe('none');
  });

  it('re-adding a release keeps choices whose file still matches', () => {
    const before = run(
      twoReleases(),
      { type: 'chooseTracks', episode: 1, trackIds: ['t2'] },
      { type: 'setTiming', episode: 1, alignment: { kind: 'offset', offsetMs: 1200, confidence: 0.9 } },
    );
    const after = reduce(before, { type: 'addRelease', release, from: 'seadex' });
    expect(after.releases.map((p) => p.release.key)).toEqual(['tosho-7', 'tosho-8']);
    expect(after.choices).toEqual(before.choices);
    expect(after.timing).toEqual(before.timing);
  });

  it('an offset change keeps a choice only when the file still matches', () => {
    const before = run(
      withRelease(),
      { type: 'chooseFile', episode: 2, releaseKey: 'tosho-7', fileId: '13' },
      { type: 'setTiming', episode: 1, alignment: { kind: 'offset', offsetMs: 1200, confidence: 0.9 } },
      { type: 'setTiming', episode: 2, alignment: { kind: 'offset', offsetMs: 800, confidence: 0.9 } },
      { type: 'setOffset', offset: 1 },
    );
    // at offset 1 the disc's episode 1 is the release's 02, and the release's 01 is outside the run
    const shifted: ReleaseAnswer = {
      ...release,
      match: {
        rows: [
          { episode: 1, fileId: '12', candidates: ['12'] },
          { episode: 2, fileId: null, candidates: [] },
        ],
        unmatched: [release.files[0]!, release.files[2]!],
      },
    };
    const after = reduce(before, { type: 'addRelease', release: shifted, from: 'seadex' });
    expect(after.episodeOffset).toBe(1);
    // episode 1's file 01 no longer matches it: it falls back to the release's match, and its timing goes
    expect(after.choices[1]).toEqual({ releaseKey: 'tosho-7', fileId: '12', trackIds: ['t1'] });
    expect(after.timing[1]).toBeUndefined();
    // episode 2's NCOP was never numbered, so the offset does not change whether it fits
    expect(after.choices[2]).toEqual({ releaseKey: 'tosho-7', fileId: '13', trackIds: ['t1'] });
    expect(after.timing[2]).toEqual(before.timing[2]);
  });

  it('fillFromPool gives an episode without a file the first matched file in pool order, and leaves the rest', () => {
    // B alone numbers episode 2, A alone episode 1; episode 1 has no file and A is first in the pool
    const onlyOne: ReleaseAnswer = { ...releaseB, match: { rows: [{ episode: 1, fileId: '11', candidates: ['11'] }, { episode: 2, fileId: null, candidates: [] }], unmatched: [] } };
    const pool: HelperState = {
      ...initialState(),
      releases: [
        { release: onlyOne, source: 'tosho' },
        { release, source: 'seadex' },
      ],
      choices: { 2: { releaseKey: 'tosho-7', fileId: '13', trackIds: ['t1'] } },
    };
    const after = reduce(pool, { type: 'fillFromPool' });
    expect(after.choices[1]).toEqual({ releaseKey: 'tosho-8', fileId: '11', trackIds: ['t1'] });
    expect(after.choices[2]).toEqual(pool.choices[2]);
    expect(after.dirty).toBe(true);
    // marked none stays none; a pool with nothing to give changes nothing
    const none = reduce({ ...pool, choices: { ...pool.choices, 1: 'none' } }, { type: 'fillFromPool' });
    expect(none.choices[1]).toBe('none');
    expect(reduce(after, { type: 'fillFromPool' })).toBe(after);
  });

  it('removing a release clears the episodes that used it', () => {
    const filled = fill0(run(twoReleases(), { type: 'setTiming', episode: 2, alignment: { kind: 'original' } }));
    expect(filled.metadata.episodes[2]!.tracks).toHaveLength(1);
    const after = fill0(reduce(filled, { type: 'removeRelease', key: 'tosho-8' }));
    expect(after.releases.map((p) => p.release.key)).toEqual(['tosho-7']);
    expect(after.choices[1]).toEqual(filled.choices[1]);
    expect(after.choices[2]).toBeUndefined();
    expect(after.timing[2]).toBeUndefined();
    expect(after.metadata.episodes[2]!.tracks).toEqual([]);
    expect(after.metadata.episodes[1]!.tracks).toEqual(filled.metadata.episodes[1]!.tracks);
    // removing the last release closes step 2
    const empty = run({ ...after, step: 2 }, { type: 'removeRelease', key: 'tosho-7' });
    expect(empty.releases).toEqual([]);
    expect(empty.step).toBe(1);
  });

  it('two releases with the same file id stay apart', () => {
    const a: ReleaseAnswer = { ...release, files: [{ id: '7101', name: 'A - 01.mkv', tracks: [track('7101', 't1', 'English', 'full')] }], match: { rows: [{ episode: 1, fileId: '7101', candidates: ['7101'] }], unmatched: [] } };
    const b: ReleaseAnswer = { ...releaseB, files: [{ id: '7101', name: 'B - 01.mkv', tracks: [track('7101', 't1', 'English', 'full', 'tosho-8')] }], match: { rows: [{ episode: 1, fileId: '7101', candidates: ['7101'] }], unmatched: [] } };
    const pooled = run(initialState(), { type: 'addRelease', release: a, from: 'tosho' }, { type: 'addRelease', release: b, from: 'tosho' });
    expect(episodeFile(pooled, 1)?.file.name).toBe('A - 01.mkv');
    const after = reduce(pooled, { type: 'chooseFile', episode: 1, releaseKey: 'tosho-8', fileId: '7101' });
    const found = episodeFile(after, 1);
    expect(found?.pooled.release.key).toBe('tosho-8');
    expect(found?.file.name).toBe('B - 01.mkv');
    expect(found?.file.tracks[0]!.path).toBe('releases/tosho-8/7101-t1.ass');
    expect(toRecord(after, session, episodes).episodes[0]!.tracks.map((t) => [t.file, t.release])).toEqual([['releases/tosho-8/7101-t1.ass', 'tosho-8']]);
  });

  it('a file or release not in the pool changes nothing', () => {
    const before = withRelease();
    expect(reduce(before, { type: 'chooseFile', episode: 1, releaseKey: 'tosho-8', fileId: '11' })).toBe(before);
    expect(reduce(before, { type: 'removeRelease', key: 'tosho-8' })).toBe(before);
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
    const after = run(withRelease(), { type: 'setTiming', episode: 1, alignment: { kind: 'original' } }, { type: 'chooseFile', episode: 1, releaseKey: 'tosho-7', fileId: '13' });
    expect(after.choices[1]).toEqual({ releaseKey: 'tosho-7', fileId: '13', trackIds: ['t1'] });
    expect(after.timing[1]).toBeUndefined();
    const cleared = reduce(after, { type: 'chooseFile', episode: 1, releaseKey: null, fileId: null });
    expect(cleared.choices[1]).toBeUndefined();
  });

  it('a show change drops SeaDex releases and keeps Tosho and own files', () => {
    const base = fill0(run(twoReleases(), { type: 'addRelease', release: own, from: 'local' }, { type: 'setTiming', episode: 1, alignment: { kind: 'original' } }));
    const after = fill0(reduce(base, { type: 'setTitle', title: { ...title, alId: 900102 } }));
    expect(after.releases.map((p) => [p.release.key, p.source])).toEqual([
      ['tosho-8', 'tosho'],
      [own.key, 'local'],
    ]);
    expect(after.choices[1]).toBeUndefined();
    expect(after.timing[1]).toBeUndefined();
    expect(after.metadata.episodes[1]!.tracks).toEqual([]);
    expect(after.choices[2]).toEqual(base.choices[2]);
    // clearing the show keeps the rest
    expect(reduce(after, { type: 'setTitle', title: null }).releases).toEqual(after.releases);
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

describe('the pool', () => {
  it('releaseOf finds a pooled release by key', () => {
    const state = twoReleases();
    expect(releaseOf(state, 'tosho-8')?.source).toBe('tosho');
    expect(releaseOf(state, 'tosho-9')).toBeNull();
  });

  it("candidatesFor lists each release's matched files, then its unmatched ones, in pool order", () => {
    expect(candidatesFor(twoReleases(), 1)).toEqual([
      { releaseKey: 'tosho-7', fileId: '11', matched: true },
      { releaseKey: 'tosho-7', fileId: '13', matched: false },
      { releaseKey: 'tosho-8', fileId: '11', matched: true },
    ]);
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

  it('step 3 needs an episode with a choice: a chosen file that has tracks, or "No subtitles"', () => {
    const empty = { ...withRelease(), choices: {} };
    expect(canEnter(empty, 3)).toBe(false);
    expect(canEnter({ ...empty, choices: { 2: 'none' } }, 3)).toBe(true);
    expect(canEnter({ ...empty, choices: { 1: { releaseKey: 'tosho-9', fileId: '11', trackIds: ['t1'] } } }, 3)).toBe(false);
    expect(canEnter({ ...empty, choices: { 1: { releaseKey: 'tosho-7', fileId: '11', trackIds: [] } } }, 3)).toBe(true);
    expect(canEnter(withRelease(), 3)).toBe(true);
  });

  it('a run where every episode is "No subtitles" reaches step 3', () => {
    const state = run(withRelease(), { type: 'markNone', episode: 1 }, { type: 'markNone', episode: 2 }, { type: 'goTo', step: 3 });
    expect(state.step).toBe(3);
  });

  it('skipping the last episode with a file on step 3 stays on step 3', () => {
    const state = run({ ...withRelease(), step: 3 }, { type: 'skip', episode: 1 }, { type: 'skip', episode: 2 });
    expect(state.step).toBe(3);
  });

  it('removing the last release closes steps 2 and 3 and the state falls back to step 1', () => {
    const emptied = reduce({ ...withRelease(), step: 3 }, { type: 'removeRelease', key: 'tosho-7' });
    expect(canEnter(emptied, 2)).toBe(false);
    expect(canEnter(emptied, 3)).toBe(false);
    expect(emptied.step).toBe(1);
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
    expect(record.releases).toEqual([{ source: 'seadex', id: 'tosho-7', group: 'GroupA', label: release.label }]);
    expect(record.fonts).toEqual(['fonts/abc.ttf']);
    expect(record.episodes[0]!.title).toBe('Arrival');
    expect(record.episodes[0]!.tracks).toEqual([
      { file: 'releases/tosho-7/11-t2.ass', release: 'tosho-7', kind: 'signs', language: 'eng', name: 'Songs only', shiftMs: 1200, nudgeMs: 42, split: null, included: true },
      { file: 'releases/tosho-7/11-t1.ass', release: 'tosho-7', kind: 'full', language: 'eng', name: 'GroupA full', shiftMs: 1200, nudgeMs: 42, split: null, included: false },
    ]);
    expect(record.episodes[1]!.tracks[0]!.split).toEqual([{ fromMs: 0, offsetMs: 1000 }, { fromMs: 30_000, offsetMs: 500 }]);
    expect(record.episodes[1]!.tracks[0]!.shiftMs).toBe(0);

    const restored = fromRecord(record, [release]);
    expect(restored.title?.alId).toBe(900101);
    expect(restored.releases).toEqual([{ release, source: 'seadex' }]);
    expect(restored.choices).toEqual(state.choices);
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
    expect(bare.releases).toEqual([]);
    expect(bare.fonts).toEqual([]);
    expect(bare.anilist).toBeNull();
    expect(bare.episodes.map((e) => e.title)).toEqual(['Episode 1', 'Episode 2']);
    expect(bare.episodes[0]!.metadata.audio).toEqual([{ pid: 0x1100, name: 'Japanese', language: 'jpn', included: true }]);
  });

  it('an episode with no title is named by its number with the episode offset, as its MKV title is', () => {
    const shifted = reduce(run(initialState(), { type: 'setTitle', title }), { type: 'setOffset', offset: 12 });
    const record = toRecord(shifted, session, episodes);
    expect(record.episodes.map((e) => e.title)).toEqual(['Episode 13', 'Episode 14']);
    expect(record.episodes[0]!.metadata.title).toBe('Lantern Harbor - 13');
    const restored = fromRecord(record, [], episodes);
    expect(restored.metadata.episodes[1]!.episodeTitle).toBe('');
    expect(restored.metadata.edited.size).toBe(0);
  });

  it('fromRecord without its release keeps the metadata and timings', () => {
    const record = toRecord(fullState(), session, episodes);
    const restored = fromRecord(record);
    expect(restored.releases).toEqual([]);
    expect(restored.choices).toEqual({});
    expect(restored.timing[1]!.nudgeMs).toBe(42);
    expect(restored.metadata.episodes[1]!.tracks[0]!.name).toBe('Songs only');
  });

  it("toRecord writes only used releases with each track's release", () => {
    // the pool is A, B, own files; episode 1 uses B and episode 2 uses A, and nothing uses the own files
    const state = run(
      withRelease(),
      { type: 'addRelease', release: releaseB, from: 'tosho' },
      { type: 'addRelease', release: own, from: 'local' },
      { type: 'chooseFile', episode: 1, releaseKey: 'tosho-8', fileId: '11' },
    );
    const record = toRecord(state, session, episodes);
    expect(record.releases).toEqual([
      { source: 'seadex', id: 'tosho-7', group: 'GroupA', label: release.label },
      { source: 'tosho', id: 'tosho-8', group: 'GroupB', label: releaseB.label },
    ]);
    expect(record.fonts).toEqual(['fonts/abc.ttf', 'fonts/def.ttf']);
    expect(record.episodes[0]!.tracks.map((t) => [t.file, t.release, t.name])).toEqual([['releases/tosho-8/11-t1.ass', 'tosho-8', 'GroupB full']]);
    expect(record.episodes[1]!.tracks.map((t) => [t.file, t.release, t.name])).toEqual([['releases/tosho-7/12-t1.ass', 'tosho-7', 'GroupA full']]);
    // every episode marked none uses no release
    expect(toRecord(run(state, { type: 'markNone', episode: 1 }, { type: 'markNone', episode: 2 }), session, episodes).releases).toEqual([]);
  });

  it('fromRecord restores per-release choices', () => {
    const state = run(twoReleases(), { type: 'setTiming', episode: 2, alignment: { kind: 'offset', offsetMs: 500, confidence: 0.9 } });
    const record = toRecord(state, session, episodes);
    // the answers may come in any order; the pool follows the record
    const restored = fromRecord(record, [releaseB, release], episodes);
    expect(restored.releases).toEqual([
      { release, source: 'seadex' },
      { release: releaseB, source: 'tosho' },
    ]);
    expect(restored.choices).toEqual(state.choices);
    expect(restored.metadata.edited.size).toBe(0);
    expect(toRecord(restored, session, episodes)).toEqual(record);
    // with B gone, episode 2 has nothing chosen and keeps its saved tracks in the draft
    const partly = fill0(fromRecord(record, [release], episodes));
    expect(partly.releases.map((p) => p.release.key)).toEqual(['tosho-7']);
    expect(partly.choices[1]).toEqual(state.choices[1]);
    expect(partly.choices[2]).toBeUndefined();
    expect(partly.timing[2]!.alignment).toEqual({ kind: 'offset', offsetMs: 500, confidence: 1 });
    expect(partly.metadata.episodes[2]!.tracks.map((t) => [t.key, t.name])).toEqual([['releases/tosho-8/12-t1.ass', 'GroupB full']]);
  });

  it('fromRecord reads the single-release form', () => {
    const current = toRecord(fullState(), session, episodes);
    const { releases, ...rest } = current;
    const old: SingleReleaseRecord = {
      ...rest,
      release: releases[0]!,
      episodes: current.episodes.map((e) => ({ ...e, tracks: e.tracks.map(({ release: _, ...t }) => t) })),
    };
    const restored = fromRecord(old, [release], episodes);
    expect(restored.releases).toEqual([{ release, source: 'seadex' }]);
    expect(restored.choices).toEqual(fullState().choices);
    expect(fromRecord({ ...old, release: null }, [release], episodes).releases).toEqual([]);
  });
});

describe('restoreRelease', () => {
  const saved = (): HelperState => {
    const two = twoReleases();
    const withMeta = run(two, { type: 'fillDefaults', defaults: metadataDefaults(two, episodes, null) });
    return run(
      withMeta,
      { type: 'chooseTracks', episode: 1, trackIds: ['t1'] },
      { type: 'setTiming', episode: 1, alignment: { kind: 'offset', offsetMs: 1200, confidence: 0.9 } },
      { type: 'nudge', episode: 1, deltaMs: 42 },
    );
  };

  it('puts the release back and restores only the episodes that use it', () => {
    const before = saved();
    const record = toRecord(before, session, episodes);
    // the page restored without release A, and the user has since changed episode 2 and added their own files
    const current = run(
      fromRecord(record, [releaseB], episodes),
      { type: 'markNone', episode: 2 },
      { type: 'addRelease', release: own, from: 'local' },
    );
    expect(current.choices[1]).toBeUndefined();
    const after = reduce(current, { type: 'restoreRelease', record, release, disc: episodes });
    expect(after.releases.map((p) => p.release.key)).toEqual(['tosho-8', own.key, 'tosho-7']);
    expect(after.releases[2]!.source).toBe('seadex');
    expect(after.choices[1]).toEqual(before.choices[1]);
    expect(after.timing[1]).toEqual({ alignment: { kind: 'offset', offsetMs: 1200, confidence: 1 }, nudgeMs: 42, accepted: true });
    expect(after.choices[2]).toBe('none');
    expect(after.timing[2]).toBe(current.timing[2]);
    expect(after.metadata.episodes[1]!.tracks.map((t) => t.key)).toEqual(record.episodes[0]!.tracks.map((t) => t.file));
    expect(after.dirty).toBe(true);
  });

  it('keeps a pick the user made while the release was missing', () => {
    const record = toRecord(saved(), session, episodes);
    const current = run(fromRecord(record, [releaseB], episodes), { type: 'chooseFile', episode: 1, releaseKey: 'tosho-8', fileId: '11' });
    const after = reduce(current, { type: 'restoreRelease', record, release, disc: episodes });
    expect(after.choices[1]).toEqual(current.choices[1]);
    expect(after.timing[1]).toBe(current.timing[1]);
    expect(after.metadata.episodes[1]).toBe(current.metadata.episodes[1]);
  });

  it('keeps what an episode had when its saved tracks are not in the fetched release', () => {
    const record = toRecord(saved(), session, episodes);
    const current = fromRecord(record, [releaseB], episodes);
    const changed: ReleaseAnswer = { ...release, files: [{ id: '99', name: 'other.mkv', tracks: [] }], match: { rows: [], unmatched: [] } };
    const after = reduce(current, { type: 'restoreRelease', record, release: changed, disc: episodes });
    expect(after.choices[1]).toBeUndefined();
    expect(after.choices[2]).toEqual(current.choices[2]);
  });
});

describe('metadata defaults', () => {
  const fill = (state: HelperState, titles: Record<number, string> | null = null): HelperState =>
    reduce(state, { type: 'fillDefaults', defaults: metadataDefaults(state, episodes, titles) });

  it('a draft made before the show takes the show and episode titles once they arrive', () => {
    const start = fill(initialState());
    expect(start.metadata.episodes[1]!.title).toBe('01');
    expect(start.dirty).toBe(false);
    const typed = reduce(start, { type: 'setMetadata', metadata: withUserEdit(start.metadata, 'episodes.2.title', 'Bonus cut') });
    const picked = fill(reduce(typed, { type: 'setTitle', title }));
    expect(picked.metadata.episodes[1]!.title).toBe('Lantern Harbor - 01');
    const titled = fill(picked, { 1: 'Arrival', 2: 'The Lighthouse' });
    expect(titled.metadata.episodes[1]!.title).toBe('Lantern Harbor - 01 - Arrival');
    expect(titled.metadata.episodes[2]!.title).toBe('Bonus cut');
    expect(toRecord(titled, session, episodes).episodes[0]!.title).toBe('Arrival');
  });

  it('filling the defaults does not mark the state dirty', () => {
    const clean = { ...reduce(initialState(), { type: 'setTitle', title }), dirty: false };
    expect(fill(clean, { 1: 'Arrival' }).dirty).toBe(false);
  });

  it('a release fills each episode with its chosen tracks', () => {
    const state = fill(withRelease());
    expect(state.metadata.episodes[1]!.tracks.map((t) => [t.key, t.name])).toEqual([
      ['releases/tosho-7/11-t1.ass', 'GroupA full'],
      ['releases/tosho-7/11-t2.ass', 'GroupA signs'],
    ]);
    const fewer = fill(reduce(state, { type: 'chooseTracks', episode: 1, trackIds: ['t2'] }));
    expect(fewer.metadata.episodes[1]!.tracks.map((t) => t.key)).toEqual(['releases/tosho-7/11-t2.ass']);
  });

  it('with an episode offset the titles and numbers are the release ones', () => {
    const shifted = fill(reduce(reduce(initialState(), { type: 'setTitle', title }), { type: 'setOffset', offset: 12 }), { 1: 'Arrival', 13: 'Tide Line' });
    expect(shifted.metadata.episodes[1]!.title).toBe('Lantern Harbor - 13 - Tide Line');
    expect(shifted.metadata.episodes[2]!.title).toBe('Lantern Harbor - 14');
    const record = toRecord(shifted, session, episodes);
    expect(record.episodes[0]!.title).toBe('Tide Line');
    const restored = fromRecord(record, [], episodes);
    expect(restored.metadata.edited.size).toBe(0);
  });

  it("subtitle default names follow each episode's release group", () => {
    const state = fill(twoReleases());
    expect(state.metadata.episodes[1]!.tracks.map((t) => t.name)).toEqual(['GroupA full', 'GroupA signs']);
    expect(state.metadata.episodes[2]!.tracks.map((t) => t.name)).toEqual(['GroupB full']);
    const mine = fill(run(twoReleases(), { type: 'addRelease', release: own, from: 'local' }, { type: 'chooseFile', episode: 2, releaseKey: own.key, fileId: 'harbor-02.ass' }));
    expect(mine.metadata.episodes[2]!.tracks.map((t) => t.name)).toEqual(['full']);
  });

  it('a restored record without its release keeps its track list through filling the defaults', () => {
    const record = toRecord(fullState(), session, episodes);
    const restored = fill(fromRecord(record, [], episodes));
    expect(restored.metadata.episodes[1]!.tracks.map((t) => t.name)).toEqual(['Songs only', 'GroupA full']);
    expect(restored.metadata.episodes[2]!.tracks).toHaveLength(1);
  });

  it('toRecord writes a language that is not three letters as und', () => {
    const state = fill(withRelease());
    let metadata = withUserEdit(state.metadata, 'episodes.1.video.language', 'jp');
    metadata = withUserEdit(metadata, 'episodes.1.audio.0.language', 'JA');
    metadata = withUserEdit(metadata, 'episodes.1.tracks.0.language', 'e');
    const record = toRecord(reduce(state, { type: 'setMetadata', metadata }), session, episodes);
    const ep = record.episodes[0]!;
    expect(ep.metadata.video.language).toBe('und');
    expect(ep.metadata.audio[0]!.language).toBe('und');
    expect(ep.tracks[0]!.language).toBe('und');
  });

  it('without titles known it keeps the episode titles the draft has', () => {
    const restored = fromRecord(toRecord(fullState(), session, episodes), [release], episodes);
    expect(fill(restored).metadata.episodes[1]!.episodeTitle).toBe('Arrival');
  });
});

describe('fromRecord marks only what differs from the defaults', () => {
  it('a restored record still takes new defaults where the user changed nothing', () => {
    const saved = fill0(reduce(withRelease(), { type: 'setTitle', title }));
    const record = toRecord(saved, session, episodes);
    expect(record.episodes[0]!.metadata.title).toBe('Lantern Harbor - 01');
    const restored = fromRecord(record, [release], episodes);
    expect(restored.metadata.edited.size).toBe(0);
    const titled = reduce(restored, { type: 'fillDefaults', defaults: metadataDefaults(restored, episodes, { 1: 'Arrival' }) });
    expect(titled.metadata.episodes[1]!.title).toBe('Lantern Harbor - 01 - Arrival');
  });

  it('marks the fields the user changed', () => {
    const restored = fromRecord(toRecord(fullState(), session, episodes), [release], episodes);
    expect([...restored.metadata.edited]).toEqual(['episodes.1.tracks']);
  });

  it('leaves an episode whose saved tracks are gone from the release unresolved', () => {
    const record = toRecord(reduce(withRelease(), { type: 'markNone', episode: 2 }), session, episodes);
    const other: ReleaseAnswer = { ...release, files: release.files.map((f) => (f.id === '11' ? { ...f, tracks: [] } : f)) };
    const restored = fromRecord(record, [other], episodes);
    expect(restored.choices[1]).toBeUndefined();
    expect(restored.choices[2]).toBe('none');
  });
});

function fill0(state: HelperState): HelperState {
  return reduce(state, { type: 'fillDefaults', defaults: metadataDefaults(state, episodes, null) });
}
