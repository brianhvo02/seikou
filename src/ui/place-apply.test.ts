import { afterEach, describe, expect, it, vi } from 'vitest';
import type { FansubPick, FansubPickRequest, PlaceFansub, PlaceSettings, StoredSubtitle, ToshoReleaseFiles } from '../engine/disc/nas-api';
import { NasHttpError } from './nas/nas-client';
import { PICK_FAILED } from './nas/tosho-search-model';
import type { SubtitleChoice, TextFileInfo } from '../engine/protocol';
import { INITIAL_SNAPSHOT, type PlayerSnapshot } from '../player/player-controller';
import { filesToAdd, LaunchSettingsApplier, STORED_FETCH_TIMEOUT_MS, TEXT_WAIT_MS } from './place-apply';
import type { LaunchSettings } from './place-saver';
import type { StoredTextFile } from './place-store';

const KEY = `f.${'A'.repeat(32)}`;
const base: PlaceSettings = {
  audioLanguage: 'jpn', pgLanguage: null, textFiles: [], psr1: 1, psr2: 0, psr3: 1, textOn: false, textScale: 1, shaderSet: null, volume: 1, muted: false,
};
const bytes = (n: number): Uint8Array => new Uint8Array(n);
const settle = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

const storedSub = (id: string, language: string, playlistId: string, fileName: string): StoredSubtitle => ({
  id, name: `Fansub ${id}`, language, offsetMs: 400, fileName, fileSize: 120, fonts: [{ name: 'Made Up Sans.ttf', size: 50 }],
  attachment: { kind: 'episode', discKey: KEY, playlistId, titleId: 'anilist:1', seasonId: 's1', episode: Number(playlistId) }, uploaderPersonId: 'p1', uploadedAt: 1,
});

interface SetupOpts {
  loadFails?: boolean;
  /** The NAS's subtitles for the disc (an Error: the list fails); no NAS when absent. */
  nasList?: StoredSubtitle[] | Error;
  /** Ids whose files fail to download. */
  fetchFails?: string[];
  /** Downloads wait for this. */
  fetchGate?: Promise<void>;
  /** Keeping the local files on the device fails (IndexedDB). */
  keepFails?: boolean;
  /** The list waits for this. */
  listGate?: Promise<void>;
  /** What the NAS answers each `pickFansub` with, in turn (an Error: refused); the pick of the request by default. */
  pickAnswers?: (Error | null)[];
  /** `toshoRelease`'s answer (an Error: it fails). */
  release?: ToshoReleaseFiles | Error;
}

/** The NAS's answer to a pick: shaped as a stored subtitle, under its own id. */
const fansubPick = (req: FansubPickRequest): FansubPick => ({
  id: `pick-${req.fileId}-${req.track}`, name: 'GroupA', language: 'eng', offsetMs: 0, fileName: `pick-${req.fileId}.ass`, fileSize: 90, fonts: [{ name: 'Made Up Sans.ttf', size: 50 }],
  attachment: { kind: 'chapter', discKey: req.discKey, playlistId: req.playlistId, chapter: 0 }, uploadedAt: 1, pick: true,
  source: { kind: 'fansub', group: 'GroupA', tracker: '', rank: 'other', toshoFileId: req.fileId, track: req.track, trackName: 'Full', alignment: { kind: 'original' }, linedUpOn: { discKey: req.discKey, playlistId: req.playlistId } },
});

function setup(launch: LaunchSettings | null, stored: StoredTextFile[] = [], opts: SetupOpts = {}) {
  let clock = 1000;
  const calls: unknown[][] = [];
  const loaded: string[][] = [];
  const signals: (AbortSignal | undefined)[] = [];
  let pending = launch;
  const controller = {
    discOpens: 1,
    setVolume: (v: number) => void calls.push(['volume', v]),
    toggleMute: () => void calls.push(['mute']),
    selectAudio: (i: number) => void calls.push(['audio', i]),
    selectSubtitle: (c: SubtitleChoice) => void calls.push(['subtitle', c]),
    showNotice: (code: string, message: string) => void calls.push(['notice', code, message]),
    loadSubtitleFiles: async (files: readonly File[]) => {
      loaded.push(files.map((f) => f.name));
      if (opts.loadFails) throw new Error('worker gone');
    },
    setSubtitleStart: (i: number, us: number | null) => void calls.push(['start', i, us]),
    shiftSubtitleFile: (i: number, ms: number) => void calls.push(['shift', i, ms]),
    scaleSubtitles: (d: number) => void calls.push(['scale', d]),
  };
  const nas = opts.nasList === undefined ? undefined : {
    subtitlesForDisc: async (key: string, o: { timeoutMs?: number } = {}) => {
      calls.push(['list', key, o.timeoutMs]);
      if (opts.listGate) await opts.listGate;
      if (opts.nasList instanceof Error) throw opts.nasList;
      return opts.nasList!;
    },
    pickFansub: async (req: FansubPickRequest) => {
      calls.push(['pickFansub', req.fileId, req.track, req.discKey, req.playlistId]);
      const answer = opts.pickAnswers?.shift();
      if (answer) throw answer;
      return fansubPick(req);
    },
    toshoRelease: async (id: number, key: string, playlistId: string) => {
      calls.push(['release', id, key, playlistId]);
      if (opts.release instanceof Error) throw opts.release;
      return opts.release ?? { release: { id, title: 'GroupA', date: 1, seadex: null }, files: [], matchedFileId: null };
    },
    subtitleFiles: async (sub: StoredSubtitle, signal?: AbortSignal) => {
      signals.push(signal);
      if (opts.fetchGate) await opts.fetchGate;
      if (opts.fetchFails?.includes(sub.id)) throw new Error('offline');
      return [new File(['[Script Info]'], sub.fileName), ...sub.fonts.map((f) => new File(['font'], f.name))];
    },
  };
  const applier = new LaunchSettingsApplier({
    controller,
    nas,
    pickStored: async (sub) => {
      calls.push(['pick', sub.id]);
      return true;
    },
    pickFansub: async (req, origin) => {
      calls.push(['pickNextFansub', req.fileId, req.track, origin.releaseId, origin.trackName]);
      return null;
    },
    onFansubPick: (pick) => void calls.push(['activeFansub', pick.id]),
    onStoredSubtitle: (id) => void calls.push(['active', id]),
    places: {
      noteStoredSubtitle: (name, id, size, language) => void calls.push(['note', name, id, size, language]),
      noteFansubPick: (name, fansub, size, language) => void calls.push(['noteFansub', name, fansub, size, language]),
      takeLaunchSettings: () => {
        const l = pending;
        pending = null;
        return l && { ...l, discKey: KEY };
      },
      storedTextFiles: async (key) => (key === KEY ? stored : []),
      addTextFiles: async (files) => {
        calls.push(['keep', files.map((f) => f.name)]);
        if (opts.keepFails) throw new Error('quota');
      },
    },
    nowMs: () => clock,
    log: () => {},
  });
  let snap: PlayerSnapshot = {
    ...INITIAL_SNAPSHOT, engineState: 'loading', currentPlaylistId: null,
    audioTracks: [
      { index: 1, codec: 'ac3', language: 'eng', channels: 'stereo', playable: true },
      { index: 2, codec: 'ac3', language: 'jpn', channels: 'stereo', playable: true },
    ],
    subtitles: { pg: [{ index: 1, language: 'eng' }, { index: 2, language: 'jpn' }], text: null, selected: 'off', scale: 1 },
  };
  return {
    applier,
    calls,
    loaded,
    signals,
    controller,
    show(change: Partial<PlayerSnapshot>) {
      snap = { ...snap, ...change };
      applier.observe(snap);
    },
    get snap() {
      return snap;
    },
    advance(ms: number) {
      clock += ms;
    },
  };
}

/** The engine's subtitle state listing `names` as the text set. */
const listing = (snap: PlayerSnapshot, ...names: string[]): Partial<PlayerSnapshot> => ({
  subtitles: { ...snap.subtitles!, text: { files: names.map((name) => ({ name, format: 'srt' as const, cues: 1, startUs: 0, offsetMs: 0 })), missingFonts: [], episodeStarts: [] }, selected: 'text' },
});

describe('LaunchSettingsApplier', () => {
  it("waits for the disc to play, then sets volume and mute once, leaving the device's shader alone", () => {
    const t = setup({ settings: { ...base, volume: 0.4, muted: true, shaderSet: 'Mode A' }, byLanguage: false });
    t.show({});
    expect(t.calls).toEqual([]);
    t.show({ engineState: 'playing', currentPlaylistId: '00001' });
    t.show({ timeUs: 1 });
    expect(t.calls).toEqual([['volume', 0.4], ['mute']]);
  });

  it("chooses audio and PG by language for another playlist's settings", () => {
    const t = setup({ settings: { ...base, audioLanguage: 'jpn', pgLanguage: 'jpn', psr1: 5, psr2: 0x80000007 }, byLanguage: true });
    t.show({ engineState: 'playing', currentPlaylistId: '00004' });
    expect(t.calls).toContainEqual(['audio', 2]);
    expect(t.calls).toContainEqual(['subtitle', { kind: 'pg', stream: 2 }]);
  });

  it("leaves audio and PG to the start's registers for a resume", () => {
    const t = setup({ settings: { ...base, psr1: 2, psr2: 0x80000002 }, byLanguage: false });
    t.show({ engineState: 'playing', currentPlaylistId: '00001' });
    expect(t.calls.filter((c) => c[0] === 'audio' || c[0] === 'subtitle')).toEqual([]);
  });

  it('adds the stored text files again with their placements, offsets and scale, and PG back when text was off', async () => {
    const textFiles = [
      { name: 'ep1.ass', size: 10, startUs: 5_000_000, offsetMs: 400 },
      { name: 'other.srt', size: 3, startUs: null, offsetMs: 0 }, // not on this device: skipped silently
    ];
    const t = setup({ settings: { ...base, textFiles, textOn: false, psr2: 0x80000001, textScale: 1.4 }, byLanguage: false }, [
      { name: 'ep1.ass', bytes: bytes(10) }, { name: 'Font.ttf', bytes: bytes(4) },
    ]);
    t.show({ engineState: 'playing', currentPlaylistId: '00001' });
    await settle();
    expect(t.loaded).toEqual([['ep1.ass', 'Font.ttf']]);
    const files: TextFileInfo[] = [{ name: 'ep1.ass', format: 'ass', cues: 3, startUs: 0, offsetMs: 0 }];
    t.show({ subtitles: { ...t.snap.subtitles!, text: { files, missingFonts: [], episodeStarts: [] }, selected: 'text' } });
    expect(t.calls.slice(-4)).toEqual([['start', 0, 5_000_000], ['shift', 0, 400], ['scale', expect.closeTo(0.4, 5)], ['subtitle', { kind: 'pg', stream: 1 }]]);
  });

  it('keeps the engine placement of a carried file, and adds nothing when this device has none of its files', async () => {
    const textFiles = [{ name: 'ep1.srt', size: 0, startUs: 5_000_000, offsetMs: 0 }];
    const t = setup({ settings: { ...base, textFiles, textOn: true }, byLanguage: true }, [{ name: 'ep1.srt', bytes: bytes(2) }]);
    t.show({ engineState: 'playing', currentPlaylistId: '00004' });
    await settle();
    expect(t.loaded).toEqual([['ep1.srt']]);
    t.show({ subtitles: { ...t.snap.subtitles!, text: { files: [{ name: 'ep1.srt', format: 'srt', cues: 1, startUs: 0, offsetMs: 0 }], missingFonts: [], episodeStarts: [] }, selected: 'text' } });
    expect(t.calls.filter((c) => c[0] === 'start')).toEqual([]);

    const u = setup({ settings: { ...base, textFiles }, byLanguage: true }, []);
    u.show({ engineState: 'playing', currentPlaylistId: '00004' });
    await settle();
    expect(u.loaded).toEqual([]);
  });
});

describe('LaunchSettingsApplier giving up on re-added files', () => {
  const textFiles = [{ name: 'ep1.srt', size: 0, startUs: null, offsetMs: 400 }];
  const start = async (opts: { loadFails?: boolean } = {}) => {
    const t = setup({ settings: { ...base, textFiles, textOn: false, psr2: 0x80000001 }, byLanguage: false }, [{ name: 'ep1.srt', bytes: bytes(2) }], opts);
    t.show({ engineState: 'playing', currentPlaylistId: '00001' });
    await settle();
    return t;
  };
  const adjustments = (calls: unknown[][]) => calls.filter((c) => c[0] === 'shift' || c[0] === 'scale' || c[0] === 'subtitle');

  it('forgets them when the load fails, so a file the user adds later is left alone', async () => {
    const t = await start({ loadFails: true });
    t.show(listing(t.snap, 'ep1.srt'));
    expect(adjustments(t.calls)).toEqual([]);
  });

  it('gives up after TEXT_WAIT_MS', async () => {
    const t = await start();
    t.advance(TEXT_WAIT_MS + 1);
    t.show({ timeUs: 1 });
    t.show(listing(t.snap, 'ep1.srt'));
    expect(adjustments(t.calls)).toEqual([]);
  });

  it('gives up at a list without them (a file that did not parse)', async () => {
    const t = await start();
    t.show(listing(t.snap, 'other.srt'));
    t.show(listing(t.snap, 'ep1.srt'));
    expect(adjustments(t.calls)).toEqual([]);
  });

  it('applies them when they are listed in time', async () => {
    const t = await start();
    t.advance(TEXT_WAIT_MS - 1);
    t.show(listing(t.snap, 'ep1.srt'));
    expect(adjustments(t.calls)).toEqual([['shift', 0, 400], ['subtitle', { kind: 'pg', stream: 1 }]]);
  });
});

it('matches stored files by name and, when known, size; fonts only with a subtitle file', () => {
  const stored = [{ name: 'a.srt', bytes: bytes(5) }, { name: 'b.srt', bytes: bytes(6) }, { name: 'F.otf', bytes: bytes(1) }];
  expect(filesToAdd([{ name: 'a.srt', size: 5, startUs: null, offsetMs: 0 }, { name: 'b.srt', size: 7, startUs: null, offsetMs: 0 }], stored)).toEqual({
    subtitles: [stored[0]], fonts: [stored[2]],
  });
  expect(filesToAdd([{ name: 'c.srt', size: 0, startUs: null, offsetMs: 0 }], stored)).toEqual({ subtitles: [], fonts: [] });
});

describe('LaunchSettingsApplier with subtitles stored on the NAS', () => {
  const ep1 = storedSub('sub-1', 'en', '00001', 'ep1.ass');
  const stored1 = { name: 'ep1.ass', size: 120, startUs: 0, offsetMs: 900, subtitleId: 'sub-1', language: 'en' };

  it('fetches a resumed stored subtitle again, restores its placement and my offset, and notes it for later saves', async () => {
    const t = setup({ settings: { ...base, textFiles: [stored1], textOn: true }, byLanguage: false }, [], { nasList: [ep1] });
    t.show({ engineState: 'playing', currentPlaylistId: '00001' });
    await settle();
    expect(t.calls).toContainEqual(['list', KEY, 3000]);
    expect(t.loaded).toEqual([['ep1.ass', 'Made Up Sans.ttf']]);
    expect(t.calls).toContainEqual(['note', 'ep1.ass', 'sub-1', 120, 'en']);
    expect(t.calls).toContainEqual(['active', 'sub-1']);
    // its bytes stay on the NAS: nothing is kept on this device
    expect(t.calls.filter((c) => c[0] === 'keep')).toEqual([]);
    t.show({ subtitles: { ...t.snap.subtitles!, text: { files: [{ name: 'ep1.ass', format: 'ass', cues: 3, startUs: null, offsetMs: 0 }], missingFonts: [], episodeStarts: [] }, selected: 'text' } });
    expect(t.calls.filter((c) => c[0] === 'start' || c[0] === 'shift')).toEqual([['start', 0, 0], ['shift', 0, 900]]);
  });

  it('loads a stored subtitle and local files together, in the order the place had them', async () => {
    const local = { name: 'mine.srt', size: 2, startUs: null, offsetMs: -200 };
    const t = setup({ settings: { ...base, textFiles: [local, stored1], textOn: true }, byLanguage: false }, [{ name: 'mine.srt', bytes: bytes(2) }, { name: 'Font.ttf', bytes: bytes(4) }], { nasList: [ep1] });
    t.show({ engineState: 'playing', currentPlaylistId: '00001' });
    await settle();
    expect(t.loaded).toEqual([['mine.srt', 'ep1.ass', 'Font.ttf', 'Made Up Sans.ttf']]);
    expect(t.calls).toContainEqual(['keep', ['mine.srt', 'Font.ttf']]);
    // noted after the local files are kept (keeping a local pick clears the saver's note)
    const order = t.calls.filter((c) => c[0] === 'keep' || c[0] === 'note').map((c) => c[0]);
    expect(order).toEqual(['keep', 'note']);
    t.show(listing(t.snap, 'mine.srt', 'ep1.ass'));
    expect(t.calls.filter((c) => c[0] === 'shift')).toEqual([['shift', 0, -200], ['shift', 1, 900]]);
  });

  it('skips a stored subtitle whose download fails, or that is gone, and applies the rest', async () => {
    const local = { name: 'mine.srt', size: 2, startUs: null, offsetMs: 300 };
    for (const opts of [{ nasList: [ep1], fetchFails: ['sub-1'] }, { nasList: [] }, { nasList: new Error('offline') }, {}] as SetupOpts[]) {
      const t = setup({ settings: { ...base, textFiles: [stored1, local], textOn: true }, byLanguage: false }, [{ name: 'mine.srt', bytes: bytes(2) }], opts);
      t.show({ engineState: 'playing', currentPlaylistId: '00001' });
      await settle();
      expect(t.loaded).toEqual([['mine.srt']]);
      expect(t.calls.filter((c) => c[0] === 'note')).toEqual([]);
      t.show(listing(t.snap, 'mine.srt'));
      expect(t.calls.filter((c) => c[0] === 'shift')).toEqual([['shift', 0, 300]]);
    }
  });

  it('a pick the user makes while a resumed stored subtitle downloads wins: nothing is loaded or noted', async () => {
    let release!: () => void;
    const fetchGate = new Promise<void>((r) => (release = r));
    const t = setup({ settings: { ...base, textFiles: [stored1], textOn: true }, byLanguage: false }, [], { nasList: [ep1], fetchGate });
    t.show({ engineState: 'playing', currentPlaylistId: '00001' });
    await settle();
    expect(t.signals.map((s) => s?.aborted)).toEqual([false]);
    t.applier.supersede();
    // the download is stopped, not left running
    expect(t.signals.map((s) => s?.aborted)).toEqual([true]);
    release();
    await settle();
    expect(t.loaded).toEqual([]);
    expect(t.calls.filter((c) => c[0] === 'note' || c[0] === 'active')).toEqual([]);
  });

  it('a pick the user makes while Up next lists the next stored subtitles wins: nothing is picked or shown', async () => {
    const subs = [storedSub('sub-2en', 'en', '00002', 'ep2.ass')];
    for (const nasList of [subs, []]) {
      let release!: () => void;
      const listGate = new Promise<void>((r) => (release = r));
      const t = setup({ settings: { ...base, textFiles: [stored1], textOn: true, psr2: 0x80000001 }, byLanguage: true }, [], { nasList, listGate });
      t.show({ engineState: 'playing', currentPlaylistId: '00002' });
      await settle();
      t.applier.supersede();
      release();
      await settle();
      expect(t.calls.filter((c) => c[0] === 'pick' || c[0] === 'subtitle')).toEqual([]);
    }
  });

  it('notes the stored subtitle though keeping the local files on the device fails', async () => {
    const local = { name: 'mine.srt', size: 2, startUs: null, offsetMs: 0 };
    const t = setup({ settings: { ...base, textFiles: [local, stored1], textOn: true }, byLanguage: false }, [{ name: 'mine.srt', bytes: bytes(2) }], { nasList: [ep1], keepFails: true });
    t.show({ engineState: 'playing', currentPlaylistId: '00001' });
    await settle();
    expect(t.calls.filter((c) => c[0] === 'keep' || c[0] === 'note').map((c) => c[0])).toEqual(['keep', 'note']);
  });

  describe('with a stalled download', () => {
    afterEach(() => void vi.useRealTimers());
    it(`gives it up after ${STORED_FETCH_TIMEOUT_MS / 1000} s and loads the rest`, async () => {
      vi.useFakeTimers();
      const local = { name: 'mine.srt', size: 2, startUs: null, offsetMs: 0 };
      const t = setup({ settings: { ...base, textFiles: [stored1, local], textOn: true }, byLanguage: false }, [{ name: 'mine.srt', bytes: bytes(2) }], { nasList: [ep1], fetchGate: new Promise(() => {}) });
      t.show({ engineState: 'playing', currentPlaylistId: '00001' });
      await vi.advanceTimersByTimeAsync(STORED_FETCH_TIMEOUT_MS - 1);
      expect(t.loaded).toEqual([]);
      await vi.advanceTimersByTimeAsync(1);
      expect(t.loaded).toEqual([['mine.srt']]);
      // the stalled download is stopped, not left running
      expect(t.signals.map((s) => s?.aborted)).toEqual([true]);
    });
  });

  it('finds a stored subtitle renamed on the NAS by its id', async () => {
    const renamed = { ...ep1, fileName: 'ep1.v2.ass' };
    const t = setup({ settings: { ...base, textFiles: [stored1], textOn: true }, byLanguage: false }, [], { nasList: [renamed] });
    t.show({ engineState: 'playing', currentPlaylistId: '00001' });
    await settle();
    expect(t.loaded).toEqual([['ep1.v2.ass', 'Made Up Sans.ttf']]);
    t.show(listing(t.snap, 'ep1.v2.ass'));
    expect(t.calls.filter((c) => c[0] === 'shift')).toEqual([['shift', 0, 900]]);
  });

  it("Up next picks the next episode's stored subtitle in the same language, at its default offset", async () => {
    const subs = [storedSub('sub-2fr', 'fr', '00002', 'ep2.fr.ass'), storedSub('sub-2en', 'EN', '00002', 'ep2.ass'), storedSub('sub-3en', 'en', '00003', 'ep3.ass')];
    const t = setup({ settings: { ...base, textFiles: [stored1], textOn: true }, byLanguage: true }, [], { nasList: subs });
    t.show({ engineState: 'playing', currentPlaylistId: '00002' });
    await settle();
    expect(t.calls.filter((c) => c[0] === 'pick')).toEqual([['pick', 'sub-2en']]);
    // the picker loads, places and offsets it; nothing else is loaded or shifted
    expect(t.loaded).toEqual([]);
    expect(t.calls.filter((c) => c[0] === 'subtitle' || c[0] === 'shift')).toEqual([]);
  });

  it('Up next with no stored subtitle in that language shows PG by language instead', async () => {
    const subs = [storedSub('sub-2fr', 'fr', '00002', 'ep2.fr.ass')];
    for (const nasList of [subs, new Error('offline')]) {
      const t = setup({ settings: { ...base, textFiles: [stored1], textOn: true, pgLanguage: 'jpn', psr2: 0x80000001 }, byLanguage: true }, [], { nasList });
      t.show({ engineState: 'playing', currentPlaylistId: '00002' });
      await settle();
      expect(t.calls.filter((c) => c[0] === 'pick')).toEqual([]);
      expect(t.calls).toContainEqual(['subtitle', { kind: 'pg', stream: 2 }]);
      expect(t.loaded).toEqual([]);
    }
  });

  it('Up next carries nothing from a stored subtitle that was not shown', async () => {
    const t = setup({ settings: { ...base, textFiles: [stored1], textOn: false }, byLanguage: true }, [], { nasList: [storedSub('sub-2en', 'en', '00002', 'ep2.ass')] });
    t.show({ engineState: 'playing', currentPlaylistId: '00002' });
    await settle();
    expect(t.calls.filter((c) => c[0] === 'pick' || c[0] === 'list')).toEqual([]);
    expect(t.loaded).toEqual([]);
  });
});

describe("LaunchSettingsApplier with a viewer's Anime Tosho pick", () => {
  const fansub: PlaceFansub = { releaseId: 7001, fileId: 7, track: 0, trackName: 'Full' };
  const picked = { name: 'pick-7.ass', size: 90, startUs: 0, offsetMs: 300, language: 'eng', fansub };
  const resume = (opts: SetupOpts = {}) => {
    const t = setup({ settings: { ...base, textFiles: [picked], textOn: true }, byLanguage: false }, [], { nasList: [], ...opts });
    t.show({ engineState: 'playing', currentPlaylistId: '00001' });
    return t;
  };

  it('picks it again on the NAS for a resume, loads its files and notes it, with my offset back', async () => {
    const t = resume();
    await settle();
    expect(t.calls.filter((c) => c[0] === 'pickFansub')).toEqual([['pickFansub', 7, 0, KEY, '00001']]);
    expect(t.loaded).toEqual([['pick-7.ass', 'Made Up Sans.ttf']]);
    expect(t.calls).toContainEqual(['noteFansub', 'pick-7.ass', fansub, 90, 'eng']);
    expect(t.calls).toContainEqual(['activeFansub', 'pick-7-0']);
    t.show(listing(t.snap, 'pick-7.ass'));
    expect(t.calls.filter((c) => c[0] === 'shift')).toEqual([['shift', 0, 300]]);
  });

  it('sends no pick while nothing plays, and picks for the playlist once one does', async () => {
    const t = setup({ settings: { ...base, textFiles: [picked], textOn: true }, byLanguage: false }, [], { nasList: [] });
    t.show({ engineState: 'playing', currentPlaylistId: null });
    await settle();
    expect(t.calls.filter((c) => c[0] === 'pickFansub')).toEqual([]);
    t.show({ engineState: 'playing', currentPlaylistId: '00001' });
    await settle();
    expect(t.calls.filter((c) => c[0] === 'pickFansub')).toEqual([['pickFansub', 7, 0, KEY, '00001']]);
  });

  it("lists the release again when the NAS no longer knows the file, then picks it", async () => {
    const t = resume({ pickAnswers: [new NasHttpError(404, 'unknown-file')] });
    await settle();
    expect(t.calls.filter((c) => c[0] === 'pickFansub' || c[0] === 'release')).toEqual([
      ['pickFansub', 7, 0, KEY, '00001'], ['release', 7001, KEY, '00001'], ['pickFansub', 7, 0, KEY, '00001'],
    ]);
    expect(t.loaded).toEqual([['pick-7.ass', 'Made Up Sans.ttf']]);
  });

  it('says it could not load the pick when the NAS refuses it (too many), and leaves the text set as it was', async () => {
    const t = resume({ pickAnswers: [new NasHttpError(429, 'too-many')] });
    await settle();
    expect(t.calls).toContainEqual(['notice', 'fansub-pick', PICK_FAILED]);
    expect(t.loaded).toEqual([]);
    expect(t.calls.filter((c) => c[0] === 'noteFansub' || c[0] === 'subtitle')).toEqual([]);
  });

  const nextRelease = (tracks: ToshoReleaseFiles['files'][number]['tracks']): ToshoReleaseFiles => ({
    release: { id: 7001, title: 'GroupA', date: 1, seadex: null },
    files: [{ id: 7, name: 'ep1.mkv', episode: 1, tracks: [{ track: 0, language: 'eng', name: 'Full' }] }, { id: 8, name: 'ep2.mkv', episode: 2, tracks }],
    matchedFileId: 8,
  });

  it("Up next picks the track of the same name in the next episode's file of the same release", async () => {
    const t = setup({ settings: { ...base, textFiles: [picked], textOn: true }, byLanguage: true }, [], {
      nasList: [], release: nextRelease([{ track: 0, language: 'eng', name: 'Signs' }, { track: 1, language: 'eng', name: 'Full' }]),
    });
    t.show({ engineState: 'playing', currentPlaylistId: '00002' });
    await settle();
    expect(t.calls.filter((c) => c[0] === 'release' || c[0] === 'pickNextFansub')).toEqual([['release', 7001, KEY, '00002'], ['pickNextFansub', 8, 1, 7001, 'Full']]);
    expect(t.calls.filter((c) => c[0] === 'subtitle' || c[0] === 'pick')).toEqual([]);
  });

  it('Up next carries a pick of an unnamed track to the unnamed track of the same language', async () => {
    const unnamed = { ...picked, fansub: { ...fansub, trackName: '' } };
    const t = setup({ settings: { ...base, textFiles: [unnamed], textOn: true }, byLanguage: true }, [], {
      nasList: [], release: nextRelease([{ track: 0, language: 'eng', name: 'Signs' }, { track: 2, language: 'eng', name: '' }]),
    });
    t.show({ engineState: 'playing', currentPlaylistId: '00002' });
    await settle();
    expect(t.calls.filter((c) => c[0] === 'pickNextFansub')).toEqual([['pickNextFansub', 8, 2, 7001, '']]);
  });

  it('Up next with no track of that name carries as before: a stored subtitle in its language, else PG', async () => {
    for (const release of [nextRelease([{ track: 0, language: 'eng', name: 'Signs' }]), new Error('offline')]) {
      const t = setup({ settings: { ...base, textFiles: [picked], textOn: true }, byLanguage: true }, [], { nasList: [storedSub('sub-2en', 'eng', '00002', 'ep2.ass')], release });
      t.show({ engineState: 'playing', currentPlaylistId: '00002' });
      await settle();
      expect(t.calls.filter((c) => c[0] === 'pickNextFansub')).toEqual([]);
      expect(t.calls.filter((c) => c[0] === 'pick')).toEqual([['pick', 'sub-2en']]);
    }
  });
});
