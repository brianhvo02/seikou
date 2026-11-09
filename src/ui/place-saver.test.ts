import { describe, expect, it } from 'vitest';
import type { DiscPlaces, PlaybackPlace } from '@seikou/nas/nas-api';
import type { PlaceState, TextFileInfo } from '@seikou/engine/protocol';
import { INITIAL_SNAPSHOT, type PlayerSnapshot } from '@seikou/engine/controller/player-controller';
import { NasHttpError } from './nas/nas-client';
import { PlaceSaver, type PlaceTarget } from './place-saver';
import { MAX_SEND_ATTEMPTS, MAX_TEXT_FILE_BYTES, placeKey, type OutboxEntry, type PlaceStore, type StoredTextFile } from './place-store';
import type { NasPairing } from './nas/nas-store';

const S = 1e6;
const KEY = `f.${'A'.repeat(32)}`;

/** The store in memory, with what was put, in order. */
function memoryStore(): PlaceStore & { puts: PlaybackPlace[]; saves: PlaybackPlace[]; queued: Map<string, OutboxEntry>; files: Map<string, StoredTextFile[]> } {
  const places = new Map<string, PlaybackPlace>();
  const queued = new Map<string, OutboxEntry>();
  const files = new Map<string, StoredTextFile[]>();
  /** `put` calls (a local disc's places); `saves` adds the outbox's (a NAS disc's), so either kind of disc is seen. */
  const puts: PlaybackPlace[] = [];
  const saves: PlaybackPlace[] = [];
  return {
    puts,
    saves,
    queued,
    files,
    async put(p) {
      puts.push(p);
      saves.push(p);
      places.set(placeKey(p), p);
    },
    async get(discKey): Promise<DiscPlaces> {
      const mine = [...places.values()].filter((p) => p.discKey === discKey);
      return { defaults: mine.at(-1)?.settings ?? null, places: Object.fromEntries(mine.map((p) => [p.playlistId, p])) };
    },
    async outbox() {
      return [...queued.values()];
    },
    async queue(p, pairing) {
      saves.push(p);
      queued.set(placeKey(p), { place: p, pairing, attempts: 0 });
    },
    async sent(key, updatedAt) {
      if ((queued.get(key)?.place.updatedAt ?? Infinity) <= updatedAt) queued.delete(key);
    },
    async failed(key, updatedAt) {
      const e = queued.get(key);
      if (!e || e.place.updatedAt > updatedAt) return;
      if (e.attempts + 1 >= MAX_SEND_ATTEMPTS) queued.delete(key);
      else queued.set(key, { ...e, attempts: e.attempts + 1 });
    },
    async clearOutbox() {
      queued.clear();
    },
    async putTextFiles(discKey, list) {
      files.set(discKey, [...list]);
    },
    async textFiles(discKey) {
      return files.get(discKey) ?? [];
    },
  };
}

type Answer = 'stored' | 'stale' | 'hang' | Error | ((place: PlaybackPlace) => 'stored' | Error);

const PAIRING_A = { deviceId: 'devA', base: 'https://nas.example/bluray/api/' } as NasPairing;
const PAIRING_B = { deviceId: 'devB', base: 'https://nas.example/bluray/api/' } as NasPairing;
const KEY_A = 'devA@https://nas.example/bluray/api/';

/** The NAS: answers each put with `answer` (stored by default), recording what it was sent; paired as `paired`. */
function fakeNas() {
  const nas = {
    sent: [] as { place: PlaybackPlace; keepalive: boolean }[],
    answer: 'stored' as Answer,
    paired: PAIRING_A as NasPairing | null,
    async pairing() {
      return nas.paired;
    },
    async putPlace(place: PlaybackPlace, opts: { keepalive?: boolean } = {}): Promise<'stored' | 'stale'> {
      nas.sent.push({ place, keepalive: opts.keepalive === true });
      const answer = typeof nas.answer === 'function' ? nas.answer(place) : nas.answer;
      if (answer === 'hang') return new Promise(() => {});
      if (answer instanceof Error) throw answer;
      return answer;
    },
  };
  return nas;
}

const placeState = (title = 1): PlaceState => ({ mode: 'hdmv', title, psrs: Array.from({ length: 128 }, (_, i) => (i === 4 ? title : 0)), gprs: { 7: 42 } });

function setup(opts: { levelAudio?: () => number | null; remote?: boolean; target?: Partial<PlaceTarget>; minUs?: number; store?: PlaceStore; log?: (message: string) => void } = {}) {
  let clock = 1_800_000_000_000;
  let opens = 1;
  const timers = new Map<number, { fn: () => void; at: number }>();
  let nextTimer = 0;
  const store = memoryStore();
  const saverStore = opts.store ?? store;
  const nas = fakeNas();
  let registers = placeState();
  let shader: string | null = null;
  const reads: number[] = [];
  const saver = new PlaceSaver({
    store: saverStore,
    nas,
    readPlace: async () => {
      reads.push(opens);
      return registers;
    },
    discOpens: () => opens,
    nowMs: () => clock,
    setTimer: (fn, ms) => {
      timers.set(++nextTimer, { fn, at: clock + ms });
      return nextTimer;
    },
    clearTimer: (id) => timers.delete(id as number),
    minDurationUs: opts.minUs ?? 300 * S,
    ...(opts.levelAudio ? { levelAudio: opts.levelAudio } : {}),
    ...(opts.log ? { log: opts.log } : {}),
  });
  saver.begin({ discKey: KEY, discId: '0123456789abcdef', remote: opts.remote ?? true, chosen: '00001', mainPlaylistId: null, deviceName: 'iPad', pairing: KEY_A, ...opts.target });
  let snap: PlayerSnapshot = { ...INITIAL_SNAPSHOT, playlists: [], currentPlaylistId: '00001', durationUs: 1440 * S, timeUs: 0, engineState: 'playing', selectedAudio: 1 };
  const t = {
    saver,
    store,
    nas,
    reads,
    get snap() {
      return snap;
    },
    setRegisters(p: PlaceState) {
      registers = p;
    },
    setOpens(n: number) {
      opens = n;
    },
    /** Shows the saver a new snapshot (with a new shader set when given). */
    show(change: Partial<PlayerSnapshot>, set?: string | null) {
      snap = { ...snap, ...change };
      if (set !== undefined) shader = set;
      saver.observe(snap, shader);
    },
    /** Moves the clock by `ms`, playback with it while playing, firing timers as they fall due. */
    async play(ms: number) {
      const end = clock + ms;
      for (;;) {
        const due = [...timers.entries()].filter(([, x]) => x.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
        const to = due ? due[1].at : end;
        const step = to - clock;
        clock = to;
        if (snap.engineState === 'playing') t.show({ timeUs: snap.timeUs + step * 1000 });
        if (!due) break;
        timers.delete(due[0]);
        due[1].fn();
        await settle();
      }
      await settle();
    },
  };
  t.show({});
  return t;
}

const settle = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

describe('PlaceSaver', () => {
  it("at a level, the saved PSR1 is the level's audio number", async () => {
    const t = setup({ levelAudio: () => 3 });
    t.show({ timeUs: 600 * S }); // a seek saves at once
    await settle();
    expect(t.store.saves.at(-1)!.settings.psr1).toBe(3);
  });

  it('at the original (no level audio), the saved PSR1 is the engine\'s', async () => {
    const t = setup({ levelAudio: () => null });
    t.show({ timeUs: 600 * S });
    await settle();
    expect(t.store.saves.at(-1)!.settings.psr1).toBe(0); // the engine's register file here
  });

  it('saves every 10 s while playing, and not while paused', async () => {
    const t = setup();
    await t.play(9_999);
    expect(t.store.saves).toHaveLength(0);
    await t.play(1);
    expect(t.store.saves.map((p) => p.timeUs)).toEqual([10 * S]);
    await t.play(10_000);
    expect(t.store.saves.map((p) => p.timeUs)).toEqual([10 * S, 20 * S]);
    t.show({ engineState: 'paused' }); // pause saves at once
    await settle();
    expect(t.store.saves).toHaveLength(3);
    await t.play(60_000);
    expect(t.store.saves).toHaveLength(3);
    const last = t.store.saves[2]!;
    expect(last).toMatchObject({ discKey: KEY, discId: '0123456789abcdef', playlistId: '00001', timeUs: 20 * S, mode: 'hdmv', title: 1, deviceName: 'iPad', gprs: { 7: 42 } });
    expect(t.nas.sent.map((s) => s.place.timeUs)).toEqual([10 * S, 20 * S, 20 * S]);
    expect(t.store.queued.size).toBe(0);
  });

  it('saves at once on a seek, a track change, an offset change and a shader change', async () => {
    const t = setup();
    await t.play(3_000);
    t.show({ timeUs: 600 * S }); // seek
    await settle();
    expect(t.store.saves.map((p) => p.timeUs)).toEqual([600 * S]);
    t.show({ selectedAudio: 2 });
    await settle();
    expect(t.store.saves).toHaveLength(2);
    const file: TextFileInfo = { name: 'ep1.ass', format: 'ass', cues: 10, startUs: 0, offsetMs: 0 };
    t.show({ subtitles: { pg: [], text: { files: [file], missingFonts: [], episodeStarts: [] }, selected: 'text', scale: 1 } });
    await settle();
    t.show({ subtitles: { pg: [], text: { files: [{ ...file, offsetMs: 400 }], missingFonts: [], episodeStarts: [] }, selected: 'text', scale: 1 } });
    await settle();
    expect(t.store.saves).toHaveLength(4);
    expect(t.store.saves[3]!.settings.textFiles).toEqual([{ name: 'ep1.ass', size: 0, startUs: 0, offsetMs: 400 }]);
    t.show({}, 'Anime4K: Mode A (Fast)');
    await settle();
    expect(t.store.saves.at(-1)!.settings.shaderSet).toBe('Anime4K: Mode A (Fast)');
    await t.play(1_000); // playing on is no trigger
    expect(t.store.saves).toHaveLength(5);
  });

  it("keeps an episode's place when a short menu playlist follows it, saving the episode where it stopped", async () => {
    const t = setup({ target: { chosen: null } });
    await t.play(10_000);
    expect(t.store.saves).toHaveLength(1);
    await t.play(5_000);
    // the episode stops at 15 s and the disc's 30 s menu loop plays
    t.setRegisters(placeState(9));
    t.show({ currentPlaylistId: '00099', durationUs: 30 * S, timeUs: 0 });
    await settle();
    expect(t.store.saves.map((p) => [p.playlistId, p.timeUs, p.title])).toEqual([['00001', 10 * S, 1], ['00001', 15 * S, 1]]);
    await t.play(30_000);
    t.show({ engineState: 'paused' });
    await settle();
    expect(t.store.saves.every((p) => p.playlistId === '00001')).toBe(true);
    expect(t.store.saves).toHaveLength(2);
  });

  it("saves an encode's place under its key, with no program state, as often as a disc's", async () => {
    const t = setup({ target: { discKey: 'e.100.3', discId: '100-3', chosen: 'mkv', mainPlaylistId: 'mkv', encode: true } });
    t.show({ currentPlaylistId: 'mkv', durationUs: 120 * S, timeUs: 0 }); // short, but the episode is what was launched
    await settle();
    expect(t.store.saves).toHaveLength(0);
    await t.play(10_000);
    expect(t.store.saves.map((p) => p.timeUs)).toEqual([10 * S]);
    t.show({ engineState: 'paused' });
    await settle();
    expect(t.store.saves).toHaveLength(2);
    expect(t.store.saves.at(-1)).toMatchObject({ discKey: 'e.100.3', discId: '100-3', playlistId: 'mkv', mode: 'none', title: null, psrs: [], gprs: null, finished: false });
    expect(t.nas.sent.at(-1)!.place.psrs).toEqual([]);
  });

  it("an encode's place is finished by its chapters, as a disc's is", async () => {
    const chapters: PlayerSnapshot['chapters'] = [{ index: 0, startUs: 0 }, { index: 1, startUs: 1300 * S, name: 'Ending' }];
    const t = setup({ target: { discKey: 'e.100.3', discId: '100-3', chosen: 'mkv', mainPlaylistId: 'mkv', encode: true } });
    t.show({ currentPlaylistId: 'mkv', chapters });
    t.show({ timeUs: 1310 * S }); // a seek into the Ending saves at once
    await settle();
    expect(t.store.saves.at(-1)).toMatchObject({ timeUs: 1310 * S, finished: true });
  });

  it('Next episode saves the episode finished first, and answers the place it saved', async () => {
    const t = setup({ target: { discKey: 'e.100.3', discId: '100-3', chosen: 'mkv', mainPlaylistId: 'mkv', encode: true } });
    t.show({ currentPlaylistId: 'mkv', timeUs: 600 * S, engineState: 'paused' });
    await settle();
    const before = t.store.saves.length;
    const place = await t.saver.finishNow();
    expect(place).toMatchObject({ discKey: 'e.100.3', timeUs: 600 * S, finished: true, mode: 'none', psrs: [] });
    expect(t.store.saves).toHaveLength(before + 1);
    expect(t.store.saves.at(-1)!.finished).toBe(true);
    t.saver.end();
    expect(await t.saver.finishNow()).toBeNull();
  });

  it('marks a place finished when its playlist ends', async () => {
    const t = setup();
    await t.play(10_000);
    t.show({ engineState: 'ended', timeUs: 1440 * S });
    await settle();
    expect(t.store.saves.at(-1)).toMatchObject({ timeUs: 1440 * S, finished: true });
  });

  it('marks a place finished when a disc program moves on within a second of its end', async () => {
    // a film whose last chapter starts before 90%: isFinished alone never calls it finished
    const chapters: PlayerSnapshot['chapters'] = [{ index: 0, startUs: 0 }, { index: 1, startUs: 1200 * S }];
    const t = setup({ target: { chosen: null } });
    t.show({ chapters });
    await t.play(10_000); // registers read
    t.show({ timeUs: 1440 * S - 250_000 }); // played on to the end (a seek as the saver sees it)
    await settle();
    // the navigator replaces the session before the player says ended: the next snapshot is the menu
    t.show({ currentPlaylistId: '00099', durationUs: 30 * S, timeUs: 0 });
    await settle();
    expect(t.store.saves.at(-1)).toMatchObject({ playlistId: '00001', timeUs: 1440 * S - 250_000, finished: true });

    const u = setup({ target: { chosen: null } });
    u.show({ chapters });
    await u.play(10_000);
    u.show({ timeUs: 1440 * S - 1_500_000 }); // 1.5 s before the end: left mid-playlist, still unfinished
    await settle();
    u.show({ currentPlaylistId: '00099', durationUs: 30 * S, timeUs: 0 });
    await settle();
    expect(u.store.saves.at(-1)).toMatchObject({ playlistId: '00001', finished: false });
  });

  it("never puts a NAS disc's place in the device's places, so a local copy of the disc never sees it", async () => {
    const t = setup();
    await t.play(10_000);
    t.show({ engineState: 'paused' });
    await settle();
    await t.saver.flushNow({ keepalive: true });
    await t.saver.flushNow({ keepalive: false });
    expect(t.store.puts).toEqual([]);
    expect(t.nas.sent.length).toBeGreaterThan(0);
    // the same fingerprint opened from a local folder: nothing on this device
    expect(await t.saver.placesOf(KEY)).toEqual({ defaults: null, places: {} });
  });

  it('keeps a place in the outbox while the NAS is unreachable and sends it later', async () => {
    const t = setup();
    t.nas.answer = new Error("Couldn't reach the NAS.");
    await t.play(10_000);
    expect(t.store.saves).toHaveLength(1); // on the device all the same
    expect([...t.store.queued.values()].map((e) => [e.place.timeUs, e.pairing])).toEqual([[10 * S, KEY_A]]);
    t.nas.answer = 'stored';
    await t.saver.drainOutbox();
    expect(t.store.queued.size).toBe(0);
    expect(t.nas.sent.at(-1)!.place.timeUs).toBe(10 * S);
  });

  it('drops an outbox place the NAS answers stale for, or refuses for good', async () => {
    const t = setup();
    t.nas.answer = 'stale';
    await t.play(10_000);
    expect(t.nas.sent).toHaveLength(1);
    expect(t.store.queued.size).toBe(0);
    t.nas.answer = new NasHttpError(413, null);
    await t.play(10_000);
    expect(t.nas.sent).toHaveLength(2);
    expect(t.store.queued.size).toBe(0);
  });

  it('passes keepalive on a flush for a page being hidden, and keeps a local disc on the device', async () => {
    const t = setup();
    await t.play(3_000);
    await t.saver.flushNow({ keepalive: true });
    expect(t.nas.sent.map((s) => [s.place.timeUs, s.keepalive])).toEqual([[3 * S, true]]);
    const local = setup({ remote: false });
    await local.play(10_000);
    await local.saver.flushNow({ keepalive: true });
    expect(local.store.puts).toHaveLength(2);
    expect(local.nas.sent).toHaveLength(0);
    expect(local.store.queued.size).toBe(0);
  });

  it("hands a launch's settings to the player once, only while the disc they came with is open", () => {
    const t = setup();
    const settings = { audioLanguage: 'jpn', pgLanguage: null, textFiles: [], psr1: 2, psr2: 0, psr3: 1, textOn: false, textScale: 1, shaderSet: 'Mode A', volume: 0.5, muted: false };
    const target: PlaceTarget = { discKey: KEY, discId: 'x', remote: true, chosen: '00001', mainPlaylistId: null, deviceName: 'iPad', pairing: KEY_A };
    t.saver.begin(target, { settings, byLanguage: true });
    expect(t.saver.takeLaunchSettings()).toEqual({ settings, byLanguage: true, discKey: KEY });
    expect(t.saver.takeLaunchSettings()).toBeNull();
    t.saver.begin(target, { settings, byLanguage: false });
    t.setOpens(2); // another disc opened before the player took them
    expect(t.saver.takeLaunchSettings()).toBeNull();
    t.saver.begin({ ...target, remote: false, discKey: 'd.0123456789abcdef' }, { settings, byLanguage: false });
    expect(t.saver.takeLaunchSettings()).toMatchObject({ discKey: 'd.0123456789abcdef' }); // applied even where nothing is saved
    t.saver.begin(target, { settings, byLanguage: false });
    t.saver.end();
    expect(t.saver.takeLaunchSettings()).toBeNull();
  });

  it('saves nothing for a local disc without a fingerprint', async () => {
    const t = setup({ remote: false, target: { discKey: 'd.0123456789abcdef' } });
    await t.play(20_000);
    await t.saver.flushNow({ keepalive: false });
    expect(t.store.saves).toHaveLength(0);
  });

  it("never saves registers read after another disc opened, but keeps a save made just before a close", async () => {
    const t = setup();
    await t.play(3_000);
    void t.saver.flushNow({ keepalive: false }); // the close's save: read before the close
    t.saver.end();
    t.setOpens(2); // closeDisc
    await settle();
    expect(t.reads).toEqual([1]);
    expect(t.store.saves.map((p) => p.timeUs)).toEqual([3 * S]);

    const u = setup();
    await u.play(3_000);
    u.setOpens(2); // another disc opened without this one being ended
    await u.saver.flushNow({ keepalive: false });
    u.show({ engineState: 'paused' });
    await settle();
    expect(u.reads).toEqual([]);
    expect(u.store.saves).toHaveLength(0);
  });

  it('sends nothing queued under one pairing to another, and empties the outbox when asked', async () => {
    const t = setup();
    t.nas.answer = new Error("Couldn't reach the NAS.");
    await t.play(10_000);
    expect(t.store.queued.size).toBe(1);
    t.nas.answer = 'stored';
    t.nas.paired = PAIRING_B; // paired again, as another person
    const before = t.nas.sent.length;
    await t.saver.drainOutbox();
    expect(t.nas.sent).toHaveLength(before);
    expect(t.store.queued.size).toBe(0);

    const u = setup();
    u.nas.answer = new Error("Couldn't reach the NAS.");
    await u.play(10_000);
    await u.saver.clearOutbox(); // forgotten
    expect(u.store.queued.size).toBe(0);
  });

  it('never holds the device writes behind a NAS request that hangs', async () => {
    const t = setup();
    t.nas.answer = 'hang';
    await t.play(10_000);
    t.show({ engineState: 'paused' });
    await settle();
    expect(t.store.saves.map((p) => p.timeUs)).toEqual([10 * S, 10 * S]);
    await t.saver.flushNow({ keepalive: true });
    expect(t.store.saves).toHaveLength(3);
  });

  it("still sends the place to the NAS when the device's store fails", async () => {
    const failing = memoryStore();
    const broken: PlaceStore = { ...failing, put: () => Promise.reject(new Error('QuotaExceededError')), queue: () => Promise.reject(new Error('QuotaExceededError')) };
    const logged: string[] = [];
    const t = setup({ store: broken, log: (m) => logged.push(m) });
    await t.play(10_000);
    expect(t.nas.sent.map((s) => s.place.timeUs)).toEqual([10 * S]);
    expect(logged).toContain('queueing the place failed');
  });

  it('skips a place the NAS keeps refusing, and drops it after the fifth refusal', async () => {
    const t = setup();
    t.nas.answer = new Error("Couldn't reach the NAS.");
    await t.play(10_000); // 00001 waits
    t.show({ currentPlaylistId: '00002', durationUs: 1440 * S, timeUs: 0 }); // another episode
    await t.play(10_000); // 00002 waits
    expect(t.store.queued.size).toBe(2);
    t.nas.answer = (p) => (p.playlistId === '00001' ? new NasHttpError(500, null) : 'stored');
    await t.saver.drainOutbox();
    expect([...t.store.queued.values()].map((e) => [e.place.playlistId, e.attempts])).toEqual([['00001', 1]]);
    for (let i = 1; i < MAX_SEND_ATTEMPTS; i++) await t.saver.drainOutbox();
    expect(t.store.queued.size).toBe(0);
  });

  it("keeps places a NAS without the place routes answers 404 to, and drops one it calls a bad key", async () => {
    const t = setup();
    t.nas.answer = new NasHttpError(404, 'not found');
    await t.play(10_000);
    await t.saver.drainOutbox();
    expect([...t.store.queued.values()].map((e) => e.attempts)).toEqual([0]);
    t.nas.answer = new NasHttpError(404, 'bad-key');
    await t.saver.drainOutbox();
    expect(t.store.queued.size).toBe(0);
  });

  it('sends nothing directly to a pairing made after the disc opened: neither a page-hide flush nor a store-failed save', async () => {
    const t = setup();
    await t.play(10_000); // registers read: a page-hide flush won't wait for the engine
    const before = t.nas.sent.length;
    t.nas.paired = PAIRING_B;
    await t.saver.pairingChanged();
    await t.saver.flushNow({ keepalive: true });
    expect(t.nas.sent.slice(before)).toEqual([]);

    const failing = memoryStore();
    const broken: PlaceStore = { ...failing, put: () => Promise.reject(new Error('QuotaExceededError')), queue: () => Promise.reject(new Error('QuotaExceededError')) };
    const u = setup({ store: broken, log: () => {} });
    u.nas.paired = PAIRING_B; // paired again without the saver hearing of it
    await u.play(10_000);
    expect(u.nas.sent).toEqual([]);
  });

  it('stops sending through a pairing made while the outbox goes out', async () => {
    const t = setup();
    t.nas.answer = new Error("Couldn't reach the NAS.");
    await t.play(10_000);
    t.show({ currentPlaylistId: '00002', durationUs: 1440 * S, timeUs: 0 });
    await t.play(10_000);
    expect(t.store.queued.size).toBe(2);
    const before = t.nas.sent.length;
    t.nas.answer = () => {
      t.nas.paired = PAIRING_B; // paired again as the first one goes
      return 'stored';
    };
    await t.saver.drainOutbox();
    expect(t.nas.sent.slice(before).map((x) => x.place.playlistId)).toEqual(['00001']);
    expect(t.store.queued.size).toBe(0); // the other pairing's place is let go
  });

  it('waits out a NAS that answers 503, 502, 504 or 429, never dropping the place', async () => {
    const t = setup();
    t.nas.answer = new NasHttpError(503, null);
    await t.play(10_000);
    for (let i = 0; i < MAX_SEND_ATTEMPTS; i++) await t.saver.drainOutbox();
    for (const status of [502, 504, 429]) {
      t.nas.answer = new NasHttpError(status, null);
      await t.saver.drainOutbox();
    }
    expect([...t.store.queued.values()].map((e) => e.attempts)).toEqual([0]);
  });

  it('never reads a file over the limit, keeps one copy of a font, and keeps fonts through a new subtitle pick', async () => {
    const t = setup();
    const huge = new File([], 'huge.ttf');
    Object.defineProperty(huge, 'size', { value: MAX_TEXT_FILE_BYTES + 1 });
    huge.arrayBuffer = () => Promise.reject(new Error('read'));
    await t.saver.addTextFiles([new File(['a'], 'ep1.ass'), new File([new Uint8Array(8)], 'font.ttf'), huge]);
    expect(t.store.files.get(KEY)?.map((f) => f.name)).toEqual(['ep1.ass', 'font.ttf']);
    await t.saver.addTextFiles([new File([new Uint8Array(9)], 'font.ttf')]);
    expect(t.store.files.get(KEY)?.map((f) => [f.name, f.bytes.byteLength])).toEqual([['ep1.ass', 1], ['font.ttf', 9]]);
    await t.saver.addTextFiles([new File(['b'], 'ep2.ass')]);
    expect(t.store.files.get(KEY)?.map((f) => f.name)).toEqual(['font.ttf', 'ep2.ass']);
  });

  it("gives text files their sizes, keeps their bytes for this device, and sends at most 64", async () => {
    const t = setup();
    const ass = new File(['[Script Info]'], 'ep1.ass');
    const font = new File([new Uint8Array(8)], 'font.ttf');
    await t.saver.addTextFiles([ass, font]);
    expect(t.store.files.get(KEY)?.map((f) => [f.name, f.bytes.byteLength])).toEqual([['ep1.ass', 13], ['font.ttf', 8]]);
    // fonts alone are added to the set
    await t.saver.addTextFiles([new File([new Uint8Array(4)], 'more.otf')]);
    expect(t.store.files.get(KEY)?.map((f) => f.name)).toEqual(['ep1.ass', 'font.ttf', 'more.otf']);
    const files = Array.from({ length: 70 }, (_, i): TextFileInfo => ({ name: i === 0 ? 'ep1.ass' : `x${i}.srt`, format: 'srt', cues: 1, startUs: null, offsetMs: 0 }));
    t.show({ subtitles: { pg: [], text: { files, missingFonts: [], episodeStarts: [] }, selected: 'text', scale: 1 } });
    await settle();
    const sent = t.nas.sent.at(-1)!.place.settings.textFiles;
    expect(sent).toHaveLength(64);
    expect(sent[0]).toEqual({ name: 'ep1.ass', size: 13, startUs: null, offsetMs: 0 });
  });

  it('saves a stored subtitle with its id, language and size, beside a local file', async () => {
    const t = setup();
    await t.saver.addTextFiles([new File(['abc'], 'mine.srt')]);
    t.saver.noteStoredSubtitle('ep1.ass', 'sub-1', 120, 'en');
    const files: TextFileInfo[] = [
      { name: 'ep1.ass', format: 'ass', cues: 1, startUs: 0, offsetMs: 900 },
      { name: 'mine.srt', format: 'srt', cues: 1, startUs: null, offsetMs: 0 },
    ];
    t.show({ subtitles: { pg: [], text: { files, missingFonts: [], episodeStarts: [] }, selected: 'text', scale: 1 } });
    await settle();
    expect(t.nas.sent.at(-1)!.place.settings.textFiles).toEqual([
      { name: 'ep1.ass', size: 120, startUs: 0, offsetMs: 900, subtitleId: 'sub-1', language: 'en' },
      { name: 'mine.srt', size: 3, startUs: null, offsetMs: 0 },
    ]);
  });

  it("saves a viewer's Anime Tosho pick with its release, file and track, never as a stored subtitle", async () => {
    const t = setup();
    t.saver.noteStoredSubtitle('ep1.ass', 'sub-1', 120, 'en');
    // a pick replaces the set, and so the stored subtitle's note
    t.saver.noteFansubPick('pick.ass', { releaseId: 7001, fileId: 7101, track: 0, trackName: 'Full' }, 90, 'eng');
    const files: TextFileInfo[] = [{ name: 'pick.ass', format: 'ass', cues: 1, startUs: 0, offsetMs: 200 }];
    t.show({ subtitles: { pg: [], text: { files, missingFonts: [], episodeStarts: [] }, selected: 'text', scale: 1 } });
    await settle();
    expect(t.nas.sent.at(-1)!.place.settings.textFiles).toEqual([
      { name: 'pick.ass', size: 90, startUs: 0, offsetMs: 200, language: 'eng', fansub: { releaseId: 7001, fileId: 7101, track: 0, trackName: 'Full' } },
    ]);
  });

  it('keeps the stored subtitle and sizes in the save a close starts, though the disc ends before it is written', async () => {
    const t = setup();
    await t.saver.addTextFiles([new File(['abc'], 'mine.srt')]);
    t.saver.noteStoredSubtitle('ep1.ass', 'sub-1', 120, 'en');
    const files: TextFileInfo[] = [
      { name: 'ep1.ass', format: 'ass', cues: 1, startUs: 0, offsetMs: 900 },
      { name: 'mine.srt', format: 'srt', cues: 1, startUs: null, offsetMs: 0 },
    ];
    t.show({ subtitles: { pg: [], text: { files, missingFonts: [], episodeStarts: [] }, selected: 'text', scale: 1 } });
    await settle();
    const before = t.nas.sent.length;
    void t.saver.flushNow({ keepalive: false });
    t.saver.end();
    await settle();
    expect(t.nas.sent.length).toBeGreaterThan(before);
    expect(t.nas.sent.at(-1)!.place.settings.textFiles).toEqual([
      { name: 'ep1.ass', size: 120, startUs: 0, offsetMs: 900, subtitleId: 'sub-1', language: 'en' },
      { name: 'mine.srt', size: 3, startUs: null, offsetMs: 0 },
    ]);
  });

  it('notes a stored subtitle by file name until a local subtitle pick replaces the set or the disc closes', async () => {
    const t = setup();
    t.saver.noteStoredSubtitle('ep1.ass', 'sub-1', 120, 'en');
    expect([...t.saver.storedSubtitleNotes()]).toEqual([['ep1.ass', { id: 'sub-1', size: 120, language: 'en' }]]);
    // a stored pick replaces the set, and so the earlier note
    t.saver.noteStoredSubtitle('ep2.ass', 'sub-2', 80, 'ja');
    expect([...t.saver.storedSubtitleNotes()]).toEqual([['ep2.ass', { id: 'sub-2', size: 80, language: 'ja' }]]);
    // fonts alone keep it
    await t.saver.addTextFiles([new File([new Uint8Array(4)], 'more.otf')]);
    expect([...t.saver.storedSubtitleNotes().keys()]).toEqual(['ep2.ass']);
    await t.saver.addTextFiles([new File(['a'], 'mine.srt')]);
    expect([...t.saver.storedSubtitleNotes()]).toEqual([]);
    t.saver.noteStoredSubtitle('ep1.ass', 'sub-1', 120, 'en');
    t.saver.end();
    expect([...t.saver.storedSubtitleNotes()]).toEqual([]);
    // with no disc being saved, a note is ignored
    t.saver.noteStoredSubtitle('ep1.ass', 'sub-1', 120, 'en');
    expect([...t.saver.storedSubtitleNotes()]).toEqual([]);
  });
});
