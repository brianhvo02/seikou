import { spawnSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import SevenZip from '7z-wasm';
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type {
  DiscSlot, EpisodeRef, FansubPick, FansubTitleState, StoredSubtitle, TitleDetail, TitleSummary, ToshoReleaseFiles, ToshoSearchResult,
} from '@seikou/nas/nas-api';
import { SPEECH_BURSTS } from '../../../tests/helpers/speech-bursts';
import { appHandlers } from '../app';
import { Auth } from '../auth';
import { BdjStore } from '../bdj-store';
import { DiscActivity } from '../disc-activity';
import { libraryFansubDiscs } from '../fansubs/disc-lookup';
import { FetchCache } from '../fansubs/fetch-cache';
import { fixtureFansubSources } from '../fansubs/fixture-sources';
import { FansubPicks } from '../fansubs/picks';
import type { SeaDexEntry } from '../fansubs/seadex';
import { FansubService } from '../fansubs/service';
import { FansubState } from '../fansubs/state';
import type { ToshoRelease } from '../fansubs/tosho';
import { createServer } from '../http';
import { folderDiscSource } from '../levels/level-discs';
import type { Library } from '../library';
import { Store } from '../store';
import { SubtitleStore } from '../subtitle-store';
import type { Catalogue } from '@seikou/titles/catalogue';
import type { DiscEvidence } from '../titles/evidence';
import type { TitleLibrary } from './titles';

// Every name here is made up.

const hasAc3 = spawnSync('ffmpeg', ['-hide_banner', '-decoders'], { encoding: 'utf8' }).stdout?.includes(' ac3 ') ?? false;
/** CI installs ffmpeg: there, a missing AC-3 decoder fails these tests instead of skipping them. */
const runFfmpegTests = hasAc3 || Boolean(process.env.CI);

const TITLE = 'anilist:900001';
const SEASON = 'anilist:900001#season';
const FP = 'D'.repeat(32);
const KEY = `f.${FP}`;
const HASH_A = 'a'.repeat(40);
const HASH_B = 'b'.repeat(40);

const HEAD = `[Script Info]
ScriptType: v4.00+

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Default,Arial,20,&H00FFFFFF,&H000000FF,&H00000000,&H00000000,0,0,0,0,100,100,0,0,1,2,2,2,10,10,10,1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
`;
function time(ms: number): string {
  const cs = Math.round(ms / 10);
  const p2 = (n: number): string => String(n).padStart(2, '0');
  return `${Math.floor(cs / 360000)}:${p2(Math.floor(cs / 6000) % 60)}:${p2(Math.floor(cs / 100) % 60)}.${p2(cs % 100)}`;
}
/** The speech disc's bursts, 800 ms late. */
const FULL = HEAD + SPEECH_BURSTS.map((b, i) => `Dialogue: 0,${time(b.fromMs + 800)},${time(b.toMs + 800)},Default,,0,0,0,,Line ${i}\n`).join('');
const SIGNS = HEAD + [10_000, 50_000].map((at, i) => `Dialogue: 0,${time(at)},${time(at + 3000)},Default,,0,0,0,,{\\pos(100,100)}Sign ${i}\n`).join('');

async function xz(data: Buffer): Promise<Buffer> {
  const wasm = readFileSync(new URL('../../../node_modules/7z-wasm/7zz.wasm', import.meta.url));
  const sz = await SevenZip({ wasmBinary: wasm.buffer.slice(wasm.byteOffset, wasm.byteOffset + wasm.byteLength) as ArrayBuffer, print: () => {}, printErr: () => {}, stdout: () => {} });
  sz.FS.writeFile('t.ass', data);
  sz.callMain(['a', '-txz', '-mx1', 't.ass.xz', 't.ass']);
  return Buffer.from(sz.FS.readFile('t.ass.xz'));
}
let fullXz: Buffer;
let signsXz: Buffer;
beforeAll(async () => {
  fullXz = await xz(Buffer.from(FULL));
  signsXz = await xz(Buffer.from(SIGNS));
}, 60_000);

const trackUrl = (fileId: number, track: number): string => `https://animetosho.net/storage/attach/0/${fileId}-${track}.ass.xz`;
const file = (id: number, name: string): ToshoRelease['files'][number] => ({
  id, name, size: 1000,
  tracks: [
    { track: 0, language: 'eng', name: 'Full', format: 'ASS', url: trackUrl(id, 0), isDefault: true, forced: false },
    { track: 1, language: 'eng', name: 'Signs', format: 'ASS', url: trackUrl(id, 1), isDefault: false, forced: false },
    { track: 2, language: 'spa', name: 'Completo', format: 'ASS', url: trackUrl(id, 0), isDefault: false, forced: false },
  ],
});
const SEADEX: Record<string, SeaDexEntry> = {
  900001: {
    alId: 900001, incomplete: false,
    releases: [
      { tracker: 'Nyaa', infoHash: HASH_A, isBest: true, dualAudio: false, group: 'GroupA', tags: [], files: [] },
      { tracker: 'Nyaa', infoHash: HASH_B, isBest: false, dualAudio: false, group: 'GroupB', tags: ['WEB'], files: [] },
    ],
  },
};
const TOSHO: ToshoRelease[] = [
  {
    id: 1, title: '[GroupA] Starfall Wanderer (BD 1080p)', infoHash: HASH_A, status: 'complete', isSeadex: true, date: 1_700_000_000,
    files: [file(101, '[GroupA] Starfall Wanderer - 01 (BD 1080p).mkv'), file(102, '[GroupA] Starfall Wanderer - 02 (BD 1080p).mkv')],
  },
  { id: 2, title: '[GroupB] Starfall Wanderer (WEB 1080p)', infoHash: HASH_B, status: 'complete', isSeadex: true, date: 1_600_000_000, files: [file(201, '[GroupB] Starfall Wanderer - 01 (WEB 1080p).mkv')] },
];

const summary: TitleSummary = {
  id: TITLE, kind: 'series', names: { english: 'Starfall Wanderer', romaji: null, native: null, synonyms: [], display: 'Starfall Wanderer' },
  poster: null, year: 2020, seasons: 1, discs: 1, addedAt: 0, own: false,
};
const slot: DiscSlot = { number: 1, label: 'Disc 1', copies: [{ discId: 'speech', root: 'r', folder: 'Starfall Wanderer', displayName: null }] };
const episodes: EpisodeRef[] = [
  { number: 1, name: null, runtimeMin: null, discId: 'speech', playlistId: '00000' },
  { number: 2, name: null, runtimeMin: null, discId: 'speech', playlistId: '00001' },
];
const detail: TitleDetail = {
  title: summary, banner: null, related: [], extras: [],
  seasons: [{ id: SEASON, label: 'Starfall Wanderer', number: 1, discs: [slot], episodes, extras: [] }],
};
const catalogue = { titles: [summary], detail: (id: string) => (id === TITLE ? detail : null), unsorted: [], hidden: [], art: () => null, provisional: [] } as unknown as Catalogue;

let tmp: string;
let base = '';
let stop: (() => void) | undefined;
let auth: Auth;
let gate: 'owners' | 'everyone';
let service: FansubService;
/** While set, the runs' Anime Tosho lookups wait for it. */
let hold: Promise<void> | null = null;

beforeEach(async () => {
  tmp = mkdtempSync(join(tmpdir(), 'fansub-routes-'));
  const data = join(tmp, 'data');
  const fix = join(tmp, 'fix');
  const discDir = join(tmp, 'disc');
  cpSync(join(import.meta.dirname, '../../../fixtures/synthetic/disc-speech'), discDir, { recursive: true });
  cpSync(join(discDir, 'BDMV/PLAYLIST/00000.mpls'), join(discDir, 'BDMV/PLAYLIST/00001.mpls'));
  mkdirSync(join(fix, 'files'), { recursive: true });
  writeFileSync(join(fix, 'seadex.json'), JSON.stringify(SEADEX));
  writeFileSync(join(fix, 'tosho.json'), JSON.stringify({ releases: TOSHO }));
  for (const id of [101, 102, 201]) {
    writeFileSync(join(fix, 'files', `${id}-0.ass.xz`), fullXz);
    writeFileSync(join(fix, 'files', `${id}-1.ass.xz`), signsXz);
  }
  writeFileSync(join(fix, 'files', 'pack-101.7z'), readFileSync(new URL('../fansubs/__fixtures__/pack.7z', import.meta.url)));

  auth = new Auth(new Store(data), Date.now);
  gate = 'everyone';
  const evidence = [{ discId: 'speech', fingerprint: FP, playlists: ['00000', '00001'].map((id) => ({ id, durationS: 150, chapters: 1, clips: ['00000'] })) }] as unknown as DiscEvidence[];
  const library = { evidence: () => evidence } as unknown as Library;
  const titles = { service: { gate: () => gate, catalogue: () => catalogue }, owner: {} } as unknown as TitleLibrary;
  const lookup = libraryFansubDiscs(library);
  const discs = async (id: string) => (id === 'speech' ? folderDiscSource(discDir, { id: 'speech', name: 'Speech' }) : null);
  const { seadex, tosho } = fixtureFansubSources(fix);
  const cache = new FetchCache(join(data, 'fansubs', 'cache'), 1 << 30);
  const store = new SubtitleStore(data);
  const state = new FansubState(data);
  hold = null;
  const held = { ...tosho, byHash: async (...a: Parameters<typeof tosho.byHash>) => { await hold; return tosho.byHash(...a); } };
  service = new FansubService({
    store, state, seadex, tosho: held, cache, titles: { catalogue: () => catalogue }, discs, discKey: lookup.discKey,
    // runs here line nothing up (no ffmpeg); the picks do, through the library's playlists
    durationMs: () => null,
    ffmpegPath: 'ffmpeg', activity: new DiscActivity(), encoding: () => false, log: () => {},
  });
  const picks = new FansubPicks({ dataDir: data, tosho, cache, discs, lookup, ffmpegPath: 'ffmpeg', log: () => {} });
  const server = createServer(appHandlers({
    auth, library, bdjStore: new BdjStore(data), subtitleStore: store, publicBase: 'https://nas.example/bluray/api/', titles,
    fansubs: { service, state, seadex, tosho, picks, lookup },
  }));
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  stop = () => { server.close(); server.closeAllConnections(); };
});
afterEach(() => {
  stop?.();
  service.close();
  rmSync(tmp, { recursive: true, force: true });
});

async function tokenFor(name: string, owner: boolean): Promise<string> {
  const pair = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign', 'verify']);
  const jwk = await crypto.subtle.exportKey('jwk', pair.publicKey);
  const { code } = auth.createCode({ newPerson: { name, owner } });
  const device = auth.redeem(code, `${name}'s phone`, jwk)!;
  const challenge = auth.challenge(device.id)!;
  const signature = Buffer.from(await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, pair.privateKey, new TextEncoder().encode(challenge))).toString('base64url');
  return auth.startSession(device.id, challenge, signature)!.token;
}

const call = (method: string, path: string, token: string | null, body?: object): Promise<Response> => fetch(`${base}${path}`, {
  method,
  headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}) },
  body: body === undefined ? undefined : JSON.stringify(body),
});

/** Runs the title and waits for the run to end. */
async function runTitle(owner: string): Promise<FansubTitleState> {
  const started = await call('POST', `/api/fansubs/titles/${encodeURIComponent(TITLE)}/run`, owner);
  expect(started.status).toBe(202);
  expect(await started.json()).toMatchObject({ titleId: TITLE, running: true });
  return ended(owner);
}

async function ended(owner: string): Promise<FansubTitleState> {
  for (;;) {
    const state = (await (await call('GET', `/api/fansubs/titles/${encodeURIComponent(TITLE)}`, owner)).json()) as FansubTitleState;
    if (!state.running) return state;
    await new Promise((r) => setTimeout(r, 20));
  }
}

const listed = async (token: string): Promise<StoredSubtitle[]> =>
  (await (await call('GET', `/api/subtitles?titleId=${encodeURIComponent(TITLE)}`, token)).json()) as StoredSubtitle[];

describe('fansub routes', () => {
  it('answers 401 without a token, and 403 to a guest on the owner routes', async () => {
    expect((await call('GET', '/api/fansubs/languages', null)).status).toBe(401);
    const guest = await tokenFor('Noor', false);
    expect((await call('POST', `/api/fansubs/titles/${encodeURIComponent(TITLE)}/run`, guest)).status).toBe(403);
    expect((await call('GET', `/api/fansubs/titles/${encodeURIComponent(TITLE)}`, guest)).status).toBe(403);
    expect((await call('PUT', '/api/fansubs/languages', guest, { languages: ['spa'] })).status).toBe(403);
  });

  it('gives a never-run title blank, runs it, lists the tracks with their source, and remembers a deleted one', async () => {
    const owner = await tokenFor('Hana', true);
    expect(await (await call('GET', `/api/fansubs/titles/${encodeURIComponent(TITLE)}`, owner)).json())
      .toEqual({ titleId: TITLE, lastRunAt: null, running: false, nothingFound: false, seasons: {}, episodes: {} });
    const done = await runTitle(owner);
    expect(done.episodes).toEqual({ [`${SEASON}#1`]: { status: 'attached' }, [`${SEASON}#2`]: { status: 'attached' } });

    const subs = await listed(owner);
    const ep1 = subs.filter((s) => s.attachment.kind === 'episode' && s.attachment.episode === 1).sort((a, b) => a.source!.track - b.source!.track);
    expect(ep1.map((s) => s.name)).toEqual(['GroupA · Full', 'GroupA · Signs']);
    expect(ep1[0]!.source).toMatchObject({ kind: 'fansub', group: 'GroupA', rank: 'best', toshoFileId: 101, track: 0 });
    expect(ep1[0]!.stale).toBeUndefined();
    const original = await call('POST', `/api/fansubs/subtitles/${ep1[1]!.id}/original`, owner);
    expect(original.status).toBe(200);
    expect(((await original.json()) as StoredSubtitle).source?.alignment).toEqual({ kind: 'original' });
    expect((await call('POST', `/api/fansubs/subtitles/${ep1[1]!.id}/original`, await tokenFor('Noor', false))).status).toBe(403);

    expect((await call('DELETE', `/api/subtitles/${ep1[0]!.id}`, owner)).status).toBe(204);
    await runTitle(owner);
    const again = (await listed(owner)).filter((s) => s.attachment.kind === 'episode' && s.attachment.episode === 1);
    expect(again.map((s) => s.source!.track)).toEqual([1]);

    expect((await call('POST', `/api/fansubs/titles/${encodeURIComponent(TITLE)}/undelete`, owner)).status).toBe(204);
    await runTitle(owner);
    expect((await listed(owner)).filter((s) => s.attachment.kind === 'episode' && s.attachment.episode === 1)).toHaveLength(2);
  });

  it('hurries a title that already runs with 202, and answers 404 for a title the catalogue lacks', async () => {
    const owner = await tokenFor('Hana', true);
    let release!: () => void;
    hold = new Promise((r) => { release = r; });
    expect((await call('POST', `/api/fansubs/titles/${encodeURIComponent(TITLE)}/run`, owner)).status).toBe(202);
    const second = await call('POST', `/api/fansubs/titles/${encodeURIComponent(TITLE)}/run`, owner);
    expect(second.status).toBe(202);
    expect(await second.json()).toMatchObject({ titleId: TITLE, running: true });
    release();
    expect((await ended(owner)).episodes[`${SEASON}#1`]).toEqual({ status: 'attached' });
    expect((await call('POST', '/api/fansubs/titles/anilist%3A1/run', owner)).status).toBe(404);
  });

  it('keeps English when the languages are set, and refuses a bad list', async () => {
    const owner = await tokenFor('Hana', true);
    expect(await (await call('GET', '/api/fansubs/languages', owner)).json()).toEqual({ languages: ['eng'] });
    const put = await call('PUT', '/api/fansubs/languages', owner, { languages: ['spa'] });
    expect(put.status).toBe(200);
    expect(await put.json()).toEqual({ languages: ['eng', 'spa'] });
    expect(await (await call('GET', '/api/fansubs/languages', owner)).json()).toEqual({ languages: ['eng', 'spa'] });
    expect((await call('PUT', '/api/fansubs/languages', owner, { languages: [] })).status).toBe(400);
    expect((await call('PUT', '/api/fansubs/languages', owner, { languages: ['english'] })).status).toBe(400);
    expect((await call('PUT', '/api/fansubs/languages', owner, { languages: Array.from({ length: 21 }, () => 'spa') })).status).toBe(400);
  });

  it("lets a guest search, with SeaDex's ranks for the title named only while the gate is open", async () => {
    const guest = await tokenFor('Noor', false);
    const plain = await call('GET', '/api/fansubs/search?q=starfall', guest);
    expect(plain.status).toBe(200);
    expect(await plain.json()).toEqual([
      { id: 1, title: '[GroupA] Starfall Wanderer (BD 1080p)', date: 1_700_000_000, seadex: null },
      { id: 2, title: '[GroupB] Starfall Wanderer (WEB 1080p)', date: 1_600_000_000, seadex: null },
    ] satisfies ToshoSearchResult[]);
    const ranked = (await (await call('GET', `/api/fansubs/search?q=starfall&titleId=${encodeURIComponent(TITLE)}`, guest)).json()) as ToshoSearchResult[];
    expect(ranked.map((r) => r.seadex)).toEqual(['best', 'web']);
    expect((await call('GET', '/api/fansubs/search', guest)).status).toBe(400);
    // behind a closed gate a guest learns nothing of the catalogue: no ranks for a title, no file matched to an episode
    gate = 'owners';
    const closed = (await (await call('GET', `/api/fansubs/search?q=starfall&titleId=${encodeURIComponent(TITLE)}`, guest)).json()) as ToshoSearchResult[];
    expect(closed.map((r) => r.seadex)).toEqual([null, null]);
    expect(((await (await call('GET', `/api/fansubs/releases/1?discKey=${KEY}&playlistId=00000`, guest)).json()) as ToshoReleaseFiles).matchedFileId).toBeNull();
    const owner = await tokenFor('Hana', true);
    const asOwner = (await (await call('GET', `/api/fansubs/search?q=starfall&titleId=${encodeURIComponent(TITLE)}`, owner)).json()) as ToshoSearchResult[];
    expect(asOwner.map((r) => r.seadex)).toEqual(['best', 'web']);
    expect(((await (await call('GET', `/api/fansubs/releases/1?discKey=${KEY}&playlistId=00000`, owner)).json()) as ToshoReleaseFiles).matchedFileId).toBe(101);
  });

  it("gives a release's files with the file of the playing episode", async () => {
    const guest = await tokenFor('Noor', false);
    const res = await call('GET', `/api/fansubs/releases/1?discKey=${KEY}&playlistId=00000`, guest);
    expect(res.status).toBe(200);
    const body = (await res.json()) as ToshoReleaseFiles;
    expect(body.release).toEqual({ id: 1, title: '[GroupA] Starfall Wanderer (BD 1080p)', date: 1_700_000_000, seadex: null });
    expect(body.files.map((f) => [f.id, f.episode])).toEqual([[101, 1], [102, 2]]);
    expect(body.files[0]!.tracks).toEqual([
      { track: 0, language: 'eng', name: 'Full' }, { track: 1, language: 'eng', name: 'Signs' }, { track: 2, language: 'spa', name: 'Completo' },
    ]);
    expect(body.matchedFileId).toBe(101);
    expect(((await (await call('GET', `/api/fansubs/releases/1?discKey=${KEY}&playlistId=00001`, guest)).json()) as ToshoReleaseFiles).matchedFileId).toBe(102);
    expect(((await (await call('GET', '/api/fansubs/releases/1', guest)).json()) as ToshoReleaseFiles).matchedFileId).toBeNull();
    expect((await call('GET', '/api/fansubs/releases/99', guest)).status).toBe(404);
  });

  it.skipIf(!runFfmpegTests)("lines a guest's pick up with the episode and serves its file and fonts", async () => {
    const guest = await tokenFor('Noor', false);
    await call('GET', `/api/fansubs/releases/1?discKey=${KEY}&playlistId=00000`, guest);
    const res = await call('POST', '/api/fansubs/picks', guest, { fileId: 101, track: 0, discKey: KEY, playlistId: '00000' });
    expect(res.status).toBe(200);
    const pick = (await res.json()) as FansubPick;
    expect(pick).toMatchObject({
      pick: true, name: 'GroupA · Full', language: 'en', offsetMs: 0, fileName: '101-0.ass',
      attachment: { kind: 'chapter', discKey: KEY, playlistId: '00000', chapter: 0 },
      source: { kind: 'fansub', group: 'GroupA', toshoFileId: 101, track: 0, trackName: 'Full', linedUpOn: { discKey: KEY, playlistId: '00000' } },
    });
    expect(pick.id).toMatch(/^[0-9a-f]{16}$/);
    const a = pick.source.alignment;
    expect(a.kind).toBe('offset');
    if (a.kind === 'offset') expect(Math.abs(a.offsetMs + 800)).toBeLessThanOrEqual(20);

    const text = await (await call('GET', `/api/fansubs/picks/${pick.id}/file`, guest)).text();
    expect(text.length).toBe(pick.fileSize);
    const firstStart = /^Dialogue: 0,([^,]+),/m.exec(text)![1]!;
    expect(Math.abs(Number(firstStart.split(':')[2]) * 1000 - SPEECH_BURSTS[0]!.fromMs)).toBeLessThanOrEqual(20);
    expect(pick.fonts.map((f) => f.name)).toEqual(['Default.ttf']);
    const font = await call('GET', `/api/fansubs/picks/${pick.id}/fonts/Default.ttf`, guest);
    expect((await font.arrayBuffer()).byteLength).toBe(pick.fonts[0]!.size);
    expect((await call('GET', `/api/fansubs/picks/${pick.id}/fonts/Missing.ttf`, guest)).status).toBe(404);

    // the same pick again comes from what the NAS keeps
    const again = (await (await call('POST', '/api/fansubs/picks', guest, { fileId: 101, track: 0, discKey: KEY, playlistId: '00000' })).json()) as FansubPick;
    expect(again).toEqual(pick);
  }, 60_000);

  it('refuses the 21st pick a person starts in an hour, and a file it never listed', async () => {
    const guest = await tokenFor('Noor', false);
    const other = await tokenFor('Kai', false);
    await call('GET', '/api/fansubs/releases/1', guest);
    const elsewhere = 'd.0123456789abcdef';
    expect((await call('POST', '/api/fansubs/picks', guest, { fileId: 999, track: 0, discKey: elsewhere, playlistId: '00000' })).status).toBe(404);
    for (let i = 0; i < 20; i++) {
      const res = await call('POST', '/api/fansubs/picks', guest, { fileId: 101, track: 1, discKey: elsewhere, playlistId: String(i).padStart(5, '0') });
      expect(res.status).toBe(200);
    }
    const too = await call('POST', '/api/fansubs/picks', guest, { fileId: 101, track: 1, discKey: elsewhere, playlistId: '00500' });
    expect(too.status).toBe(429);
    expect(await too.json()).toEqual({ error: 'too-many' });
    // a pick the NAS already keeps isn't a new one
    expect((await call('POST', '/api/fansubs/picks', guest, { fileId: 101, track: 1, discKey: elsewhere, playlistId: '00003' })).status).toBe(200);
    expect((await call('POST', '/api/fansubs/picks', other, { fileId: 101, track: 1, discKey: elsewhere, playlistId: '00500' })).status).toBe(200);
  }, 60_000);
});
