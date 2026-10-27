/**
 * Checks a NAS quality level end to end, the way the app reads it, and writes nothing to the NAS beyond its own pairing.
 *
 *   npx tsx scripts/verify-level.ts --base <NAS API base> --code <owner pairing code> --level <level>
 *     (--disc <id> [--disc <id> …] | --pick h264|mpeg2|vc1|uhd) [--audio <n>] [--parallel <n>] [--max-mb <n>]
 *
 * `--base` is the API base the app uses (`https://<host>/bluray/api/`, or `http://localhost:4192/api/` for
 * `npm run server:dev`). `--code` is a fresh owner code (`server/deploy/deploy.sh --owner-code --person "Level Check"`,
 * or `node server/dist/server.mjs owner-code --person "Level Check"` with the server's environment): the script pairs
 * with it as the app does (redeem, session challenge, token), mints more codes for that person when `--parallel` needs
 * more viewers, and removes that person (and so every device it paired) at the end.
 *
 * Each viewing fetches `discs/<id>/levels`, the manifest at the level, then reads the main clip at the level in 2 MiB
 * ranges (waiting out 503 Retry-After) and pipes the bytes into local ffprobe and ffmpeg. It checks that every EP entry
 * of the level's rewritten CLPI points at an IDR picture with the entry's PTS, that ffmpeg decodes the stream without
 * errors, and that the bytes read add up to the manifest's size; it prints the throughput as a multiple of real time.
 * `--parallel <n>` runs n viewings at once, on different discs where there are enough, else on other audio streams.
 * `--max-mb <n>` stops each read at the last EP entry within n MiB (the count is then checked against that, not the manifest).
 *
 * The output names discs by id and codec only, never by name or path.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { webcrypto } from 'node:crypto';
import { once } from 'node:events';
import { parseArgs } from 'node:util';
import { parseClpi, type Clpi, type EpMap } from '../src/engine/bdmv/clpi-parser';
import { CodingType, isAudioCoding, isVideoCoding } from '../src/engine/bdmv/stream-types';
import type { DiscManifest, LibraryListing } from '../src/engine/disc/nas-api';

const READ_BYTES = 2 * 1024 * 1024;
const SOURCE_PACKET = 192;
/** Sessions last an hour; a new one is started once less than this is left. */
const SESSION_MARGIN_MS = 5 * 60_000;
/** A read not answered in full within this long fails the viewing (the NAS answers 503 Retry-After after 15 s of waiting). */
const READ_TIMEOUT_MS = 120_000;

/** Why a read got no answer: the timeout, or a connection that died; a wall-clock gap far past the timeout means this machine slept. */
function noAnswer(err: Error, askedAt: number): string {
  const waitedS = Math.round((Date.now() - askedAt) / 1000);
  const slept = Date.now() - askedAt > 2 * READ_TIMEOUT_MS ? ' (far past the timeout: this machine probably slept; keep it awake, e.g. `caffeinate -i` and the lid open)' : '';
  return err.name === 'TimeoutError' ? `no answer in ${waitedS} s${slept}` : `${err.message} after ${waitedS} s${slept}`;
}

/** A read that keeps answering 503 Retry-After for this long fails the viewing. */
const RETRY_GIVE_UP_MS = 10 * 60_000;
/** How much of a video PES is kept to find its first picture's NAL unit type. */
const PES_HEAD_BYTES = 256 * 1024;
const LEVELS = ['h264-1080', 'phone-720', 'hevc-1080', 'hevc-1080-hdr', 'h264-1080-sdr'] as const;
type Level = (typeof LEVELS)[number];
const PICKS = { h264: [CodingType.AVC], mpeg2: [CodingType.MPEG2_VIDEO], vc1: [CodingType.VC1], uhd: [CodingType.HEVC] } as const;
type Pick = keyof typeof PICKS;
/** CLPI video_format codes (libbluray bd_video_format_e) as picture heights. */
const FORMAT_HEIGHTS: Readonly<Record<number, number>> = { 1: 480, 2: 576, 3: 480, 4: 1080, 5: 720, 6: 1080, 7: 576, 8: 2160 };
const CODEC_NAMES: Readonly<Record<number, string>> = {
  [CodingType.MPEG2_VIDEO]: 'mpeg2',
  [CodingType.AVC]: 'h264',
  [CodingType.HEVC]: 'hevc',
  [CodingType.VC1]: 'vc1',
  [CodingType.MVC]: 'mvc',
  [CodingType.MPEG1_VIDEO]: 'mpeg1',
};

function usage(message: string): never {
  console.error(message);
  console.error(
    'usage: npx tsx scripts/verify-level.ts --base <NAS API base> --code <owner code> --level <level> (--disc <id>... | --pick h264|mpeg2|vc1|uhd) [--audio <n>] [--parallel <n>] [--max-mb <n>]',
  );
  process.exit(2);
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));
const base64url = (bytes: ArrayBuffer): string => Buffer.from(bytes).toString('base64url');

class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly body: string,
    what: string,
  ) {
    super(`${what}: HTTP ${status} ${body.slice(0, 200)}`);
  }
}

/** One paired device: its key, its session token, and requests made with it. */
class Device {
  private session: { token: string; expiresAt: number } | null = null;

  private constructor(
    readonly base: string,
    readonly deviceId: string,
    readonly personId: string,
    private readonly key: webcrypto.CryptoKeyPair,
  ) {}

  /** Pairs as the app does: a new P-256 key, then `pair/redeem` with the code. */
  static async pair(base: string, code: string, deviceName: string): Promise<Device> {
    const key = (await webcrypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign', 'verify'])) as webcrypto.CryptoKeyPair;
    const { kty, crv, x, y } = await webcrypto.subtle.exportKey('jwk', key.publicKey);
    const res = await fetch(`${base}pair/redeem`, jsonPost({ code: code.trim().toUpperCase(), deviceName, publicKeyJwk: { kty, crv, x, y } }));
    if (!res.ok) throw new HttpError(res.status, await res.text(), 'pairing');
    const { deviceId, personId, owner } = (await res.json()) as { deviceId: string; personId: string; owner: boolean };
    if (!owner) throw new Error('the code paired a device that is not an owner: mint an owner code');
    return new Device(base, deviceId, personId, key);
  }

  /** A session token: the challenge signed with the device's key, renewed before it lapses. */
  async token(fresh = false): Promise<string> {
    if (!fresh && this.session && this.session.expiresAt - Date.now() > SESSION_MARGIN_MS) return this.session.token;
    const challengeRes = await fetch(`${this.base}session/challenge`, jsonPost({ deviceId: this.deviceId }));
    if (!challengeRes.ok) throw new HttpError(challengeRes.status, await challengeRes.text(), 'session challenge');
    const { challenge } = (await challengeRes.json()) as { challenge: string };
    const signature = await webcrypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, this.key.privateKey, new TextEncoder().encode(challenge));
    const res = await fetch(`${this.base}session`, jsonPost({ deviceId: this.deviceId, challenge, signature: base64url(signature) }));
    if (!res.ok) throw new HttpError(res.status, await res.text(), 'session');
    this.session = (await res.json()) as { token: string; expiresAt: number };
    return this.session.token;
  }

  /** `path` under the API base with the token; a 401 gets one retry with a new session. */
  async fetch(path: string, init: RequestInit = {}): Promise<Response> {
    for (let attempt = 0; ; attempt++) {
      const headers = new Headers(init.headers);
      headers.set('Authorization', `Bearer ${await this.token(attempt > 0)}`);
      const res = await fetch(`${this.base}${path}`, { ...init, headers });
      if (res.status !== 401 || attempt > 0) return res;
      await res.body?.cancel();
    }
  }

  async json<T>(path: string, init: RequestInit = {}): Promise<T> {
    const res = await this.fetch(path, init);
    if (!res.ok) throw new HttpError(res.status, await res.text(), path.split('?')[0]!);
    return (await res.json()) as T;
  }
}

function jsonPost(body: unknown): RequestInit {
  return { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) };
}

/** A disc's main clip, as the NAS picks it: the largest clip with primary video. */
interface MainClip {
  readonly clipId: string;
  readonly m2tsPath: string;
  readonly clpiPath: string;
  readonly codingType: number;
  readonly height: number;
  readonly audioStreams: number;
}

const enc = (path: string): string => path.split('/').map(encodeURIComponent).join('/');

/** A file of the manifest: inlined, else read through the files route (with `query`, the level's). */
async function manifestFile(device: Device, discId: string, manifest: DiscManifest, path: string, query = ''): Promise<Uint8Array> {
  const inline = manifest.inline[path];
  if (inline !== undefined) return new Uint8Array(Buffer.from(inline, 'base64'));
  for (const started = Date.now(); ; ) {
    const res = await device.fetch(`discs/${encodeURIComponent(discId)}/files/${enc(path)}${query}`);
    if (res.ok) return new Uint8Array(await res.arrayBuffer());
    const body = await res.text();
    if (res.status !== 503 || !body.includes('retry') || Date.now() - started > RETRY_GIVE_UP_MS) throw new HttpError(res.status, body, `reading ${path}`);
    await sleep(Number(res.headers.get('Retry-After') ?? '1') * 1000);
  }
}

const videoStream = (clpi: Clpi) => clpi.programs.flatMap((p) => p.streams).find((s) => isVideoCoding(s.codingType));

/** The video stream's EP map (the first video stream that has one), as the NAS rewrites it. */
function videoEpMap(clpi: Clpi): EpMap | undefined {
  for (const s of clpi.programs.flatMap((p) => p.streams)) {
    if (!isVideoCoding(s.codingType)) continue;
    const map = clpi.epMaps.find((m) => m.pid === s.pid);
    if (map) return map;
  }
  return undefined;
}

async function mainClip(device: Device, discId: string, manifest: DiscManifest): Promise<MainClip | null> {
  const clips = manifest.files
    .filter((f) => /^BDMV\/STREAM\/\d{5}\.M2TS$/.test(f.path))
    .sort((a, b) => b.size - a.size);
  for (const clip of clips) {
    const clipId = clip.path.slice('BDMV/STREAM/'.length, -'.M2TS'.length);
    const clpiPath = `BDMV/CLIPINF/${clipId}.CLPI`;
    if (!manifest.files.some((f) => f.path === clpiPath)) continue;
    const clpi = parseClpi(await manifestFile(device, discId, manifest, clpiPath));
    const video = videoStream(clpi);
    if (!video) continue;
    const audioStreams = clpi.programs.flatMap((p) => p.streams).filter((s) => isAudioCoding(s.codingType)).length;
    return { clipId, m2tsPath: clip.path, clpiPath, codingType: video.codingType, height: FORMAT_HEIGHTS[video.format] ?? 0, audioStreams };
  }
  return null;
}

const codecName = (codingType: number): string => CODEC_NAMES[codingType] ?? `0x${codingType.toString(16)}`;

/** Every disc id in the library, folder by folder, depth first. */
async function* libraryDiscs(device: Device, path = ''): AsyncGenerator<string> {
  const listing = await device.json<LibraryListing>(`library?path=${encodeURIComponent(path)}`);
  for (const disc of listing.discs) yield disc.id;
  for (const folder of listing.folders) yield* libraryDiscs(device, folder.path);
}

/** Up to `count` discs whose main clip has the picked video (H.264 at 1080 lines for `h264`). */
async function pickDiscs(device: Device, pick: Pick, count: number): Promise<string[]> {
  const coding: readonly number[] = PICKS[pick];
  const found: string[] = [];
  for await (const discId of libraryDiscs(device)) {
    let main: MainClip | null;
    try {
      main = await mainClip(device, discId, await device.json<DiscManifest>(`discs/${encodeURIComponent(discId)}/manifest`));
    } catch {
      continue; // changed, unreadable or not a disc the levels serve
    }
    if (!main || !coding.includes(main.codingType) || (pick === 'h264' && main.height !== 1080)) continue;
    found.push(discId);
    if (found.length >= count) break;
  }
  return found;
}

/** What the stream scan found for one video PES: where it starts, its PTS and whether its first picture is an IDR. */
interface VideoPes {
  readonly spn: number;
  readonly pts: number;
  readonly idr: boolean;
}

/** The first VCL NAL unit of an Annex-B access unit: whether it is an IDR picture; null when none was found. */
function startsWithIdr(bytes: Uint8Array, hevc: boolean): boolean | null {
  for (let i = 0; i + 3 < bytes.length; i++) {
    if (bytes[i] !== 0 || bytes[i + 1] !== 0 || bytes[i + 2] !== 1) continue;
    const header = bytes[i + 3]!;
    if (hevc) {
      const type = (header >> 1) & 0x3f;
      if (type <= 31) return type === 19 || type === 20;
    } else {
      const type = header & 0x1f;
      if (type >= 1 && type <= 5) return type === 5;
    }
    i += 2;
  }
  return null;
}

/** Walks the level's clip as it arrives: video PES starts by source packet number, with their PTS and picture type. */
class VideoScan {
  readonly pes: VideoPes[] = [];
  readonly unknown: number[] = [];
  private carry = new Uint8Array(0);
  private spn = 0;
  private current: { spn: number; pts: number | null; chunks: Uint8Array[]; size: number } | null = null;

  constructor(
    private readonly pid: number,
    private readonly hevc: boolean,
  ) {}

  push(chunk: Uint8Array): void {
    const data = this.carry.length === 0 ? chunk : Buffer.concat([this.carry, chunk]);
    const whole = data.length - (data.length % SOURCE_PACKET);
    for (let o = 0; o < whole; o += SOURCE_PACKET, this.spn++) this.packet(data, o);
    this.carry = data.slice(whole);
  }

  end(): void {
    this.finish();
  }

  private packet(d: Uint8Array, offset: number): void {
    const o = offset + 4;
    if (d[o] !== 0x47) return;
    const pid = ((d[o + 1]! & 0x1f) << 8) | d[o + 2]!;
    if (pid !== this.pid) return;
    const afc = (d[o + 3]! >> 4) & 3;
    if (!(afc & 1)) return;
    const start = afc & 2 ? o + 5 + d[o + 4]! : o + 4;
    const end = offset + SOURCE_PACKET;
    if (start >= end) return;
    const payload = d.subarray(start, end);
    if (d[o + 1]! & 0x40) {
      this.finish();
      const hasPts = payload.length >= 14 && (payload[7]! & 0x80) !== 0;
      const pts = hasPts ? ((payload[9]! >> 1) & 7) * 2 ** 30 + ((payload[10]! << 22) | ((payload[11]! >> 1) << 15) | (payload[12]! << 7) | (payload[13]! >> 1)) : null;
      const es = payload.subarray(Math.min(payload.length, 9 + (payload[8] ?? 0)));
      this.current = { spn: this.spn, pts, chunks: [es.slice()], size: es.length };
    } else if (this.current && this.current.size < PES_HEAD_BYTES) {
      this.current.chunks.push(payload.slice());
      this.current.size += payload.length;
    }
  }

  private finish(): void {
    const pes = this.current;
    this.current = null;
    if (!pes || pes.pts === null) return;
    const idr = startsWithIdr(Buffer.concat(pes.chunks), this.hevc);
    if (idr === null) this.unknown.push(pes.spn);
    this.pes.push({ spn: pes.spn, pts: pes.pts, idr: idr === true });
  }
}

/** A 90 kHz PTS as an EP entry stores it: 45 kHz with the low 8 bits dropped. */
const epPts = (pts90: number): number => {
  const pts45 = Math.floor(pts90 / 2);
  return pts45 - (pts45 % 256);
};

/** A child process fed through its stdin, with its output collected. */
class Tool {
  readonly stdout: Buffer[] = [];
  readonly stderr: Buffer[] = [];
  readonly exit: Promise<number>;
  private broken = false;

  constructor(
    private readonly child: ChildProcess,
    readonly name: string,
  ) {
    child.stdout!.on('data', (b: Buffer) => this.stdout.push(b));
    child.stderr!.on('data', (b: Buffer) => this.stderr.push(b));
    child.stdin!.on('error', () => (this.broken = true)); // it stopped reading; its exit status says why
    this.exit = new Promise((resolve, reject) => {
      child.on('error', reject);
      child.on('close', (code) => resolve(code ?? -1));
    });
  }

  static start(command: string, args: readonly string[]): Tool {
    return new Tool(spawn(command, args, { stdio: ['pipe', 'pipe', 'pipe'] }), command);
  }

  async write(bytes: Uint8Array): Promise<void> {
    if (this.broken) return;
    if (!this.child.stdin!.write(bytes)) await Promise.race([once(this.child.stdin!, 'drain'), this.exit]);
  }

  end(): void {
    this.child.stdin!.end();
  }
}

interface Viewing {
  readonly index: number;
  readonly discId: string;
  readonly audio: number;
  device: Device;
}

interface ViewingResult {
  readonly ok: boolean;
  readonly lines: readonly string[];
}

/** One viewing, whose lease (taken by the level's manifest) is released however it ends. */
async function runViewing(v: Viewing, level: Level, maxBytes: number | null): Promise<ViewingResult> {
  const lease = { held: false };
  try {
    return await checkViewing(v, level, maxBytes, lease);
  } finally {
    if (lease.held) {
      const res = await v.device.fetch(`discs/${encodeURIComponent(v.discId)}/viewing?level=${level}&audio=${v.audio}`, { method: 'DELETE' });
      await res.body?.cancel();
    }
  }
}

/** The levels, the manifest at the level, then the main clip read through and checked. */
async function checkViewing(v: Viewing, level: Level, maxBytes: number | null, lease: { held: boolean }): Promise<ViewingResult> {
  const lines: string[] = [];
  const failures: string[] = [];
  const say = (line: string): void => {
    lines.push(line);
    console.log(`[${v.index}] ${line}`);
  };
  const stop = (reason: string): ViewingResult => {
    say(`FAIL: ${reason}`);
    return { ok: false, lines };
  };
  const disc = encodeURIComponent(v.discId);
  const query = `?level=${level}&audio=${v.audio}`;
  const { device } = v;

  const original = await device.json<DiscManifest>(`discs/${disc}/manifest`);
  const main = await mainClip(device, v.discId, original);
  if (!main) return stop('no main clip with video');
  say(`disc ${v.discId}: ${codecName(main.codingType)} ${main.height}, clip ${main.clipId}, ${main.audioStreams} audio streams; level ${level}, audio ${v.audio}`);

  const { levels } = await device.json<{ levels: { level: string; available: boolean; reason?: string; budgetMbps: number }[] }>(`discs/${disc}/levels`);
  say(`levels: ${levels.map((l) => `${l.level} ${l.budgetMbps} Mbps ${l.available ? 'available' : `(${l.reason})`}`).join(', ')}`);
  const offered = levels.find((l) => l.level === level);
  if (!offered?.available) return stop(`level ${level} is not available${offered ? ` (${offered.reason})` : ''}`);

  const manifestRes = await device.fetch(`discs/${disc}/manifest${query}`);
  if (!manifestRes.ok) return stop(`manifest at ${level}: HTTP ${manifestRes.status} ${await manifestRes.text()}`);
  lease.held = true;
  const manifest = (await manifestRes.json()) as DiscManifest;
  const size = manifest.files.find((f) => f.path === main.m2tsPath)?.size;
  if (size === undefined) return stop('the level manifest has no main clip');
  const clpi = parseClpi(await manifestFile(device, v.discId, manifest, main.clpiPath, query));
  const video = videoStream(clpi);
  const ep = videoEpMap(clpi);
  if (!video || !ep) return stop('the level CLPI has no video EP map');
  const hevc = video.codingType === CodingType.HEVC;
  if (clpi.numSourcePackets * SOURCE_PACKET !== size) failures.push(`CLPI says ${clpi.numSourcePackets * SOURCE_PACKET} bytes, the manifest ${size}`);
  // A capped read stops at the last EP entry within the cap, so the stream ends whole rather than mid-picture.
  const cutAt = maxBytes === null || maxBytes >= size ? size : ep.entries.reduce((best, e) => (e.spn * SOURCE_PACKET <= maxBytes ? Math.max(best, e.spn * SOURCE_PACKET) : best), 0);
  const want = cutAt > 0 ? cutAt : Math.min(size, maxBytes ?? size);
  say(`level clip: ${size} bytes (${codecName(video.codingType)}), ${ep.entries.length} EP entries; reading ${want} bytes`);

  const probe = Tool.start(process.env.FFPROBE_PATH || 'ffprobe', [
    '-v', 'error', '-f', 'mpegts', '-i', 'pipe:0', '-select_streams', 'v:0',
    '-show_entries', 'stream=codec_name,profile,width,height,pix_fmt:packet=pts,flags', '-of', 'json',
  ]);
  const decode = Tool.start(process.env.FFMPEG_PATH || 'ffmpeg', ['-nostdin', '-hide_banner', '-v', 'error', '-f', 'mpegts', '-i', 'pipe:0', '-map', '0:v:0', '-map', '0:a?', '-f', 'null', '-']);
  const scan = new VideoScan(video.pid, hevc);

  const started = Date.now();
  let read = 0;
  let retries = 0;
  let waitedMs = 0;
  let readError: string | null = null;
  try {
    let retryingSince: number | null = null;
    while (read < want) {
      const end = Math.min(want, read + READ_BYTES) - 1;
      // A read the NAS doesn't answer in full within the timeout fails the viewing with that said, rather than wait forever
      // (as when this machine sleeps mid-run: its connections die and nothing answers them).
      const signal = AbortSignal.timeout(READ_TIMEOUT_MS);
      const asked = Date.now();
      const res = await device
        .fetch(`discs/${disc}/files/${enc(main.m2tsPath)}${query}`, { headers: { Range: `bytes=${read}-${end}` }, signal })
        .catch((err: Error) => {
          throw new Error(`read at ${read}: ${noAnswer(err, asked)}`);
        });
      if (res.status === 503) {
        const body = await res.text();
        if (!body.includes('"retry"')) throw new Error(`read at ${read}: HTTP 503 ${body}`);
        retryingSince ??= Date.now();
        if (Date.now() - retryingSince > RETRY_GIVE_UP_MS) throw new Error(`read at ${read}: still 503 after ${RETRY_GIVE_UP_MS / 60_000} minutes`);
        const wait = Number(res.headers.get('Retry-After') ?? '1') * 1000;
        retries++;
        waitedMs += wait;
        await sleep(wait);
        continue;
      }
      retryingSince = null;
      if (res.status !== 206 && res.status !== 200) throw new Error(`read at ${read}: HTTP ${res.status} ${await res.text()}`);
      const bytes = new Uint8Array(
        await res.arrayBuffer().catch((err: Error) => {
          throw new Error(`read at ${read}: ${noAnswer(err, asked)}`);
        }),
      );
      if (bytes.length === 0) throw new Error(`read at ${read}: an empty answer`);
      scan.push(bytes);
      await Promise.all([probe.write(bytes), decode.write(bytes)]);
      read += bytes.length;
    }
  } catch (err) {
    readError = err instanceof Error ? err.message : String(err);
  } finally {
    scan.end();
    probe.end();
    decode.end();
  }
  const [probeExit, decodeExit] = await Promise.all([probe.exit, decode.exit]);
  const elapsedS = (Date.now() - started) / 1000;

  if (readError) failures.push(readError);
  if (read !== want) failures.push(`read ${read} bytes, ${want === size ? 'the manifest says' : 'asked for'} ${want}`);

  // ffprobe: the stream, and its keyframes by PTS.
  let stream = '?';
  const keyframes = new Set<number>();
  if (probeExit !== 0) failures.push(`ffprobe exited ${probeExit}: ${Buffer.concat(probe.stderr).toString().trim().slice(0, 300)}`);
  else {
    const out = JSON.parse(Buffer.concat(probe.stdout).toString()) as {
      streams?: { codec_name?: string; profile?: string; width?: number; height?: number; pix_fmt?: string }[];
      packets?: { pts?: number; flags?: string }[];
    };
    const s = out.streams?.[0];
    stream = s ? `${s.codec_name} ${s.profile ?? ''} ${s.width}x${s.height} ${s.pix_fmt ?? ''}`.replace(/\s+/g, ' ') : 'no video stream';
    for (const p of out.packets ?? []) if (p.pts !== undefined && p.flags?.includes('K')) keyframes.add(epPts(p.pts));
  }

  // Every EP entry inside what was read: the first video PES at or after its SPN (and before the next entry's) carries
  // the entry's PTS, is an IDR, and is a keyframe to ffprobe.
  const readPackets = Math.floor(read / SOURCE_PACKET);
  const entries = ep.entries.filter((e) => e.spn < readPackets);
  let checked = 0;
  const epFailures: string[] = [];
  let p = 0;
  entries.forEach((entry, i) => {
    while (p < scan.pes.length && scan.pes[p]!.spn < entry.spn) p++;
    const pes = scan.pes[p];
    const nextSpn = entries[i + 1]?.spn ?? Infinity;
    if (!pes || pes.spn >= nextSpn) {
      if (i < entries.length - 1 || read >= size) epFailures.push(`EP ${i} (spn ${entry.spn}): no video PES before the next entry`);
      return;
    }
    const problems: string[] = [];
    if (epPts(pes.pts) !== entry.pts) problems.push(`PTS ${epPts(pes.pts)} ≠ EP ${entry.pts}`);
    if (!pes.idr) problems.push('not an IDR');
    if (probeExit === 0 && !keyframes.has(entry.pts)) problems.push('not a keyframe to ffprobe');
    if (problems.length > 0) epFailures.push(`EP ${i} (spn ${entry.spn}, PES at ${pes.spn}): ${problems.join(', ')}`);
    checked++;
  });
  failures.push(...epFailures.slice(0, 5));
  if (epFailures.length > 5) failures.push(`… and ${epFailures.length - 5} more EP entries`);

  let decodeErrors = Buffer.concat(decode.stderr).toString().split('\n').filter((l) => l.trim() !== '');
  // A capped read stops at an EP entry, where an audio PES the level split between two intervals (its packets keep their
  // own SPNs) is cut short: ffmpeg then reports the stream's last audio packet as too small ("incomplete frame" from the
  // AC-3 decoder). Only that is excused.
  const capped = want < size;
  if (capped && decodeErrors.length > 0 && decodeErrors.length <= 2 && decodeErrors.some((l) => /packet too small|\[ac3 @ [^\]]*\] incomplete frame/i.test(l)) && decodeErrors.every((l) => /packet too small|\[ac3 @ [^\]]*\] incomplete frame|Invalid data found when processing input/i.test(l))) {
    say(`ffmpeg's ${decodeErrors.length} errors are the last audio packet, cut short at the cap: ignored`);
    decodeErrors = [];
  }
  if (decodeExit !== 0) failures.push(`ffmpeg exited ${decodeExit}`);
  if (decodeErrors.length > 0) failures.push(`ffmpeg reported ${decodeErrors.length} errors, first: ${decodeErrors.slice(0, 3).join(' | ')}`);

  const ptsList = scan.pes.map((x) => x.pts);
  const filmS = ptsList.length > 1 ? (ptsList.reduce((a, b) => Math.max(a, b)) - ptsList.reduce((a, b) => Math.min(a, b))) / 90_000 : 0;
  const rate = elapsedS > 0 ? filmS / elapsedS : 0;
  say(`stream: ${stream}`);
  say(
    `read ${read} of ${size} bytes${read === size ? ' (= manifest)' : want < size ? ' (capped)' : ''}; ` +
      `${checked}/${entries.length} EP entries checked (${scan.unknown.length} PES with no picture found); ` +
      `ffmpeg ${decodeErrors.length === 0 && decodeExit === 0 ? 'decoded cleanly' : 'reported errors'}`,
  );
  say(`throughput: ${rate.toFixed(2)}× real time (${filmS.toFixed(1)} s of film in ${elapsedS.toFixed(1)} s; ${retries} retries, ${(waitedMs / 1000).toFixed(0)} s waited)`);
  for (const f of failures) say(`FAIL: ${f}`);
  say(failures.length === 0 ? 'PASS' : 'FAILED');
  return { ok: failures.length === 0, lines };
}

const OPTIONS = {
  base: { type: 'string' },
  code: { type: 'string' },
  level: { type: 'string' },
  disc: { type: 'string', multiple: true },
  pick: { type: 'string' },
  audio: { type: 'string', default: '1' },
  parallel: { type: 'string', default: '1' },
  'max-mb': { type: 'string' },
} as const;

async function main(): Promise<void> {
  const parsed = (() => {
    try {
      return parseArgs({ options: OPTIONS, strict: true });
    } catch (err) {
      return usage(err instanceof Error ? err.message : String(err));
    }
  })();
  const { values } = parsed;
  if (!values.base) usage('--base is required');
  if (!values.code) usage('--code is required');
  const base = values.base.endsWith('/') ? values.base : `${values.base}/`;
  const level = values.level as Level;
  if (!LEVELS.includes(level)) usage(`--level must be one of ${LEVELS.join(', ')}`);
  const parallel = Number(values.parallel);
  const audio = Number(values.audio);
  if (!Number.isInteger(parallel) || parallel < 1 || parallel > 8) usage('--parallel must be 1 to 8');
  if (!Number.isInteger(audio) || audio < 1 || audio > 32) usage('--audio must be 1 to 32');
  const maxMb = values['max-mb'] === undefined ? null : Number(values['max-mb']);
  if (maxMb !== null && !(maxMb > 0)) usage('--max-mb must be positive');
  const discs = values.disc ?? [];
  const pick = values.pick as Pick | undefined;
  if ((discs.length === 0) === (pick === undefined)) usage('give --disc or --pick, not both');
  if (pick !== undefined && !(pick in PICKS)) usage(`--pick must be one of ${Object.keys(PICKS).join(', ')}`);

  const first = await Device.pair(base, values.code, 'Level Check');
  console.log(`paired device ${first.deviceId} (person ${first.personId})`);
  let ok = false;
  try {
    const chosen = pick ? await pickDiscs(first, pick, parallel) : discs;
    if (chosen.length === 0) throw new Error(`no ${pick} disc found in the library`);
    if (pick) console.log(`picked ${pick} discs: ${chosen.join(', ')}`);

    // One viewing per disc while there are discs, then other audio streams of the same discs. Each viewing has its own
    // device: the NAS moves a device's lease when it opens a disc at another audio stream.
    const viewings: Viewing[] = [];
    for (let i = 0; i < parallel; i++) {
      const device = i === 0 ? first : await pairAnother(first);
      viewings.push({ index: i + 1, discId: chosen[i % chosen.length]!, audio: audio + Math.floor(i / chosen.length), device });
    }
    const results = await Promise.all(
      viewings.map((v) =>
        runViewing(v, level, maxMb === null ? null : Math.floor(maxMb * 1024 * 1024)).catch((err: unknown) => {
          const message = `FAIL: ${err instanceof Error ? err.message : String(err)}`;
          console.log(`[${v.index}] ${message}`);
          return { ok: false, lines: [message] };
        }),
      ),
    );
    ok = results.every((r) => r.ok);
    console.log(ok ? `all ${results.length} viewings passed` : `${results.filter((r) => !r.ok).length} of ${results.length} viewings failed`);
  } finally {
    await removePerson(first);
  }
  process.exit(ok ? 0 : 1);
}

/** Another owner device for the same person: a code minted through the admin API, redeemed at once. */
async function pairAnother(owner: Device): Promise<Device> {
  const { code } = await owner.json<{ code: string }>('admin/codes', jsonPost({ personId: owner.personId }));
  return Device.pair(owner.base, code, 'Level Check');
}

/** Removes the script's person, and with it every device it paired; says so when the NAS refuses. */
async function removePerson(owner: Device): Promise<void> {
  const res = await owner.fetch(`admin/people/${encodeURIComponent(owner.personId)}`, { method: 'DELETE' });
  const body = await res.text();
  if (res.status === 204) console.log(`removed person ${owner.personId} and its devices`);
  else if (res.status === 409) console.log(`could not remove person ${owner.personId}: it holds the NAS's only owner device (${body}); remove it in the owner screens`);
  else console.log(`could not remove person ${owner.personId}: HTTP ${res.status} ${body}`);
}

await main();
