import { spawnSync } from 'node:child_process';
import { copyFileSync, cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import SevenZip from '7z-wasm';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { isFansub, isRelease } from '@seikou/nas/nas-api';
import type { DiscSlot, EpisodeRef, FansubAlignment, StoredSubtitle, TitleDetail, TitleSummary } from '@seikou/nas/nas-api';
import { SPEECH_BURSTS } from '../../../tests/helpers/speech-bursts';
import { DiscActivity } from '../disc-activity';
import { folderDiscSource } from '../levels/level-discs';
import { FANSUB_LIMIT_BYTES, SubtitleStore } from '../subtitle-store';
import type { Catalogue } from '@seikou/titles/catalogue';
import { SourceUnavailable } from '@seikou/titles/sources';
import { FetchCache } from '@seikou/fansubs/fetch-cache';
import { ffmpegAudioDecoder } from './ffmpeg-decoder';
import { fixtureFansubSources } from '@seikou/fansubs/fixture-sources';
import type { SeaDexEntry } from '@seikou/fansubs/seadex';
import { FansubService } from './service';
import { FansubState } from './state';
import type { Tosho, ToshoRelease } from '@seikou/fansubs/tosho';

const hasAc3 = spawnSync('ffmpeg', ['-hide_banner', '-decoders'], { encoding: 'utf8' }).stdout?.includes(' ac3 ') ?? false;
/** CI installs ffmpeg: there, a missing AC-3 decoder fails these tests instead of skipping them. */
const runFfmpegTests = hasAc3 || Boolean(process.env.CI);

const TITLE = 'anilist:900001';
const SEASON = 'anilist:900001#season';
const OTHER_TITLE = 'anilist:900002';
const HASH_A = 'a'.repeat(40);
const HASH_B = 'b'.repeat(40);

const HEAD = `[Script Info]
ScriptType: v4.00+

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Default,Arial,20,&H00FFFFFF,&H000000FF,&H00000000,&H00000000,0,0,0,0,100,100,0,0,1,2,2,2,10,10,10,1
Style: Signs,Arial,20,&H00FFFFFF,&H000000FF,&H00000000,&H00000000,0,0,0,0,100,100,0,0,1,2,2,2,10,10,10,1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
`;

function time(ms: number): string {
  const cs = Math.round(ms / 10);
  const p2 = (n: number): string => String(n).padStart(2, '0');
  return `${Math.floor(cs / 360000)}:${p2(Math.floor(cs / 6000) % 60)}:${p2(Math.floor(cs / 100) % 60)}.${p2(cs % 100)}`;
}

/** The disc's speech, 800 ms late: lined up, it moves by −800 ms. */
const FULL = HEAD + SPEECH_BURSTS.map((b, i) => `Dialogue: 0,${time(b.fromMs + 800)},${time(b.toMs + 800)},Default,,0,0,0,,Line ${i}\n`).join('');
const SIGNS = HEAD + [10_000, 50_000, 90_000].map((at, i) => `Dialogue: 0,${time(at)},${time(at + 3000)},Signs,,0,0,0,,{\\pos(100,100)}Sign ${i}\n`).join('');

const wasmBinary = (): ArrayBuffer => readFileSync(new URL('../../../node_modules/7z-wasm/7zz.wasm', import.meta.url)).buffer as ArrayBuffer;
async function xz(data: Buffer): Promise<Buffer> {
  const sz = await SevenZip({ wasmBinary: wasmBinary(), print: () => {}, printErr: () => {}, stdout: () => {} });
  sz.FS.writeFile('t.ass', data);
  sz.callMain(['a', '-txz', '-mx1', 't.ass.xz', 't.ass']);
  return Buffer.from(sz.FS.readFile('t.ass.xz'));
}

let fullXz: Buffer;
let signsXz: Buffer;
let bigXz: Buffer;
beforeAll(async () => {
  fullXz = await xz(Buffer.from(FULL));
  signsXz = await xz(Buffer.from(SIGNS));
  // Just over the 50 MB cap once unpacked.
  bigXz = await xz(Buffer.alloc(50 * 1024 * 1024 + 1, 'a'));
}, 60_000);

const trackUrl = (fileId: number, track: number): string => `https://animetosho.net/storage/attach/0/${fileId}-${track}.ass.xz`;
const file = (id: number, name: string, language = 'eng'): ToshoRelease['files'][number] => ({
  id, name, size: 1000,
  tracks: [
    { track: 0, language, name: 'Full', format: 'ASS', url: trackUrl(id, 0), isDefault: true, forced: false },
    { track: 1, language, name: 'Signs', format: 'ASS', url: trackUrl(id, 1), isDefault: false, forced: false },
  ],
});

const SEADEX: Record<string, SeaDexEntry> = {
  900001: {
    alId: 900001, incomplete: false, notes: '', comparison: '',
    releases: [
      { tracker: 'Nyaa', infoHash: HASH_A, isBest: true, dualAudio: false, group: 'GroupA', tags: [], files: [] },
      { tracker: 'Nyaa', infoHash: HASH_B, isBest: false, dualAudio: false, group: 'GroupB', tags: ['WEB'], files: [] },
    ],
  },
};
const TOSHO: ToshoRelease[] = [
  { id: 1, title: '[GroupA] Starfall Wanderer (BD 1080p)', infoHash: HASH_A, status: 'complete', isSeadex: true, date: 0, files: [file(101, '[GroupA] Starfall Wanderer - 01 (BD 1080p).mkv')] },
  {
    id: 2, title: '[GroupB] Starfall Wanderer (WEB 1080p)', infoHash: HASH_B, status: 'complete', isSeadex: true, date: 0,
    files: [file(201, '[GroupB] Starfall Wanderer - 01 (WEB 1080p).mkv'), file(202, '[GroupB] Starfall Wanderer - 02 (WEB 1080p).mkv', 'en')],
  },
];

const summary = (id: string): TitleSummary => ({
  id, kind: 'series', names: { english: 'Starfall Wanderer', romaji: null, native: null, synonyms: [], display: 'Starfall Wanderer' },
  poster: null, year: 2020, seasons: 1, discs: 1, addedAt: 0, own: false,
});
const slot: DiscSlot = { number: 1, label: 'Disc 1', copies: [{ discId: 'speech', root: 'r', folder: 'Starfall Wanderer', displayName: null }] };
const episodes: EpisodeRef[] = [
  { number: 1, name: null, runtimeMin: null, discId: 'speech', playlistId: '00000' },
  { number: 2, name: null, runtimeMin: null, discId: 'speech', playlistId: '00001' },
];
/** What the catalogue says now (a test moves an episode to another playlist). */
let currentEpisodes: EpisodeRef[] = episodes;
const detail = (id: string): TitleDetail => ({
  title: summary(id), banner: null, related: [], extras: [],
  seasons: [{ id: `${id}#season`, label: 'Starfall Wanderer', number: 1, discs: [slot], episodes: currentEpisodes, extras: [] }],
});
const catalogue = (ids: readonly string[]): Catalogue => ({
  titles: ids.map(summary), detail: (id) => (ids.includes(id) ? detail(id) : null), unsorted: [], hidden: [], art: () => null, provisional: [],
});

let root: string;
let discDir: string;
let fixDir: string;
let dataDir: string;
let services: FansubService[] = [];

/** Writes the SeaDex and Tosho fixtures; `files` maps a download's name to its bytes. */
function writeFixtures(files: Record<string, Buffer>): void {
  rmSync(fixDir, { recursive: true, force: true });
  mkdirSync(join(fixDir, 'files'), { recursive: true });
  writeFileSync(join(fixDir, 'seadex.json'), JSON.stringify(SEADEX));
  writeFileSync(join(fixDir, 'tosho.json'), JSON.stringify({ releases: TOSHO }));
  for (const [name, data] of Object.entries(files)) writeFileSync(join(fixDir, 'files', name), data);
}
const standardFiles = (): Record<string, Buffer> => ({
  '101-0.ass.xz': fullXz, '101-1.ass.xz': signsXz,
  '201-0.ass.xz': fullXz, '201-1.ass.xz': signsXz,
  '202-0.ass.xz': fullXz, '202-1.ass.xz': signsXz,
  // GroupA's file has its font pack; GroupB's have none.
  'pack-101.7z': readFileSync(new URL('../../../packages/fansubs/src/__fixtures__/pack.7z', import.meta.url)),
});

beforeEach(() => {
  currentEpisodes = episodes;
  root = mkdtempSync(join(tmpdir(), 'fansub-service-'));
  discDir = join(root, 'disc');
  cpSync(join(import.meta.dirname, '../../../fixtures/synthetic/disc-speech'), discDir, { recursive: true });
  copyFileSync(join(discDir, 'BDMV/PLAYLIST/00000.mpls'), join(discDir, 'BDMV/PLAYLIST/00001.mpls'));
  fixDir = join(root, 'fixtures');
  dataDir = join(root, 'data');
  mkdirSync(dataDir);
  writeFixtures(standardFiles());
});
afterEach(() => {
  for (const s of services) s.close();
  services = [];
  rmSync(root, { recursive: true, force: true });
});

interface Setup {
  readonly svc: FansubService;
  readonly store: SubtitleStore;
  readonly state: FansubState;
  readonly clock: { t: number };
  readonly sleeps: number[];
  readonly activity: DiscActivity;
}

/** A stand-in for the line-up: answers `answer` and keeps the scripts it was given. */
function fakeAligner(answer: FansubAlignment): { calls: string[]; align: NonNullable<Parameters<typeof setup>[0]>['aligner'] } {
  const calls: string[] = [];
  return { calls, align: async (_disc, _playlist, _ms, ass) => { calls.push(ass); return answer; } };
}

function setup(over: { tosho?: (t: Tosho) => Tosho; titles?: readonly string[]; align?: boolean; startAt?: number; realSleep?: boolean;
  aligner?: ConstructorParameters<typeof FansubService>[0]['aligner'];
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>; windowEnd?: { hour: number; minute: number }; maxFansubBytes?: number; log?: (m: string) => void;
} = {}): Setup {
  const clock = { t: over.startAt ?? new Date(2026, 9, 24, 2, 0).getTime() };
  const now = (): number => clock.t;
  const sleeps: number[] = [];
  const store = new SubtitleStore(dataDir, { now, ...(over.maxFansubBytes !== undefined ? { maxFansubBytes: over.maxFansubBytes } : {}) });
  const state = new FansubState(dataDir);
  const sources = fixtureFansubSources(fixDir);
  const activity = new DiscActivity(now);
  const svc = new FansubService({
    store, state, seadex: sources.seadex, tosho: over.tosho ? over.tosho(sources.tosho) : sources.tosho,
    // a cache of its own: a later setup in the same test fetches the fixtures as they are then
    cache: new FetchCache(join(dataDir, `fansub-cache-${services.length}`), 1 << 30),
    titles: { catalogue: () => catalogue(over.titles ?? [TITLE]) },
    discs: async (id) => (id === 'speech' ? folderDiscSource(discDir, { id: 'speech', name: 'Speech' }) : null),
    discKey: (id) => `d.${id}`,
    // Without a duration nothing is lined up: the tests that don't look at the alignment skip ffmpeg.
    durationMs: () => (over.align || over.aligner ? 150_000 : null),
    ...(over.aligner ? { aligner: over.aligner } : {}),
    decoder: ffmpegAudioDecoder('ffmpeg'), activity, encoding: () => false, now, log: over.log ?? (() => {}),
    ...(over.realSleep ? {} : { sleep: over.sleep ?? (async (ms: number) => { sleeps.push(ms); clock.t += ms; }) }),
    ...(over.windowEnd ? { windowEnd: over.windowEnd } : {}),
  });
  services.push(svc);
  return { svc, store, state, clock, sleeps, activity };
}

const fansubsOf = (store: SubtitleStore, episode: number): StoredSubtitle[] =>
  store.list().filter((s) => isFansub(s) && s.attachment.kind === 'episode' && s.attachment.episode === episode)
    .sort((a, b) => a.source!.track - b.source!.track);

/** Makes a release upload of `text` on an episode, as the owner's release form does, and lands its file. */
async function releaseUpload(store: SubtitleStore, episode: number, track: number, text: string, opts: { ext?: string; fileName?: string } = {}): Promise<string> {
  const attachment = { kind: 'episode' as const, discKey: 'd.speech', playlistId: episode === 1 ? '00000' : '00001', titleId: TITLE, seasonId: SEASON, episode };
  const { stored } = store.createRelease(
    { name: `GroupR · Track ${track}`, language: 'en', offsetMs: 0, attachment },
    { group: 'GroupR', fileName: opts.fileName ?? `[GroupR] Starfall Wanderer - 0${episode}.mkv`, fileSize: 5000, track, trackName: `Track ${track}` }, [],
  );
  await store.putReleaseFile(stored.id, `track${track}.${opts.ext ?? 'ass'}`, (async function* () { yield Buffer.from(text); })());
  return stored.id;
}
const alignmentOf = (store: SubtitleStore, id: string): FansubAlignment | null | undefined => {
  const s = store.get(id);
  return s && isRelease(s) ? s.source.alignment : undefined;
};
const OFFSET: FansubAlignment = { kind: 'offset', offsetMs: -800, confidence: 0.9 };

describe('FansubService', () => {
  it.skipIf(!runFfmpegTests)('attaches every English track per episode with the right release', async () => {
    const { svc, store } = setup({ align: true });
    const result = await svc.runTitle(TITLE);

    const one = fansubsOf(store, 1);
    expect(one.map((s) => s.name)).toEqual(['GroupA · Full', 'GroupA · Signs']);
    for (const s of one) {
      expect(s.source).toMatchObject({ group: 'GroupA', rank: 'best', tracker: 'Nyaa', toshoFileId: 101, linedUpOn: { discKey: 'd.speech', playlistId: '00000' } });
      expect(s.attachment).toEqual({ kind: 'episode', discKey: 'd.speech', playlistId: '00000', titleId: TITLE, seasonId: SEASON, episode: 1 });
      expect(s.fonts.map((f) => f.name)).toEqual(['Default.ttf']);
      expect(s.fontsMissing).toBeUndefined();
      expect(s.language).toBe('en');
      expect(s.offsetMs).toBe(0);
    }
    const two = fansubsOf(store, 2);
    expect(two.map((s) => s.name)).toEqual(['GroupB · Full', 'GroupB · Signs']);
    for (const s of two) {
      expect(s.source).toMatchObject({ group: 'GroupB', rank: 'web', toshoFileId: 202, linedUpOn: { discKey: 'd.speech', playlistId: '00001' } });
      expect(s.fontsMissing).toBe(true);
      expect(s.fonts).toEqual([]);
      // Tosho's `en` and `eng` are both stored as the tag the app uses.
      expect(s.language).toBe('en');
    }

    // Both tracks of a file share the Full track's offset.
    for (const s of [...one, ...two]) {
      const a = isFansub(s) ? s.source.alignment : null;
      expect(a?.kind).toBe('offset');
      if (a?.kind === 'offset') expect(Math.abs(a.offsetMs + 800)).toBeLessThanOrEqual(20);
    }
    // The stored file is moved back onto the disc's speech; the original stays as fetched.
    const aligned = readFileSync(store.filePath(one[0]!.id)!, 'utf8');
    const firstStart = (text: string): string => /^Dialogue: 0,([^,]+),/m.exec(text)![1]!;
    expect(Math.abs(Number(firstStart(aligned).split(':')[2]) * 1000 - SPEECH_BURSTS[0]!.fromMs)).toBeLessThanOrEqual(20);
    expect(readFileSync(store.originalPath(one[0]!.id)!, 'utf8')).toBe(FULL);

    expect(result).toMatchObject({
      titleId: TITLE, running: false, nothingFound: false, lastRunAt: expect.any(Number),
      seasons: { [SEASON]: { bestGroup: 'GroupA', usedGroups: [{ group: 'GroupA', rank: 'best' }, { group: 'GroupB', rank: 'web' }] } },
      episodes: { [`${SEASON}#1`]: { status: 'attached' }, [`${SEASON}#2`]: { status: 'attached' } },
    });
  }, 60_000);

  it.skipIf(!runFfmpegTests)('marks a track lined up on another playlist, goes back to the original and lines it up again', async () => {
    const { svc, store } = setup({ align: true });
    await svc.runTitle(TITLE);
    const [full] = fansubsOf(store, 1);
    expect(svc.stale(full!)).toBe(false);

    const original = svc.useOriginal(full!.id);
    expect(original?.source?.alignment).toEqual({ kind: 'original' });
    expect(readFileSync(store.filePath(full!.id)!, 'utf8')).toBe(FULL);

    currentEpisodes = [{ ...episodes[0]!, playlistId: '00001' }, episodes[1]!];
    expect(svc.stale(store.get(full!.id)!)).toBe(true);
    const again = await svc.realign(full!.id);
    expect(again?.source?.linedUpOn).toEqual({ discKey: 'd.speech', playlistId: '00001' });
    expect(again?.attachment).toMatchObject({ kind: 'episode', playlistId: '00001', episode: 1 });
    const a = isFansub(again!) ? again.source.alignment : null;
    expect(a?.kind).toBe('offset');
    if (a?.kind === 'offset') expect(Math.abs(a.offsetMs + 800)).toBeLessThanOrEqual(20);
    expect(svc.stale(again!)).toBe(false);
  }, 60_000);

  it("keeps the owner's own upload alongside", async () => {
    const { svc, store } = setup();
    const own = store.create({ name: 'Mine', language: 'eng', offsetMs: 0, attachment: { kind: 'episode', discKey: 'd.speech', playlistId: '00000', titleId: TITLE, seasonId: SEASON, episode: 1 } });
    await store.writeFile(own.id, 'mine.srt', (async function* () { yield Buffer.from('1\n00:00:01,000 --> 00:00:02,000\nHi\n'); })());
    await svc.runTitle(TITLE);
    await svc.runTitle(TITLE);
    expect(store.get(own.id)?.fileSize).toBeGreaterThan(0);
    expect(fansubsOf(store, 1)).toHaveLength(2);
  });

  it("a rerun keeps the owner's offset and name on the same track", async () => {
    const { svc, store } = setup();
    await svc.runTitle(TITLE);
    const [full] = fansubsOf(store, 1);
    store.update(full!.id, { name: 'Main dialogue', offsetMs: 250, language: 'ja' });
    await svc.runTitle(TITLE);
    const again = fansubsOf(store, 1);
    expect(again).toHaveLength(2);
    expect(again[0]!.id).not.toBe(full!.id);
    expect(store.get(full!.id)).toBeNull();
    expect(again[0]).toMatchObject({ name: 'Main dialogue', offsetMs: 250, language: 'ja' });
    expect(again[1]).toMatchObject({ name: 'GroupA · Signs', offsetMs: 0, language: 'en' });
  });

  it('a deleted track stays deleted on the nightly rerun, and comes back after undelete', async () => {
    const { svc, store, state } = setup();
    await svc.runTitle(TITLE);
    const [full] = fansubsOf(store, 1);
    svc.deleted(full!);
    store.delete(full!.id);
    await svc.runTitle(TITLE);
    expect(fansubsOf(store, 1).map((s) => s.source!.track)).toEqual([1]);
    expect(fansubsOf(store, 2)).toHaveLength(2);
    state.undelete(TITLE);
    await svc.runTitle(TITLE);
    expect(fansubsOf(store, 1).map((s) => s.source!.track)).toEqual([0, 1]);
  });

  it('Tosho down: episodes not found with service-unavailable, title still due', async () => {
    const { svc, store, state, clock } = setup({
      tosho: (t) => ({ ...t, byHash: async () => { throw new SourceUnavailable('animetosho: HTTP 503'); } }),
    });
    const result = await svc.runTitle(TITLE);
    expect(result.episodes).toEqual({
      [`${SEASON}#1`]: { status: 'not-found', reason: 'service-unavailable' },
      [`${SEASON}#2`]: { status: 'not-found', reason: 'service-unavailable' },
    });
    expect(result).toMatchObject({ running: false, nothingFound: false, lastRunAt: null });
    expect(state.due([TITLE], clock.t)).toEqual([TITLE]);
    expect(store.list()).toEqual([]);
  });

  it('ignores tracks over 50 MB', async () => {
    writeFixtures({ ...standardFiles(), '101-0.ass.xz': bigXz, '101-1.ass.xz': bigXz });
    const { svc, store } = setup();
    const result = await svc.runTitle(TITLE);
    expect(result.episodes[`${SEASON}#1`]).toEqual({ status: 'not-found', reason: 'too-large' });
    expect(result.episodes[`${SEASON}#2`]).toEqual({ status: 'attached' });
    expect(fansubsOf(store, 1)).toEqual([]);
    expect(fansubsOf(store, 2)).toHaveLength(2);
  }, 30_000);

  it('nightly waits while a disc is being read', async () => {
    const { svc, store, activity, clock, sleeps } = setup();
    const readAt = clock.t;
    activity.note();
    await svc.startNightly();
    expect(sleeps.length).toBeGreaterThan(0);
    expect(sleeps.every((ms) => ms === 30_000)).toBe(true);
    const first = Math.min(...store.list().map((s) => s.uploadedAt));
    expect(first - readAt).toBeGreaterThan(120_000);
    expect(store.list()).toHaveLength(4);
  });

  it("nightly stops at the window's end", async () => {
    const { svc, state, activity } = setup({ titles: [TITLE, OTHER_TITLE], startAt: new Date(2026, 9, 24, 7, 59).getTime(), windowEnd: { hour: 8, minute: 0 } });
    // A viewer holds the first title's first episode until past 08:00.
    activity.note();
    await svc.startNightly();
    expect(state.title(TITLE)).toMatchObject({ running: false, lastRunAt: null });
    expect(state.title(OTHER_TITLE)).toBeNull();
  });

  it('runs one title at a time, and the button on a running title returns its state', async () => {
    let calls = 0;
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const { svc } = setup({
      titles: [TITLE, OTHER_TITLE],
      tosho: (t) => ({ ...t, byHash: async (h, o) => { calls++; await gate; return t.byHash(h, o); } }),
    });
    const first = svc.runTitle(TITLE);
    await new Promise((r) => setTimeout(r, 10));
    expect(svc.runNow(TITLE)).toMatchObject({ titleId: TITLE, running: true });
    const other = svc.runNow(OTHER_TITLE);
    expect(other).toMatchObject({ titleId: OTHER_TITLE, running: true });
    expect(calls).toBe(1);
    release();
    await first;
    // The other title (with no SeaDex entry) runs after, alone, and isn't started twice.
    expect(await svc.runTitle(OTHER_TITLE)).toMatchObject({ running: false, nothingFound: true });
    expect(calls).toBe(2);
  });

  it('close stops a title waiting in the nightly pass, and its timer', async () => {
    const { svc, state, activity } = setup({ realSleep: true });
    activity.note();
    const pass = svc.startNightly();
    await new Promise((r) => setTimeout(r, 20));
    expect(state.title(TITLE)?.running).toBe(true);
    svc.close();
    await pass;
    expect(state.title(TITLE)).toMatchObject({ running: false, lastRunAt: null });
  });

  it('close drops a queued title', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const { svc } = setup({ titles: [TITLE, OTHER_TITLE], tosho: (t) => ({ ...t, byHash: async (h, o) => { await gate; return t.byHash(h, o); } }) });
    const first = svc.runTitle(TITLE);
    const queued = svc.runTitle(OTHER_TITLE);
    await new Promise((r) => setTimeout(r, 10));
    svc.close();
    release();
    await expect(queued).rejects.toThrow('closed');
    await first.catch(() => {});
  });

  it('a rerun against a full fansub budget keeps the old tracks', async () => {
    const first = setup();
    await first.svc.runTitle(TITLE);
    const before = fansubsOf(first.store, 1).map((s) => s.id);
    const used = FANSUB_LIMIT_BYTES - first.store.fansubSwap([], [], []).room;
    // Episode 1's Full track comes back bigger; the budget has no room left.
    writeFixtures({ ...standardFiles(), '101-0.ass.xz': await xz(Buffer.from(`${FULL}; ${'padding '.repeat(500)}\n`)) });
    const { svc, store } = setup({ maxFansubBytes: used });
    const result = await svc.runTitle(TITLE);
    expect(result.episodes[`${SEASON}#1`]).toEqual({ status: 'not-found', reason: 'too-large' });
    expect(fansubsOf(store, 1).map((s) => s.id)).toEqual(before);
    // Episode 2's tracks are the same size: swapped in place.
    expect(result.episodes[`${SEASON}#2`]).toEqual({ status: 'attached' });
    expect(fansubsOf(store, 2)).toHaveLength(2);
  });

  it('caps downloads at 64 MB a track and 256 MB a font pack; a track past its cap is too large', async () => {
    const caps = new Map<string, number | undefined>();
    const { svc } = setup({
      tosho: (t) => ({ ...t, download: async (url, o, max) => {
        caps.set(url, max);
        // the fixture refuses past the cap as the real client does: 10 bytes stands in for a huge download
        return t.download(url, o, url === trackUrl(202, 1) || url === trackUrl(202, 0) ? 10 : max);
      } }),
    });
    const result = await svc.runTitle(TITLE);
    expect(caps.get(trackUrl(101, 0))).toBe(64 * 1024 * 1024);
    expect(caps.get('https://animetosho.net/download/file/101/attachments')).toBe(256 * 1024 * 1024);
    expect(result.episodes[`${SEASON}#2`]).toEqual({ status: 'not-found', reason: 'too-large' });
  });

  it("a track Tosho can't serve leaves its episode for the next run", async () => {
    const { svc, store, state, clock } = setup({
      tosho: (t) => ({ ...t, download: async (url, o) => { if (url === trackUrl(202, 1)) throw new SourceUnavailable('animetosho: HTTP 503'); return t.download(url, o); } }),
    });
    const result = await svc.runTitle(TITLE);
    expect(result.episodes[`${SEASON}#1`]).toEqual({ status: 'attached' });
    expect(result.episodes[`${SEASON}#2`]).toEqual({ status: 'not-found', reason: 'service-unavailable' });
    expect(fansubsOf(store, 2)).toEqual([]);
    expect(result).toMatchObject({ lastRunAt: null, nothingFound: false });
    expect(state.due([TITLE], clock.t)).toEqual([TITLE]);
  });

  it("a font pack Tosho can't serve keeps the episode's old copies", async () => {
    const first = setup();
    await first.svc.runTitle(TITLE);
    const before = fansubsOf(first.store, 2).map((s) => s.id);
    const { svc, store } = setup({
      tosho: (t) => ({ ...t, download: async (url, o) => { if (url === t.fontPackUrl(202)) throw new SourceUnavailable('animetosho: HTTP 503'); return t.download(url, o); } }),
    });
    const result = await svc.runTitle(TITLE);
    expect(result.episodes[`${SEASON}#2`]).toEqual({ status: 'not-found', reason: 'service-unavailable' });
    expect(fansubsOf(store, 2).map((s) => s.id)).toEqual(before);
    expect(result.episodes[`${SEASON}#1`]).toEqual({ status: 'attached' });
  });

  it("a better release Tosho can't look up keeps the episodes a lesser one would replace", async () => {
    const first = setup();
    await first.svc.runTitle(TITLE);
    const before = [1, 2].map((n) => fansubsOf(first.store, n).map((s) => s.id));
    const { svc, store, state, clock } = setup({
      tosho: (t) => ({ ...t, byHash: async (h, o) => { if (h === HASH_A) throw new SourceUnavailable('animetosho: HTTP 503'); return t.byHash(h, o); } }),
    });
    const result = await svc.runTitle(TITLE);
    // GroupB covers both episodes, but GroupA (SeaDex's best) may have them once Tosho answers.
    expect(result.episodes).toEqual({
      [`${SEASON}#1`]: { status: 'not-found', reason: 'service-unavailable' },
      [`${SEASON}#2`]: { status: 'not-found', reason: 'service-unavailable' },
    });
    expect([1, 2].map((n) => fansubsOf(store, n).map((s) => s.id))).toEqual(before);
    expect(state.due([TITLE], clock.t)).toEqual([TITLE]);
  });

  it('skips a track that unpacks to nothing', async () => {
    const empty = await xz(Buffer.alloc(0));
    writeFixtures({ ...standardFiles(), '101-0.ass.xz': empty, '202-0.ass.xz': empty, '202-1.ass.xz': empty });
    const { svc, store } = setup();
    const result = await svc.runTitle(TITLE);
    expect(result.episodes[`${SEASON}#1`]).toEqual({ status: 'attached' });
    expect(fansubsOf(store, 1).map((s) => s.source!.track)).toEqual([1]);
    expect(result.episodes[`${SEASON}#2`]).toEqual({ status: 'not-found', reason: 'no-tracks' });
  });

  it('nightly runs only at night', async () => {
    const day = setup({ startAt: new Date(2026, 9, 24, 10, 0).getTime() });
    await day.svc.startNightly();
    expect(day.state.title(TITLE)).toBeNull();
    const night = setup({ startAt: new Date(2026, 9, 24, 23, 0).getTime() });
    await night.svc.startNightly();
    expect(night.state.title(TITLE)).toMatchObject({ running: false, lastRunAt: expect.any(Number) });
  });

  it('the button on a title the nightly pass is running stops it waiting', async () => {
    // A viewer keeps reading; the pass's wait never ends by itself.
    const { svc, state, activity } = setup({
      sleep: (_ms, signal) => new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true })),
    });
    activity.note();
    const pass = svc.startNightly();
    await new Promise((r) => setTimeout(r, 20));
    expect(state.title(TITLE)).toMatchObject({ running: true, lastRunAt: null });
    expect(svc.runNow(TITLE)).toMatchObject({ running: true });
    await pass;
    expect(state.title(TITLE)).toMatchObject({ running: false, lastRunAt: expect.any(Number), nothingFound: false });
  });

  it('a fansub deleted with no title on its attachment is logged, not remembered', () => {
    const logs: string[] = [];
    const { svc, state } = setup({ log: (m) => logs.push(m) });
    const source = { kind: 'fansub' as const, group: 'GroupA', tracker: 'Nyaa', rank: 'best' as const, toshoFileId: 101, track: 0, trackName: 'Full', alignment: { kind: 'original' as const }, linedUpOn: { discKey: 'd.speech', playlistId: '00000' } };
    svc.deleted({ id: '0123456789abcdef', name: 'x', language: 'en', offsetMs: 0, fileName: 'x.ass', fileSize: 1, fonts: [], uploadedAt: 0, attachment: { kind: 'chapter', discKey: 'd.speech', playlistId: '00000', chapter: 0 }, source });
    expect(state.isDeleted(101, 0)).toBe(false);
    expect(logs).toHaveLength(1);
  });

  it('clears a running flag left by a stopped process', () => {
    const state = new FansubState(dataDir);
    state.put({ titleId: TITLE, lastRunAt: null, running: true, nothingFound: false, seasons: {}, episodes: {} });
    setup();
    expect(state.title(TITLE)?.running).toBe(false);
  });

  describe('release uploads', () => {
    it('a release upload is lined up after it lands and then shown', async () => {
      const fake = fakeAligner(OFFSET);
      const { svc, store } = setup({ aligner: fake.align });
      const id = await releaseUpload(store, 1, 2, FULL);
      expect(alignmentOf(store, id)).toBeNull();
      svc.lineUpRelease(id);
      await vi.waitFor(() => expect(alignmentOf(store, id)).toEqual(OFFSET));
      const s = store.get(id)!;
      expect(isRelease(s) && s.source.linedUpOn).toEqual({ discKey: 'd.speech', playlistId: '00000' });
      // the stored file is moved back by the offset; the original stays as uploaded
      const firstStart = (text: string): string => /^Dialogue: 0,([^,]+),/m.exec(text)![1]!;
      expect(firstStart(readFileSync(store.filePath(id)!, 'utf8'))).toBe(time(SPEECH_BURSTS[0]!.fromMs));
      expect(readFileSync(store.originalPath(id)!, 'utf8')).toBe(FULL);
    });

    it('ASS tracks of one release file share the offset of the one with the most dialogue', async () => {
      const fake = fakeAligner(OFFSET);
      const { svc, store } = setup({ aligner: fake.align });
      const signs = await releaseUpload(store, 1, 3, SIGNS);
      const full = await releaseUpload(store, 1, 2, FULL);
      // another release's file on the same episode is not a sibling
      const other = await releaseUpload(store, 1, 2, SIGNS, { fileName: '[GroupS] Starfall Wanderer - 01.mkv' });
      svc.lineUpRelease(signs);
      svc.lineUpRelease(full);
      await vi.waitFor(() => expect([alignmentOf(store, signs), alignmentOf(store, full)]).toEqual([OFFSET, OFFSET]));
      expect(fake.calls.every((c) => c === FULL)).toBe(true);
      expect(alignmentOf(store, other)).toBeNull();
      expect(readFileSync(store.filePath(signs)!, 'utf8')).toContain(`Dialogue: 0,${time(9_200)},`);
    });

    it('an aligner answer of none shows the release at its own timing and marks it for the owner', async () => {
      const none: FansubAlignment = { kind: 'none', reason: 'low-confidence' };
      const { svc, store } = setup({ aligner: fakeAligner(none).align });
      const id = await releaseUpload(store, 1, 2, FULL);
      svc.lineUpRelease(id);
      await vi.waitFor(() => expect(alignmentOf(store, id)).toEqual(none));
      expect(readFileSync(store.filePath(id)!, 'utf8')).toBe(FULL);
    });

    it('an SRT release upload is not lined up and is shown at once', async () => {
      const fake = fakeAligner(OFFSET);
      const { svc, store } = setup({ aligner: fake.align });
      const srt = '1\n00:00:01,000 --> 00:00:02,000\nHello\n';
      const id = await releaseUpload(store, 1, 4, srt, { ext: 'srt' });
      svc.lineUpRelease(id);
      expect(alignmentOf(store, id)).toEqual({ kind: 'none', reason: 'no-speech' });
      expect(fake.calls).toEqual([]);
      expect(readFileSync(store.filePath(id)!, 'utf8')).toBe(srt);
    });

    it('Line up again and Use original timing take release uploads', async () => {
      const { svc, store } = setup({ aligner: fakeAligner(OFFSET).align });
      const id = await releaseUpload(store, 1, 2, FULL);
      expect((await svc.realign(id))?.source?.alignment).toEqual(OFFSET);
      expect(svc.useOriginal(id)?.source?.alignment).toEqual({ kind: 'original' });
      expect(readFileSync(store.filePath(id)!, 'utf8')).toBe(FULL);
    });

    it('a release upload waits while a disc is being read', async () => {
      const { svc, store, activity, sleeps } = setup({ aligner: fakeAligner(OFFSET).align });
      const id = await releaseUpload(store, 1, 2, FULL);
      activity.note();
      svc.lineUpRelease(id);
      await vi.waitFor(() => expect(alignmentOf(store, id)).toEqual(OFFSET));
      expect(sleeps.length).toBeGreaterThan(0);
    });

    it('Find fansubs leaves an episode with a release upload alone', async () => {
      const first = setup();
      await first.svc.runTitle(TITLE);
      const before = fansubsOf(first.store, 2).map((s) => s.id);
      expect(before).toHaveLength(2);
      const id = await releaseUpload(first.store, 2, 2, FULL);
      const downloads: string[] = [];
      const { svc, store } = setup({ tosho: (t) => ({ ...t, download: async (url, o, max) => { downloads.push(url); return t.download(url, o, max); } }) });
      const result = await svc.runTitle(TITLE);
      expect(fansubsOf(store, 2).map((s) => s.id)).toEqual(before);
      expect(store.get(id)).toMatchObject({ fileSize: FULL.length, source: { kind: 'release', alignment: null } });
      // nothing of episode 2's release was fetched
      expect(downloads.filter((u) => /\/202\b|202-/.test(u))).toEqual([]);
      expect(downloads.length).toBeGreaterThan(0);
      expect(fansubsOf(store, 1)).toHaveLength(2);
      expect(result.episodes[`${SEASON}#1`]).toEqual({ status: 'attached' });
    });

    it('a release upload counts as attached in the episode marks', async () => {
      const { svc, store } = setup({ tosho: (t) => ({ ...t, byHash: async () => null }) });
      await releaseUpload(store, 2, 2, FULL);
      const result = await svc.runTitle(TITLE);
      expect(result.episodes[`${SEASON}#2`]).toEqual({ status: 'attached' });
      expect(result.episodes[`${SEASON}#1`]).toMatchObject({ status: 'not-found' });
      expect(result.nothingFound).toBe(false);
    });

    it("deleting a release upload doesn't mark an Anime Tosho track deleted", async () => {
      const { svc, store, state } = setup();
      const id = await releaseUpload(store, 1, 0, FULL);
      svc.deleted(store.get(id)!);
      expect(state.isDeleted(5000, 0)).toBe(false);
      expect(state.isDeleted(0, 0)).toBe(false);
    });
  });
});
