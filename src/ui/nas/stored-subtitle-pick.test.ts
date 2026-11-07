import { afterEach, describe, expect, it, vi } from 'vitest';
import type { FansubPick, FansubPickRequest, PlaceFansub, StoredSubtitle } from '@seikou/nas/nas-api';
import { NasHttpError } from './nas-client';
import { EPISODE_CHANGED, PICK_FAILED } from './tosho-search-model';
import type { SubtitleChoice, TextFileInfo } from '../../engine/protocol';
import { INITIAL_SNAPSHOT, type PlayerSnapshot } from '../../player/player-controller';
import { replacesTextSet, STORED_PICK_FAILED, StoredSubtitlePicker } from './stored-subtitle-pick';

const KEY = `f.${'B'.repeat(32)}`;
const settle = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

const episodeSub: StoredSubtitle = {
  id: 'sub-1', name: 'Fansub', language: 'en', offsetMs: 400, fileName: 'ep1.ass', fileSize: 120, fonts: [{ name: 'Made Up Sans.ttf', size: 50 }],
  attachment: { kind: 'episode', discKey: KEY, playlistId: '00001', titleId: 'anilist:1', seasonId: 's1', episode: 1 }, uploaderPersonId: 'p1', uploadedAt: 1,
};
const chapterSub: StoredSubtitle = { ...episodeSub, id: 'sub-2', offsetMs: 0, attachment: { kind: 'chapter', discKey: KEY, playlistId: '00001', chapter: 2 } };

const file = (name: string, offsetMs = 0, startUs: number | null = null): TextFileInfo => ({ name, format: name.endsWith('.srt') ? 'srt' : 'ass', cues: 3, startUs, offsetMs });

const fansubPick: FansubPick = {
  ...chapterSub, id: 'pick-1', name: 'GroupA', language: 'eng', offsetMs: 0, fileName: 'pick.ass', fileSize: 90, fonts: [], pick: true,
  attachment: { kind: 'chapter', discKey: KEY, playlistId: '00001', chapter: 0 },
  source: { kind: 'fansub', group: 'GroupA', tracker: '', rank: 'other', toshoFileId: 7101, track: 0, trackName: 'Full', alignment: { kind: 'original' }, linedUpOn: { discKey: KEY, playlistId: '00001' } },
};
const pickRequest: FansubPickRequest = { fileId: 7101, track: 0, discKey: KEY, playlistId: '00001' };

function setup(opts: { fetchFails?: boolean; loaded?: readonly TextFileInfo[]; fetchGate?: Promise<void>; pickFails?: Error; pickGate?: Promise<void> } = {}) {
  const calls: unknown[][] = [];
  const listeners = new Set<() => void>();
  let snap: PlayerSnapshot = {
    ...INITIAL_SNAPSHOT, engineState: 'playing', currentPlaylistId: '00001',
    chapters: [{ index: 0, startUs: 0 }, { index: 1, startUs: 60_000_000 }, { index: 2, startUs: 120_000_000 }],
    subtitles: { pg: [], text: opts.loaded ? { files: opts.loaded, missingFonts: [], episodeStarts: [] } : null, selected: opts.loaded ? 'text' : 'off', scale: 1 },
  };
  const show = (change: Partial<PlayerSnapshot>): void => {
    snap = { ...snap, ...change };
    for (const l of [...listeners]) l();
  };
  /** The engine's answer to a load: the text set is now `files`. */
  const engineLists = (...files: TextFileInfo[]): void => show({ subtitles: { ...snap.subtitles!, text: { files, missingFonts: [], episodeStarts: [] } } });
  const controller = {
    discOpens: 1,
    loadSubtitleFiles: async (files: readonly File[]) => void calls.push(['load', files.map((f) => f.name)]),
    setSubtitleStart: (i: number, us: number | null) => void calls.push(['start', i, us]),
    shiftSubtitleFile: (i: number, ms: number) => {
      calls.push(['shift', i, ms]);
      // as the controller does: the snapshot shows the new offset at once
      const text = snap.subtitles!.text!;
      show({ subtitles: { ...snap.subtitles!, text: { ...text, files: text.files.map((f, j) => (j === i ? { ...f, offsetMs: f.offsetMs + ms } : f)) } } });
    },
    selectSubtitle: (c: SubtitleChoice) => void calls.push(['select', c]),
    showNotice: (code: string, message: string) => void calls.push(['notice', code, message]),
    subscribe: (l: () => void) => {
      listeners.add(l);
      return () => void listeners.delete(l);
    },
  };
  const nas = {
    subtitleFiles: async (s: StoredSubtitle) => {
      calls.push(['fetch', s.id]);
      if (opts.fetchGate) await opts.fetchGate;
      if (opts.fetchFails) throw new Error('offline');
      return [new File(['[Script Info]'], s.fileName), ...s.fonts.map((f) => new File(['font'], f.name))];
    },
    pickFansub: async (req: FansubPickRequest) => {
      calls.push(['pickFansub', req.fileId, req.track]);
      if (opts.pickGate) await opts.pickGate;
      if (opts.pickFails) throw opts.pickFails;
      return { ...fansubPick, source: { ...fansubPick.source, toshoFileId: req.fileId, track: req.track } };
    },
  };
  const places = {
    noteStoredSubtitle: (name: string, id: string, size: number, language: string) => void calls.push(['note', name, id, size, language]),
    noteFansubPick: (name: string, fansub: PlaceFansub, size: number, language: string) => void calls.push(['noteFansub', name, fansub, size, language]),
  };
  const picker = new StoredSubtitlePicker({ nas, controller, places, snapshot: () => snap, log: () => {} });
  const pick = (s: StoredSubtitle) => picker.pick(s);
  return { calls, controller, engineLists, pick, picker, show };
}

afterEach(() => {
  vi.useRealTimers();
});

describe('StoredSubtitlePicker', () => {
  it('loads the file with its fonts, then places an episode subtitle at 0 with its default offset, selects text and notes the id', async () => {
    const t = setup();
    const done = t.pick(episodeSub);
    await settle();
    expect(t.calls).toEqual([['fetch', 'sub-1'], ['load', ['ep1.ass', 'Made Up Sans.ttf']]]);
    t.engineLists(file('ep1.ass'));
    expect(await done).toBe(true);
    expect(t.calls.slice(2)).toEqual([['start', 0, 0], ['shift', 0, 400], ['select', { kind: 'text' }], ['note', 'ep1.ass', 'sub-1', 120, 'en']]);
  });

  it("places a chapter's subtitle at that chapter's start", async () => {
    const t = setup();
    const done = t.pick(chapterSub);
    await settle();
    t.engineLists(file('ep1.ass'));
    expect(await done).toBe(true);
    expect(t.calls).toContainEqual(['start', 0, 120_000_000]);
    // no default offset: nothing to shift
    expect(t.calls.filter((c) => c[0] === 'shift')).toEqual([]);
  });

  it("leaves a chapter's subtitle unplaced when the playlist has no such chapter", async () => {
    const t = setup();
    const done = t.pick({ ...chapterSub, attachment: { ...chapterSub.attachment, chapter: 9 } as StoredSubtitle['attachment'] });
    await settle();
    t.engineLists(file('ep1.ass'));
    expect(await done).toBe(true);
    expect(t.calls.filter((c) => c[0] === 'start')).toEqual([]);
  });

  it('applies the default offset once, against the offset the engine reports', async () => {
    const t = setup();
    const done = t.pick(episodeSub);
    await settle();
    t.engineLists(file('ep1.ass', 100));
    expect(await done).toBe(true);
    t.engineLists(file('ep1.ass', 500));
    t.engineLists(file('ep1.ass', 500));
    expect(t.calls.filter((c) => c[0] === 'shift')).toEqual([['shift', 0, 300]]);
  });

  it('changes nothing and shows a notice when the fetch fails', async () => {
    const t = setup({ fetchFails: true, loaded: [file('mine.srt', 200, 0)] });
    expect(await t.pick(episodeSub)).toBe(false);
    expect(t.calls).toEqual([['fetch', 'sub-1'], ['notice', 'stored-subtitle', STORED_PICK_FAILED]]);
    expect(STORED_PICK_FAILED).toBe("Couldn't load the subtitles from the NAS.");
  });

  it('replaces local files already loaded, waiting for the new set rather than the old one, and notes the id', async () => {
    const t = setup({ loaded: [file('ep1.ass', 900, 0), file('other.srt')] });
    const done = t.pick(episodeSub);
    await settle();
    expect(t.calls).toContainEqual(['load', ['ep1.ass', 'Made Up Sans.ttf']]);
    // the old set still lists a file of that name: not the engine's answer yet
    expect(t.calls.filter((c) => c[0] === 'shift' || c[0] === 'note')).toEqual([]);
    t.engineLists(file('ep1.ass'));
    expect(await done).toBe(true);
    expect(t.calls).toContainEqual(['shift', 0, 400]);
    expect(t.calls).toContainEqual(['note', 'ep1.ass', 'sub-1', 120, 'en']);
  });

  it('gives up when another disc opens while the files are fetched', async () => {
    const t = setup();
    const done = t.pick(episodeSub);
    t.controller.discOpens = 2;
    expect(await done).toBe(false);
    expect(t.calls).toEqual([['fetch', 'sub-1']]);
  });
});

describe('StoredSubtitlePicker waits', () => {
  it("shows the notice when the engine doesn't list the file in time, and places nothing", async () => {
    vi.useFakeTimers();
    const t = setup();
    const done = t.pick(episodeSub);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(await done).toBe(false);
    expect(t.calls).toEqual([['fetch', 'sub-1'], ['load', ['ep1.ass', 'Made Up Sans.ttf']], ['notice', 'stored-subtitle', STORED_PICK_FAILED]]);
  });

  it('never times out while the encoding prompt is open, and places the file once it is answered', async () => {
    vi.useFakeTimers();
    const t = setup();
    const done = t.pick({ ...episodeSub, fileName: 'ep1.srt' });
    await vi.advanceTimersByTimeAsync(1);
    t.show({ encodingPrompt: { names: ['ep1.srt'] } });
    await vi.advanceTimersByTimeAsync(60_000);
    t.show({ encodingPrompt: null });
    await vi.advanceTimersByTimeAsync(5_000);
    t.engineLists(file('ep1.srt'));
    expect(await done).toBe(true);
    expect(t.calls.filter((c) => c[0] === 'notice')).toEqual([]);
    expect(t.calls).toContainEqual(['note', 'ep1.srt', 'sub-1', 120, 'en']);
  });

  it('a newer pick of a file with the same name abandons the older one, which applies nothing', async () => {
    let release!: () => void;
    const t = setup({ fetchGate: new Promise<void>((r) => (release = r)) });
    const fr: StoredSubtitle = { ...episodeSub, id: 'sub-fr', language: 'fr', offsetMs: -300 };
    const first = t.pick(episodeSub);
    const second = t.pick(fr);
    release();
    await settle();
    t.engineLists(file('ep1.ass'));
    expect(await first).toBe(false);
    expect(await second).toBe(true);
    expect(t.calls.filter((c) => c[0] === 'shift' || c[0] === 'note')).toEqual([['shift', 0, -300], ['note', 'ep1.ass', 'sub-fr', 120, 'fr']]);
  });

  it('a newer pick while the older one waits for the engine abandons the older one', async () => {
    const t = setup();
    const fr: StoredSubtitle = { ...episodeSub, id: 'sub-fr', offsetMs: -300 };
    const first = t.pick(episodeSub);
    await settle();
    const second = t.pick(fr);
    expect(await first).toBe(false);
    await settle();
    t.engineLists(file('ep1.ass'));
    expect(await second).toBe(true);
    expect(t.calls.filter((c) => c[0] === 'note')).toEqual([['note', 'ep1.ass', 'sub-fr', 120, 'en']]);
  });

  it('a local pick (supersede) abandons a pick in flight', async () => {
    const t = setup();
    const done = t.pick(episodeSub);
    await settle();
    t.picker.supersede();
    t.engineLists(file('ep1.ass'));
    expect(await done).toBe(false);
    expect(t.calls.filter((c) => c[0] !== 'fetch' && c[0] !== 'load')).toEqual([]);
  });

  it('places nothing when another playlist plays by the time the file is listed', async () => {
    const t = setup();
    const done = t.pick(episodeSub);
    await settle();
    t.show({ currentPlaylistId: '00002' });
    t.engineLists(file('ep1.ass'));
    expect(await done).toBe(false);
    expect(t.calls.filter((c) => c[0] !== 'fetch' && c[0] !== 'load')).toEqual([]);
  });
});

describe("StoredSubtitlePicker with a viewer's Anime Tosho pick", () => {
  it('lines the track up on the NAS, loads it and notes the release, file and track for the place', async () => {
    const t = setup();
    const done = t.picker.pickFansub(pickRequest, { releaseId: 7001, trackName: 'Full' });
    await settle();
    expect(t.calls).toEqual([['pickFansub', 7101, 0], ['fetch', 'pick-1'], ['load', ['pick.ass']]]);
    t.engineLists(file('pick.ass'));
    expect((await done)?.id).toBe('pick-1');
    expect(t.calls.slice(3)).toEqual([['start', 0, 0], ['select', { kind: 'text' }], ['noteFansub', 'pick.ass', { releaseId: 7001, fileId: 7101, track: 0, trackName: 'Full' }, 90, 'eng']]);
  });

  it("notes the track's listed name, clipped to what the NAS takes, never the NAS's fallback name", async () => {
    for (const trackName of ['', 'x'.repeat(300)]) {
      const t = setup();
      const done = t.picker.pickFansub(pickRequest, { releaseId: 7001, trackName });
      await settle();
      t.engineLists(file('pick.ass'));
      await done;
      expect(t.calls.find((c) => c[0] === 'noteFansub')?.[2]).toEqual({ releaseId: 7001, fileId: 7101, track: 0, trackName: trackName.slice(0, 256) });
    }
  });

  it('says the episode changed when another playlist plays before or while the pick lines up', async () => {
    const before = setup();
    before.show({ currentPlaylistId: '00002' });
    expect(await before.picker.pickFansub(pickRequest, { releaseId: 7001, trackName: 'Full' })).toBeNull();
    expect(before.calls).toEqual([['notice', 'fansub-pick', EPISODE_CHANGED]]);

    let release!: () => void;
    const during = setup({ pickGate: new Promise((r) => (release = r)) });
    const done = during.picker.pickFansub(pickRequest, { releaseId: 7001, trackName: 'Full' });
    await settle();
    during.show({ currentPlaylistId: '00002' });
    release();
    expect(await done).toBeNull();
    expect(during.calls).toEqual([['pickFansub', 7101, 0], ['notice', 'fansub-pick', EPISODE_CHANGED]]);
  });

  it("says Anime Tosho's subtitles couldn't be loaded when the NAS refuses the pick, and loads nothing", async () => {
    const t = setup({ pickFails: new NasHttpError(429, 'too-many') });
    expect(await t.picker.pickFansub(pickRequest, { releaseId: 7001, trackName: 'Full' })).toBeNull();
    expect(t.calls).toEqual([['pickFansub', 7101, 0], ['notice', 'fansub-pick', PICK_FAILED]]);
  });

  it('says so too when the lined-up file fails to download', async () => {
    const t = setup({ fetchFails: true });
    expect(await t.picker.pickFansub(pickRequest, { releaseId: 7001, trackName: 'Full' })).toBeNull();
    expect(t.calls).toEqual([['pickFansub', 7101, 0], ['fetch', 'pick-1'], ['notice', 'fansub-pick', PICK_FAILED]]);
  });

  it('a newer pick while the NAS lines an older one up abandons the older one', async () => {
    let release!: () => void;
    const t = setup({ pickGate: new Promise((r) => (release = r)) });
    const older = t.picker.pickFansub(pickRequest, { releaseId: 7001, trackName: 'Full' });
    await settle();
    t.picker.supersede();
    release();
    expect(await older).toBeNull();
    expect(t.calls).toEqual([['pickFansub', 7101, 0]]);
  });
});

describe('replacesTextSet', () => {
  it('is true for a pick with subtitle files (or unrecognised ones), false for fonts alone', () => {
    expect(replacesTextSet([new File([''], 'a.srt'), new File([''], 'f.ttf')])).toBe(true);
    expect(replacesTextSet([new File([''], 'subtitles.txt')])).toBe(true);
    expect(replacesTextSet([new File([''], 'f.ttf')])).toBe(false);
    expect(replacesTextSet([])).toBe(false);
  });
});
