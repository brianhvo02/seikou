import { createHash } from 'node:crypto';
import { spawnSync, type spawn as nodeSpawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { cpSync, createReadStream, mkdtempSync, readFileSync, readdirSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { parseClpi } from '../../../src/engine/bdmv/clpi-parser';
import { parseMpls } from '../../../src/engine/bdmv/mpls-parser';
import { CodingType } from '../../../src/engine/bdmv/stream-types';
import { analyzeAvc } from '../../../src/engine/decode/h264';
import type { ByteSource } from '../../../src/engine/disc/byte-source';
import type { DiscManifest } from '../../../src/engine/disc/nas-api';
import { M2tsReader } from '../../../src/engine/demux/m2ts-reader';
import { PesAssembler, readTimestamp, type PesPacket } from '../../../src/engine/demux/pes-assembler';
import { parseSourcePacket } from '../../../src/engine/demux/ts-packet';
import { readIsoTree } from '../iso';
import { audioWireBps, fallbackAudioBps, nominalAudioBps } from './audio-core';
import { Capacity } from './capacity';
import type { Clock } from './clip-run';
import { clpiStreamAttrs, rewriteClpi } from './clpi-writer';
import { x264Backend, type EncoderBackend } from './encoder';
import { distortingBackend, shiftedBy } from './test-backends';
import {
  ENCODER_IDLE_MS,
  LevelService,
  READ_AHEAD_FILM_MS,
  WAIT_FILM_MS,
  READ_WAIT_MS,
  firstAudioBps,
  folderDiscSource,
  isoDiscSource,
  parseViewingId,
  viewingIdOf,
  type LevelDiscSource,
} from './level-service';
import { FAILURE_BACKOFF_MS } from './clip-run';
import { ENCODER_VERSION, clipFrameTicks, loadDisc, planHash } from './level-version';
import { keptAudioFor, levelDefFor, planClip, videoAttrsFor } from './levels';
import { rewriteMpls } from './mpls-writer';
import { SegmentCache } from './segment-cache';
import { shedGraphics } from './remux';

vi.mock('./remux', async (importOriginal) => {
  const remux = await importOriginal<typeof import('./remux')>();
  return { ...remux, shedGraphics: vi.fn(remux.shedGraphics) };
});

/** The fixtures' EP intervals as they are: their GOPs are shorter than the plan's merge threshold. */
const RAW_PLAN = { minInterval45: 0 };

const SYNTHETIC = join(import.meta.dirname, '../../../fixtures/synthetic');
const DISC_DIR = join(SYNTHETIC, 'disc-levels');
const DISC_ID = 'lvl0001';
const VIDEO = 0x1011;
const TRUEHD = 0x1100;
const COMMENTARY = 0x1101;
const PG = [0x1200, 0x1201];
const PIP = 0x1b00;
const CLPI_PATH = 'BDMV/CLIPINF/00001.CLPI';
const MPLS_PATH = 'BDMV/PLAYLIST/00000.MPLS';
const M2TS_PATH = 'BDMV/STREAM/00001.M2TS';
const VIEWING = viewingIdOf('dev1', DISC_ID, 'h264-1080', 1);

const fixtureBytes = (path: string): Uint8Array => new Uint8Array(readFileSync(join(DISC_DIR, 'BDMV', path)));

/** The PTS of the clip's video frames. */
const SOURCE_PTS = ((): number[] => {
  const clip = fixtureBytes('STREAM/00001.m2ts');
  const out: number[] = [];
  for (let at = 0; at + 192 <= clip.length; at += 192) {
    const ts = parseSourcePacket(clip, at);
    if (ts?.pid === VIDEO && ts.payloadUnitStart) out.push(readTimestamp(ts.payload, 9));
  }
  return out;
})();
/** The PTS of the frame at an EP entry (the EP map keeps it to 512 ticks): what the encoder is told, and what it gives back. */
const epFrame = (pts45: number): number => SOURCE_PTS.find((p) => Math.floor(p / 512) === Math.floor((pts45 * 2) / 512))!;

/** Timers that fire only when the test moves the clock. */
class ManualClock implements Clock {
  private t = 1_000_000;
  private nextId = 0;
  private readonly timers = new Map<number, { at: number; fn: () => void }>();
  now = (): number => this.t;
  setTimeout = (fn: () => void, ms: number): unknown => {
    const id = ++this.nextId;
    this.timers.set(id, { at: this.t + ms, fn });
    return id;
  };
  clearTimeout = (handle: unknown): void => {
    this.timers.delete(handle as number);
  };
  advance(ms: number): void {
    const end = this.t + ms;
    for (;;) {
      let due: [number, { at: number; fn: () => void }] | null = null;
      for (const entry of this.timers) if (entry[1].at <= end && (!due || entry[1].at < due[1].at)) due = entry;
      if (!due) break;
      this.timers.delete(due[0]);
      this.t = due[1].at;
      due[1].fn();
    }
    this.t = end;
  }
}

/** TS packets carrying one video PES at `pts90`: an IDR or a P slice, with `padding` more bytes of slice data. */
function videoPes(pts90: number, idr: boolean, padding = 0): Buffer {
  const pts = [
    0x21 | (Math.floor(pts90 / 2 ** 29) & 0x0e),
    Math.floor(pts90 / 2 ** 22) & 0xff,
    (Math.floor(pts90 / 2 ** 14) & 0xfe) | 1,
    Math.floor(pts90 / 2 ** 7) & 0xff,
    ((pts90 % 128) << 1) | 1,
  ];
  const es = [0, 0, 0, 1, idr ? 0x65 : 0x41, 0x88, 0x84, 0x21, 0xa0];
  const pes = Buffer.concat([Buffer.from([0, 0, 1, 0xe0, 0, 0, 0x80, 0x80, 5, ...pts, ...es]), Buffer.alloc(padding, 0x5a)]);
  const packets: Buffer[] = [];
  for (let at = 0; at < pes.length; at += 184) {
    const chunk = pes.subarray(at, at + 184);
    const packet = Buffer.alloc(188, 0xff);
    packet.set([0x47, (at === 0 ? 0x40 : 0) | 0x01, 0x00]);
    if (chunk.length === 184) packet[3] = 0x10;
    else packet.set([0x30, 184 - 1 - chunk.length, 0x00], 3);
    packet.set(chunk, 188 - chunk.length);
    packets.push(packet);
  }
  return Buffer.concat(packets);
}

/**
 * A stand-in for ffmpeg: the fake backend passes the run's byte range and keyframes as its one argument, and the test
 * moves each run along by hand (`step`) or lets it finish at once (`auto`). Each step writes the next keyframe's IDR
 * and a P frame; the encoder hands an interval over once the next one's IDR is complete.
 */
class FakeFfmpeg {
  readonly runs: FakeRun[] = [];
  auto = false;
  /** Keyframe PTS whose first encode comes out this many bytes larger (an over-budget encode). */
  readonly oversize = new Map<number, number>();
  /** Keyframe PTS whose every encode comes out this many bytes larger: at no rate does it fit. */
  readonly stuck = new Map<number, number>();
  readonly backend: EncoderBackend = {
    id: 'fake',
    binary: 'fake-ffmpeg',
    args: (input) => [JSON.stringify({ startByte: input.startByte, keys: input.keyframesPts90 })],
  };
  readonly spawn = ((_binary: string, args: string[]) => {
    const run = new FakeRun(JSON.parse(args[0]!) as { startByte: number; keys: number[] }, this.oversize, this.stuck);
    this.runs.push(run);
    if (this.auto) setImmediate(() => run.finish());
    return run.child;
  }) as unknown as typeof nodeSpawn;
}

class FakeRun {
  readonly child = Object.assign(new EventEmitter(), {
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    /** Takes the clip's bytes as ffmpeg would. */
    stdin: new PassThrough().resume(),
    killed: false,
    kill: (): boolean => {
      this.child.killed = true;
      return true;
    },
  });
  private written = 0;
  constructor(
    readonly args: { startByte: number; keys: number[] },
    private readonly oversize: Map<number, number>,
    private readonly stuck: ReadonlyMap<number, number> = new Map(),
  ) {}

  step(n = 1): void {
    for (let i = 0; i < n && this.written < this.args.keys.length; i++, this.written++) {
      const key = this.args.keys[this.written]!;
      const extra = this.oversize.get(key) ?? this.stuck.get(key) ?? 0;
      this.oversize.delete(key);
      this.child.stdout.write(Buffer.concat([videoPes(key, true, extra), videoPes(key + 3750, false)]));
    }
  }

  /** ffmpeg fails: its output ends and it exits with 1. */
  fail(): void {
    this.child.stdout.once('end', () => setImmediate(() => this.child.emit('close', 1, null)));
    this.child.stdout.end();
  }

  /** ffmpeg ends: the rest of its output, then it exits with 0 once it has read all of its input. */
  finish(): void {
    if (this.child.killed) return;
    this.step(this.args.keys.length);
    const read = new Promise<void>((resolve) => (this.child.stdin.writableFinished ? resolve() : this.child.stdin.once('finish', resolve)));
    this.child.stdout.once('end', () => void read.then(() => setImmediate(() => this.child.emit('close', 0, null))));
    this.child.stdout.end();
  }
}

/** The level's layout as its manifest gives it: the clip's size and its EP entries (one per interval). */
function layout(manifest: DiscManifest): { size: number; spns: number[]; pts45: number[] } {
  const clpi = parseClpi(new Uint8Array(Buffer.from(manifest.inline[CLPI_PATH]!, 'base64')));
  const entries = clpi.epMaps.find((m) => m.pid === VIDEO)!.entries;
  return { size: manifest.files.find((f) => f.path === M2TS_PATH)!.size, spns: entries.map((e) => e.spn), pts45: entries.map((e) => e.pts) };
}

function intervalRange(l: ReturnType<typeof layout>, i: number): { offset: number; length: number } {
  const offset = l.spns[i]! * 192;
  const end = i + 1 < l.spns.length ? l.spns[i + 1]! * 192 : l.size;
  return { offset, length: end - offset };
}

/** PIDs in a stretch of a level's bytes, and the PTS of each video PES in it (demuxed by the engine). */
function scan(bytes: Uint8Array): { pids: Set<number>; videoPts: number[] } {
  const pids = new Set<number>();
  const videoPts: number[] = [];
  const assembler = new PesAssembler((p) => videoPts.push(p.pts!));
  for (let at = 0; at + 192 <= bytes.length; at += 192) {
    const ts = parseSourcePacket(bytes, at);
    if (!ts) continue;
    pids.add(ts.pid);
    if (ts.pid === VIDEO) assembler.push(ts);
  }
  assembler.flush();
  return { pids, videoPts };
}

let scratch: string;
let clock: ManualClock;
let fake: FakeFfmpeg;
let service: LevelService;
let capacity: Capacity;

function makeService(
  options: { readAheadMs?: number; waitFilmMs?: number; log?: (message: string) => void; discs?: (id: string) => Promise<LevelDiscSource | null>; backend?: EncoderBackend; codecs?: ReadonlySet<'h264' | 'hevc'> } = {},
): LevelService {
  capacity = new Capacity({ h264: 190, hevc: 100 }, clock.now);
  return new LevelService({
    discs: options.discs ?? (async (id) => (id === DISC_ID ? folderDiscSource(DISC_DIR, { id, name: 'Starfall Wanderer' }) : null)),
    cache: new SegmentCache(join(scratch, 'transcode'), 1 << 30),
    capacity,
    backend: options.backend ?? fake.backend,
    ...(options.backend ? {} : { spawn: fake.spawn }),
    probe: async () => ({ interlaced: false, softPulldown: false }),
    planTuning: RAW_PLAN,
    clock,
    ...(options.readAheadMs === undefined ? {} : { readAheadMs: options.readAheadMs }),
    ...(options.waitFilmMs === undefined ? {} : { waitFilmMs: options.waitFilmMs }),
    ...(options.codecs ? { codecs: options.codecs } : {}),
    ...(options.log ? { log: options.log } : {}),
  });
}

beforeEach(() => {
  scratch = mkdtempSync(join(tmpdir(), 'level-service-'));
  clock = new ManualClock();
  fake = new FakeFfmpeg();
  service = makeService();
});

afterEach(async () => {
  service.close();
  // Segment writes a test didn't wait for may still be landing.
  await new Promise((r) => setTimeout(r, 20));
  rmSync(scratch, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
});

const never = new AbortController().signal;

async function levelManifest(s: LevelService = service): Promise<DiscManifest> {
  const m = await s.manifest(DISC_ID, 'h264-1080', 1, VIEWING);
  if (!m || 'busy' in m) throw new Error('no manifest');
  return m;
}

function readInterval(l: ReturnType<typeof layout>, i: number, s: LevelService = service): Promise<Buffer | { retryAfter: 1 } | { busy: true } | null> {
  const { offset, length } = intervalRange(l, i);
  return s.read(DISC_ID, 'h264-1080', 1, M2TS_PATH, offset, length, VIEWING, never);
}

async function bytesOf(p: Promise<Buffer | { retryAfter: 1 } | { busy: true } | null>): Promise<Buffer> {
  const got = await p;
  if (!Buffer.isBuffer(got)) throw new Error(`not bytes: ${JSON.stringify(got)}`);
  return got;
}

describe('LevelService: timings', () => {
  it('uses the spec’s windows: 120 s of film ahead, 15 s of waiting, 60 s to idle; a read waits on the encoder within 10 s of film', () => {
    expect(READ_AHEAD_FILM_MS).toBe(120_000);
    expect(WAIT_FILM_MS).toBe(10_000);
    expect(READ_WAIT_MS).toBe(15_000);
    expect(ENCODER_IDLE_MS).toBe(60_000);
  });
});

describe('LevelService: manifest', () => {
  it('gives the .m2ts size planClip gives, and the rewritten CLPI and MPLS, inlined', async () => {
    const original = await folderDiscSource(DISC_DIR, { id: DISC_ID, name: 'Starfall Wanderer' }).manifest();
    const manifest = await levelManifest();

    const clpiBytes = fixtureBytes('CLIPINF/00001.clpi');
    const mplsBytes = fixtureBytes('PLAYLIST/00000.mpls');
    const clpi = parseClpi(clpiBytes);
    const item = parseMpls(mplsBytes).playItems[0]!;
    const kept = keptAudioFor(item, 1)!;
    expect(kept.pid).toBe(TRUEHD);
    // The kept audio's rate in source packets, from the first AC-3 core PES of the TrueHD PID, read with the engine's demuxer.
    const raw: Uint8Array[][] = [];
    const m2ts = fixtureBytes('STREAM/00001.m2ts');
    for (let at = 0; at + 192 <= m2ts.length; at += 192) {
      const ts = parseSourcePacket(m2ts, at);
      if (ts?.pid !== TRUEHD || !ts.hasPayload) continue;
      if (ts.payloadUnitStart) raw.push([]);
      raw.at(-1)?.push(ts.payload);
    }
    const parsed = (bytes: Uint8Array): PesPacket => {
      const out: PesPacket[] = [];
      const assembler = new PesAssembler((p) => out.push(p));
      assembler.push({ pid: TRUEHD, payloadUnitStart: true, continuityCounter: 0, hasPayload: true, payload: bytes });
      assembler.flush();
      return out[0]!;
    };
    const core = raw.map((chunks) => Buffer.concat(chunks)).map((b) => b.subarray(0, 6 + ((b[4]! << 8) | b[5]!))).find((b) => parsed(b).streamIdExtension === 0x76)!;
    const nominal = nominalAudioBps(CodingType.TRUEHD, parsed(core).payload);
    const audioBps = audioWireBps(CodingType.TRUEHD, core);
    expect(audioBps).toBe(Math.ceil((nominal * Math.ceil(core.length / 184) * 192) / parsed(core).payload.length));
    expect(await firstAudioBps(createReadStream(join(DISC_DIR, 'BDMV/STREAM/00001.m2ts')), TRUEHD, CodingType.TRUEHD)).toBe(audioBps);

    const def = levelDefFor('h264-1080', { height: 1080 });
    const plan = planClip(clpi, def, audioBps, RAW_PLAN);
    const rate = clpi.programs[0]!.streams.find((s) => s.pid === VIDEO)!.rate;
    const clpiLevel = rewriteClpi(clpiBytes, { intervals: plan.intervals, level: def, keepPids: PG, audio: kept, videoPid: VIDEO, ...videoAttrsFor(def, rate) });
    const mplsLevel = rewriteMpls(mplsBytes, { audioStreamNumber: 1 }, videoAttrsFor(def, rate));

    const size = (path: string): number | undefined => manifest.files.find((f) => f.path === path)?.size;
    expect(size(M2TS_PATH)).toBe(plan.sizeBytes);
    expect(size(CLPI_PATH)).toBe(clpiLevel.length);
    expect(size(MPLS_PATH)).toBe(mplsLevel.length);
    expect(manifest.inline[CLPI_PATH]).toBe(Buffer.from(clpiLevel).toString('base64'));
    expect(manifest.inline[MPLS_PATH]).toBe(Buffer.from(mplsLevel).toString('base64'));
    // Everything else as the original.
    expect(manifest.files.map((f) => f.path)).toEqual(original.files.map((f) => f.path));
    expect(manifest.inline['BDMV/INDEX.BDMV']).toBe(original.inline['BDMV/INDEX.BDMV']);
    // The rewritten files read the same through the files route.
    const clpiRead = await service.read(DISC_ID, 'h264-1080', 1, CLPI_PATH, 0, clpiLevel.length, VIEWING, never);
    expect(clpiRead).toEqual(Buffer.from(clpiLevel));
  });

  it('is null for a disc that is gone, a level the disc isn’t offered at, and a bad audio number', async () => {
    expect(await service.manifest('gone', 'h264-1080', 1, VIEWING)).toBeNull();
    expect(await service.manifest(DISC_ID, 'hevc-1080-hdr', 1, VIEWING)).toBeNull(); // an SDR source
    expect(await service.manifest(DISC_ID, 'original', 1, VIEWING)).toBeNull();
    expect(await service.manifest(DISC_ID, 'h264-1080', 0, VIEWING)).toBeNull();
  });

  it('is busy when the GPU has no room, and a viewer’s new audio moves its lease', async () => {
    for (let i = 0; i < 6; i++) expect(capacity.lease(`other${i}`, 'h264', 24_000 / 1001)).toBe(true);
    expect(await service.manifest(DISC_ID, 'h264-1080', 1, VIEWING)).toEqual({ busy: true });
    capacity.release('other5');
    expect(await service.manifest(DISC_ID, 'h264-1080', 1, VIEWING)).not.toHaveProperty('busy');
    const audio2 = viewingIdOf('dev1', DISC_ID, 'h264-1080', 2);
    expect(await service.manifest(DISC_ID, 'h264-1080', 2, audio2)).not.toHaveProperty('busy');
    expect(capacity.has(VIEWING)).toBe(false);
    expect(capacity.has(audio2)).toBe(true);
  });
});

describe('LevelService: levels', () => {
  it('lists the levels of an H.264 1080p disc, gated by what the client decodes and by capacity', async () => {
    const levels = (await service.levels(DISC_ID, { hevc: false, hevc10: false, hdr: false }))!;
    expect(levels.map((l) => [l.level, l.available, l.reason])).toEqual([
      ['original', true, undefined],
      ['h264-1080', true, undefined],
      ['hevc-1080', false, 'no-hevc'],
      ['phone-720', true, undefined],
    ]);
    const manifest = await levelManifest();
    const film = (() => {
      const { intervals } = planClip(parseClpi(fixtureBytes('CLIPINF/00001.clpi')), levelDefFor('h264-1080', { height: 1080 }), 0, RAW_PLAN);
      return intervals.reduce((n, iv) => n + iv.endPts45 - iv.startPts45, 0) / 45_000;
    })();
    const size = manifest.files.find((f) => f.path === M2TS_PATH)!.size;
    expect(levels[1]!.budgetMbps).toBeCloseTo((size * 8) / film / 1e6, 1);
    expect(levels.find((l) => l.level === 'phone-720')!.budgetMbps).toBeLessThan(levels[1]!.budgetMbps);
    for (let i = 0; i < 3; i++) capacity.lease(`hevc${i}`, 'hevc', 24_000 / 1001);
    const busy = (await service.levels(DISC_ID, { hevc: true, hevc10: true, hdr: true }))!;
    expect(busy.find((l) => l.level === 'hevc-1080')).toMatchObject({ available: false, reason: 'busy' });
  });

  it('never offers the original of an MPEG-2 disc', async () => {
    const s = makeService({ discs: async (id) => folderDiscSource(join(SYNTHETIC, 'disc-mpeg2'), { id, name: 'Starfall Wanderer' }) });
    const levels = (await s.levels('mpeg2', { hevc: false, hevc10: false, hdr: false }))!;
    expect(levels[0]).toMatchObject({ level: 'original', available: false, reason: 'unplayable' });
    expect(levels.find((l) => l.level === 'h264-1080')).toMatchObject({ available: true });
    s.close();
  });
});

describe('LevelService: reads', () => {
  it('serves sequential reads in order, each interval with its own video, and runs one encoder for all of them', async () => {
    fake.auto = true;
    const l = layout(await levelManifest());
    expect(l.spns.length).toBe(10);
    for (let i = 0; i < 10; i++) {
      const bytes = await bytesOf(readInterval(l, i));
      expect(bytes.length).toBe(intervalRange(l, i).length);
      const { pids, videoPts } = scan(bytes);
      expect(videoPts).toEqual([epFrame(l.pts45[i]!), epFrame(l.pts45[i]!) + 3750]);
      expect(pids.has(TRUEHD)).toBe(true);
    }
    expect(fake.runs.length).toBe(1);
    expect(fake.runs[0]!.args.startByte).toBe(0);
  });

  it('serves a read across intervals by continuing into the next', async () => {
    fake.auto = true;
    const l = layout(await levelManifest());
    const a = intervalRange(l, 2);
    const offset = a.offset + 1000;
    const length = a.length - 1000 + 5000;
    const bytes = await bytesOf(service.read(DISC_ID, 'h264-1080', 1, M2TS_PATH, offset, length, VIEWING, never));
    const two = await bytesOf(readInterval(l, 2));
    const three = await bytesOf(readInterval(l, 3));
    // Buffer.equals: a deep equality over megabytes is slow.
    expect(bytes.equals(Buffer.concat([two.subarray(1000), three.subarray(0, 5000)]))).toBe(true);
  });

  it('restarts at a seek far ahead of the encoder, and a read back hits the cache (Review Focus 2)', async () => {
    service.close();
    service = makeService({ readAheadMs: 3000, waitFilmMs: 3000 });
    const l = layout(await levelManifest());
    const zero = readInterval(l, 0);
    await vi.waitFor(() => expect(fake.runs.length).toBe(1));
    fake.runs[0]!.step(3); // intervals 0 and 1 are done; the encoder is at 2
    const first = await bytesOf(zero);
    const one = await bytesOf(readInterval(l, 1));
    expect(scan(one).videoPts[0]).toBe(epFrame(l.pts45[1]!));

    const eight = readInterval(l, 8); // 6 s of film past the encoder: a seek
    await vi.waitFor(() => expect(fake.runs.length).toBe(2));
    expect(fake.runs[0]!.child.killed).toBe(true);
    const seekRun = fake.runs[1]!;
    const plan = planClip(parseClpi(fixtureBytes('CLIPINF/00001.clpi')), levelDefFor('h264-1080', { height: 1080 }), 0, RAW_PLAN).intervals;
    expect(seekRun.args.startByte).toBe(plan[8]!.srcSpnStart * 192);
    seekRun.finish();
    expect(scan(await bytesOf(eight)).videoPts[0]).toBe(epFrame(l.pts45[8]!));

    const runsBefore = fake.runs.length;
    const back = await bytesOf(readInterval(l, 1)); // nothing steps the encoder: only the cache can answer
    expect(back.equals(one)).toBe(true);
    expect((await bytesOf(readInterval(l, 0))).equals(first)).toBe(true);
    // Then the encoder runs on ahead of the read, from the first interval not cached (never a cached one).
    await vi.waitFor(() => expect(fake.runs.length).toBe(runsBefore + 1));
    expect(fake.runs[runsBefore]!.args.startByte).toBe(plan[2]!.srcSpnStart * 192);
  });

  it('gives each viewing its own encoder: a viewer far ahead doesn’t restart another’s', async () => {
    service.close();
    service = makeService({ readAheadMs: 3000, waitFilmMs: 3000 });
    const l = layout(await levelManifest());
    const zero = readInterval(l, 0);
    await vi.waitFor(() => expect(fake.runs.length).toBe(1));
    fake.runs[0]!.step(2);
    await bytesOf(zero);
    const other = viewingIdOf('dev2', DISC_ID, 'h264-1080', 1);
    const { offset, length } = intervalRange(l, 8);
    const eight = service.read(DISC_ID, 'h264-1080', 1, M2TS_PATH, offset, length, other, never);
    await vi.waitFor(() => expect(fake.runs.length).toBe(2));
    expect(fake.runs[0]!.child.killed).toBe(false);
    fake.runs[1]!.finish();
    expect(scan(await bytesOf(eight)).videoPts[0]).toBe(epFrame(l.pts45[8]!));
    const one = readInterval(l, 1);
    fake.runs[0]!.step(1);
    expect(scan(await bytesOf(one)).videoPts[0]).toBe(epFrame(l.pts45[1]!));
  });

  it('waits for an interval the running encoder will reach soon, without a restart', async () => {
    const l = layout(await levelManifest());
    const zero = readInterval(l, 0);
    await vi.waitFor(() => expect(fake.runs.length).toBe(1));
    fake.runs[0]!.step(2);
    await bytesOf(zero);
    const five = readInterval(l, 5);
    fake.runs[0]!.finish();
    expect(scan(await bytesOf(five)).videoPts[0]).toBe(epFrame(l.pts45[5]!));
    expect(fake.runs.length).toBe(1);
  });

  it('restarts at a seek inside the encode-ahead window but past the wait distance, rather than wait for the encoder', async () => {
    // Scaled down: the fixture has 10 s of film. A 120 s window with a 1 s wait distance stands for a seek 60 s ahead.
    service.close();
    service = makeService({ readAheadMs: 120_000, waitFilmMs: 1000 });
    const l = layout(await levelManifest());
    const zero = readInterval(l, 0);
    await vi.waitFor(() => expect(fake.runs.length).toBe(1));
    fake.runs[0]!.step(3); // the encoder is at interval 2, and its window covers the whole clip
    await bytesOf(zero);
    const six = readInterval(l, 6); // 4 s of film ahead: inside the window, past the wait distance
    await vi.waitFor(() => expect(fake.runs.length).toBe(2));
    expect(fake.runs[0]!.child.killed).toBe(true);
    const plan = planClip(parseClpi(fixtureBytes('CLIPINF/00001.clpi')), levelDefFor('h264-1080', { height: 1080 }), 0, RAW_PLAN).intervals;
    expect(fake.runs[1]!.args.startByte).toBe(plan[6]!.srcSpnStart * 192);
    fake.runs[1]!.finish();
    expect(scan(await bytesOf(six)).videoPts[0]).toBe(epFrame(l.pts45[6]!));
  });

  it('re-encodes an interval whose encode overflows its budget before serving it (Review Focus 1)', async () => {
    fake.auto = true;
    const manifest = await levelManifest();
    const l = layout(manifest);
    const { length } = intervalRange(l, 3);
    fake.oversize.set(epFrame(l.pts45[3]!), length); // the first encode of interval 3 can't fit
    for (let i = 0; i < 10; i++) {
      const bytes = await bytesOf(readInterval(l, i));
      expect(bytes.length).toBe(intervalRange(l, i).length);
      expect(scan(bytes).videoPts[0]).toBe(epFrame(l.pts45[i]!));
    }
    // The run, then interval 3 alone again.
    const plan = planClip(parseClpi(fixtureBytes('CLIPINF/00001.clpi')), levelDefFor('h264-1080', { height: 1080 }), 0, RAW_PLAN).intervals;
    expect(fake.runs.map((r) => r.args.startByte / 192)).toEqual([0, plan[3]!.srcSpnStart]);
    expect(fake.runs[1]!.args.keys).toEqual([epFrame(l.pts45[3]!), epFrame(l.pts45[4]!)]);
  });

  it('hands the clip’s PG streams to the last resort, then remembers an interval that fits at no rate (one 500, no re-encode loop)', async () => {
    const logged: string[] = [];
    service.close();
    service = makeService({ log: (m) => logged.push(m) });
    fake.auto = true;
    const l = layout(await levelManifest());
    const { length } = intervalRange(l, 3);
    fake.stuck.set(epFrame(l.pts45[3]!), 8 * length); // interval 3 never fits, even with its subtitles dropped
    const raw = planClip(parseClpi(fixtureBytes('CLIPINF/00001.clpi')), levelDefFor('h264-1080', { height: 1080 }), 0, RAW_PLAN).intervals;
    const intervalStart = (i: number): number => raw[i]!.srcSpnStart * 192;
    vi.mocked(shedGraphics).mockClear();
    await expect(readInterval(l, 3)).rejects.toThrow(/250 kbps with its graphics dropped/);
    // The floor's video and the 250 kbps video both went through the last resort, with the clip's PG streams by number.
    expect(vi.mocked(shedGraphics).mock.calls.map((c) => c[1])).toEqual([
      { pg: PG, ig: [] },
      { pg: PG, ig: [] },
    ]);
    expect(logged.some((m) => m.includes(`disc ${DISC_ID} clip 00001 at h264-1080, audio 1, interval 3`))).toBe(true);
    const at3 = (): number => fake.runs.filter((r) => r.args.startByte === intervalStart(3)).length;
    const encodes = at3();
    expect(encodes).toBe(3); // the run from interval 3, then the floor and 250 kbps tries
    // Later reads fail at once, also after the 5 s back-off, without encoding interval 3 again.
    await expect(readInterval(l, 3)).rejects.toThrow(/250 kbps/);
    clock.advance(10_000);
    await expect(readInterval(l, 3)).rejects.toThrow(/250 kbps/);
    expect(at3()).toBe(encodes);
  });

  it('answers retryAfter once a read has waited 15 s, and the encoder carries on', async () => {
    const l = layout(await levelManifest());
    let settled: unknown = null;
    const read = readInterval(l, 4).then((r) => (settled = r));
    await vi.waitFor(() => expect(fake.runs.length).toBe(1));
    clock.advance(14_999);
    await new Promise((r) => setImmediate(r));
    expect(settled).toBeNull();
    clock.advance(1);
    await read;
    expect(settled).toEqual({ retryAfter: 1 });
    expect(fake.runs[0]!.child.killed).toBe(false);
    // The retry finds the interval once the encoder made it.
    fake.runs[0]!.finish();
    expect(scan(await bytesOf(readInterval(l, 4))).videoPts[0]).toBe(epFrame(l.pts45[4]!));
  });

  it('stops the encoder 60 s after the last read', async () => {
    const l = layout(await levelManifest());
    const zero = readInterval(l, 0);
    await vi.waitFor(() => expect(fake.runs.length).toBe(1));
    fake.runs[0]!.step(2);
    await bytesOf(zero);
    clock.advance(30_000);
    await bytesOf(readInterval(l, 0)); // a read, from the cache, keeps it going
    clock.advance(59_999);
    expect(fake.runs[0]!.child.killed).toBe(false);
    clock.advance(1);
    expect(fake.runs[0]!.child.killed).toBe(true);
  });

  it('is busy for a viewing with no lease when the GPU is full; a lease is touched by reads', async () => {
    const l = layout(await levelManifest());
    clock.advance(100_000);
    fake.auto = true;
    await bytesOf(readInterval(l, 0));
    clock.advance(100_000); // 200 s since the manifest, 100 s since the read: still leased
    expect(capacity.has(VIEWING)).toBe(true);
    for (let i = 0; i < 5; i++) capacity.lease(`other${i}`, 'h264', 24_000 / 1001);
    const other = viewingIdOf('dev2', DISC_ID, 'h264-1080', 1);
    const { offset, length } = intervalRange(l, 0);
    expect(await service.read(DISC_ID, 'h264-1080', 1, M2TS_PATH, offset, length, other, never)).toEqual({ busy: true });
  });

  it('refuses a range past the file', async () => {
    const l = layout(await levelManifest());
    await expect(service.read(DISC_ID, 'h264-1080', 1, M2TS_PATH, l.size - 10, 11, VIEWING, never)).rejects.toThrow(RangeError);
  });
});

describe('isoDiscSource', () => {
  it('reads an ISO disc as its folder twin', async () => {
    const abs = join(SYNTHETIC, 'disc1.iso');
    const iso = isoDiscSource(abs, await readIsoTree(abs), { id: 'disc1', name: 'Starfall Wanderer' });
    const folder = folderDiscSource(join(SYNTHETIC, 'disc1'), { id: 'disc1', name: 'Starfall Wanderer' });
    const [a, b] = await Promise.all([iso.manifest(), folder.manifest()]);
    expect(a.files).toEqual(b.files);
    const path = a.files.find((f) => f.path.endsWith('.M2TS'))!.path;
    expect(await iso.readRange(path, 1000, 5000)).toEqual(await folder.readRange(path, 1000, 5000));
    const clip = (await iso.clip(path))!;
    const chunks: Buffer[] = [];
    for await (const c of clip.read(192, 192 * 40) as AsyncIterable<Buffer>) chunks.push(c);
    expect(Buffer.concat(chunks)).toEqual(await folder.readRange(path, 192, 192 * 39));
    expect('read' in clip.input).toBe(true);
  });
});

const hasX264 = spawnSync('ffmpeg', ['-hide_banner', '-encoders'], { encoding: 'utf8' }).stdout?.includes('libx264') ?? false;
/** CI installs ffmpeg: there, a missing libx264 fails this test instead of skipping it. */
const runFfmpegTests = hasX264 || Boolean(process.env.CI);

describe.skipIf(!runFfmpegTests)('LevelService with libx264', () => {
  // As it is, and behind a filter that moves every frame's PTS as ffmpeg 7.1's QSV filters do (by up to a frame).
  for (const [name, backend, merged] of [
    ['libx264', x264Backend, false],
    ['PTS 1129 ticks early', distortingBackend(shiftedBy(1129)), false],
    ['PTS a frame less a tick early', distortingBackend(shiftedBy(3749)), false],
    // The production plan: disc-levels' GOPs are under 2 s, so it merges intervals and drops their EP entries.
    ['libx264, merged plan', x264Backend, true],
  ] as const) {
    it(`serves disc-levels at h264-1080 (${name}): the manifest’s size, the source's frames with an IDR at every EP entry, the kept audio and both PG, no PiP or commentary`, async () => {
      service.close();
      service = new LevelService({
        discs: async (id) => (id === DISC_ID ? folderDiscSource(DISC_DIR, { id, name: 'Starfall Wanderer' }) : null),
        cache: new SegmentCache(join(scratch, 'transcode'), 1 << 30),
        capacity: new Capacity({ h264: 190, hevc: 100 }),
        backend,
        ...(merged ? {} : { planTuning: RAW_PLAN }),
      });
      const manifest = await levelManifest();
      const l = layout(manifest);
      const sourceEntries = parseClpi(fixtureBytes('CLIPINF/00001.clpi')).epMaps.find((m) => m.pid === VIDEO)!.entries;
      if (merged) {
        expect(l.pts45.length).toBeGreaterThan(1);
        expect(l.pts45.length).toBeLessThan(sourceEntries.length);
        for (const pts of l.pts45) expect(sourceEntries.some((e) => e.pts === pts)).toBe(true);
      } else expect(l.pts45.length).toBe(sourceEntries.length);
      let bytes: Buffer | null = null;
      for (let tries = 0; !bytes && tries < 10; tries++) {
        const got = await service.read(DISC_ID, 'h264-1080', 1, M2TS_PATH, 0, l.size, VIEWING, never);
        if (Buffer.isBuffer(got)) bytes = got;
        else expect(got).toEqual({ retryAfter: 1 });
      }
      expect(bytes).not.toBeNull();
      expect(bytes!.length).toBe(l.size);

      // Seek to every EP entry as the engine does, and demux: the first video there is an IDR at the entry's PTS.
      const source: ByteSource = {
        exists: (p) => p === M2TS_PATH,
        size: () => bytes!.length,
        list: () => [],
        read: async (_p, offset, length) => bytes!.subarray(offset, offset + length),
      };
      for (let i = 0; i < l.spns.length; i++) {
        const reader = new M2tsReader({ source, path: M2TS_PATH, startSpn: l.spns[i]!, pids: new Set([VIDEO]), chunkPackets: 32 });
        let first: PesPacket | undefined;
        while (!first) {
          const got = await reader.next();
          if (got === null) break;
          first = got.find((p) => p.pid === VIDEO);
        }
        reader.cancel();
        expect(first, `EP entry ${i}`).toBeDefined();
        expect(first!.pts).toBe(epFrame(l.pts45[i]!));
        expect(analyzeAvc(first!.payload).idr).toBe(true);
      }

      const { pids, videoPts } = scan(bytes!);
      expect(pids.has(VIDEO)).toBe(true);
      // Every frame on the source's clock, as the untouched audio and subtitles are.
      expect(videoPts.sort((a, b) => a - b)).toEqual([...SOURCE_PTS].sort((a, b) => a - b));
      expect(pids.has(TRUEHD)).toBe(true);
      for (const pg of PG) expect(pids.has(pg)).toBe(true);
      expect(pids.has(PIP)).toBe(false);
      expect(pids.has(COMMENTARY)).toBe(false);
      // The kept audio is the TrueHD PID's AC-3 core only.
      const audio: PesPacket[] = [];
      const assembler = new PesAssembler((p) => audio.push(p));
      for (let at = 0; at + 192 <= bytes!.length; at += 192) {
        const ts = parseSourcePacket(bytes!, at);
        if (ts?.pid === TRUEHD) assembler.push(ts);
      }
      assembler.flush();
      expect(audio.length).toBeGreaterThan(0);
      expect(audio.every((p) => p.streamIdExtension === 0x76 || (p.payload[0] === 0x0b && p.payload[1] === 0x77))).toBe(true);
    }, 120_000);
  }
});

/** A copy of disc-levels to change, in the test's scratch folder. */
function discCopy(name = 'copy'): string {
  const dir = join(scratch, name);
  cpSync(DISC_DIR, dir, { recursive: true });
  return dir;
}

function serviceOn(dir: string, options: { readAheadMs?: number; log?: (message: string) => void } = {}): LevelService {
  return makeService({ ...options, discs: async (id) => (id === DISC_ID ? folderDiscSource(dir, { id, name: 'Starfall Wanderer' }) : null) });
}

describe('clipFrameTicks and the encoder version', () => {
  it('takes the probe’s frame time, never more than the CLPI rate’s (a clip that opens on a still)', () => {
    expect(clipFrameTicks({ interlaced: false, softPulldown: false, frameTicks: 3750 }, 1)).toBe(3750); // 24 fps video, a 23.976 CLPI
    expect(clipFrameTicks({ interlaced: false, softPulldown: false, frameTicks: 90_000 }, 1)).toBe(3753); // a still's second
    expect(clipFrameTicks({ interlaced: true, softPulldown: false }, 4)).toBe(3003); // no probe frames: the CLPI's 29.97
  });

  it('puts the encoder version in the plan hash: no segment of an earlier encoder is served', () => {
    const def = levelDefFor('h264-1080', { height: 1080 });
    const { intervals } = planClip(parseClpi(fixtureBytes('CLIPINF/00001.clpi')), def, 0, RAW_PLAN);
    const encode = { backend: 'qsv', deinterlace: false };
    // The hash before version 2, which had no encoder version in it.
    const h = createHash('sha256');
    h.update(JSON.stringify({ def, kept: null, backend: encode.backend, deinterlace: encode.deinterlace }));
    for (const iv of intervals) h.update(`${iv.startPts45},${iv.endPts45},${iv.srcSpnStart},${iv.srcSpnEnd},${iv.budgetBytes};`);
    expect(ENCODER_VERSION).toBe(2);
    expect(planHash(def, null, intervals, encode)).not.toBe(h.digest('hex').slice(0, 12));
  });
});

describe('LevelService: fix round 1', () => {
  it('reads each clip’s own audio rate, though two clips carry different audio on one PID', async () => {
    // disc-levels' clip 00001 (TrueHD on 0x1100) and disc1's clip 00002 (LPCM on 0x1100), each in its own playlist.
    const dir = discCopy();
    const disc1 = join(SYNTHETIC, 'disc1/BDMV');
    cpSync(join(disc1, 'STREAM/00002.m2ts'), join(dir, 'BDMV/STREAM/00002.m2ts'));
    cpSync(join(disc1, 'CLIPINF/00002.clpi'), join(dir, 'BDMV/CLIPINF/00002.clpi'));
    cpSync(join(disc1, 'PLAYLIST/00001.mpls'), join(dir, 'BDMV/PLAYLIST/00001.mpls'));
    service.close();
    service = serviceOn(dir);
    const manifest = await levelManifest();

    const bpsOf = (m2ts: string, coding: number): Promise<number> => firstAudioBps(createReadStream(m2ts), TRUEHD, coding);
    const truehd = await bpsOf(join(dir, 'BDMV/STREAM/00001.m2ts'), CodingType.TRUEHD);
    const lpcm = await bpsOf(join(dir, 'BDMV/STREAM/00002.m2ts'), CodingType.LPCM);
    expect(lpcm).not.toBe(truehd);
    const sizeOf = (clip: string, bps: number): number => {
      const clpi = parseClpi(new Uint8Array(readFileSync(join(dir, `BDMV/CLIPINF/${clip}.clpi`))));
      return planClip(clpi, levelDefFor('h264-1080', { height: 1080 }), bps, RAW_PLAN).sizeBytes;
    };
    const size = (path: string): number => manifest.files.find((f) => f.path === path)!.size;
    expect(size('BDMV/STREAM/00001.M2TS')).toBe(sizeOf('00001', truehd));
    expect(size('BDMV/STREAM/00002.M2TS')).toBe(sizeOf('00002', lpcm));
  });

  it('puts a hash of the clip’s plan in its segment cache key', async () => {
    fake.auto = true;
    const l = layout(await levelManifest());
    await bytesOf(readInterval(l, 0));
    const clpi = parseClpi(fixtureBytes('CLIPINF/00001.clpi'));
    const kept = keptAudioFor(parseMpls(fixtureBytes('PLAYLIST/00000.mpls')).playItems[0]!, 1)!;
    const def = levelDefFor('h264-1080', { height: 1080 });
    const bps = await firstAudioBps(createReadStream(join(DISC_DIR, 'BDMV/STREAM/00001.m2ts')), TRUEHD, CodingType.TRUEHD);
    const { intervals } = planClip(clpi, def, bps, RAW_PLAN);
    const encode = { backend: 'fake', deinterlace: false };
    const hash = planHash(def, kept, intervals, encode);
    expect(hash).toMatch(/^[0-9a-f]{12}$/);
    await vi.waitFor(() => expect(readdirSync(join(scratch, 'transcode', DISC_ID, 'h264-1080', '1'))).toEqual([`00001.${hash}`]));
    // Another budget, another audio stream, another level, another backend or another deinterlace decision is another hash.
    expect(planHash(def, kept, planClip(clpi, def, bps + 64_000, RAW_PLAN).intervals, encode)).not.toBe(hash);
    expect(planHash(def, { ...kept, pid: COMMENTARY }, intervals, encode)).not.toBe(hash);
    expect(planHash(levelDefFor('phone-720', { height: 1080 }), kept, intervals, encode)).not.toBe(hash);
    expect(planHash(def, kept, intervals, { ...encode, backend: 'x264' })).not.toBe(hash);
    expect(planHash(def, kept, intervals, { ...encode, deinterlace: true })).not.toBe(hash);
  });

  it('reads HDR from the CLPI’s dynamic_range_type (Review: HDR was guessed)', async () => {
    const original = fixtureBytes('CLIPINF/00001.clpi');
    const patched = (dynamicRange: number): Uint8Array => {
      const bytes = original.slice();
      const attrs = clpiStreamAttrs(bytes, VIDEO)!;
      attrs[0] = CodingType.HEVC;
      attrs[1] = (8 << 4) | (attrs[1]! & 0x0f); // 2160p
      attrs[3] = (dynamicRange << 4) | (attrs[3]! & 0x0f);
      return bytes;
    };
    for (const [range, hdr] of [
      [0, false],
      [1, true],
      [2, true],
    ] as const) {
      const dir = discCopy(`hdr${range}`);
      writeFileSync(join(dir, 'BDMV/CLIPINF/00001.clpi'), patched(range));
      const disc = await loadDisc(DISC_ID, folderDiscSource(dir, { id: DISC_ID, name: 'Starfall Wanderer' }));
      expect(disc.main!.video).toMatchObject({ codingType: CodingType.HEVC, height: 2160, hdr });
      const s = serviceOn(dir);
      const levels = (await s.levels(DISC_ID, { hevc: true, hevc10: true, hdr: true }))!.map((x) => x.level);
      expect(levels).toEqual(hdr ? ['original', 'hevc-1080-hdr', 'h264-1080-sdr'] : ['original', 'h264-1080', 'hevc-1080', 'phone-720']);
      s.close();
    }
    // The unpatched H.264 clip is SDR.
    expect((await loadDisc(DISC_ID, folderDiscSource(DISC_DIR, { id: DISC_ID, name: 'Starfall Wanderer' }))).main!.video.hdr).toBe(false);
  });

  it('rebuilds a version whose clip was replaced, and stops the encoders of the old one', async () => {
    const dir = discCopy();
    service.close();
    service = serviceOn(dir);
    const l = layout(await levelManifest());
    const zero = readInterval(l, 0);
    await vi.waitFor(() => expect(fake.runs.length).toBe(1));
    fake.runs[0]!.step(2);
    await bytesOf(zero);
    const m2ts = join(dir, 'BDMV/STREAM/00001.m2ts');
    writeFileSync(m2ts, readFileSync(m2ts)); // the same bytes, a new file
    utimesSync(m2ts, new Date(), new Date(Date.now() + 60_000));
    // The read sees the change: the old encoder stops, and interval 0 is encoded again (the old bytes are never served).
    fake.auto = true;
    const again = await bytesOf(readInterval(l, 0));
    expect(fake.runs[0]!.child.killed).toBe(true);
    expect(fake.runs.length).toBe(2);
    expect(fake.runs[1]!.args.startByte).toBe(0);
    expect(scan(again).videoPts[0]).toBe(epFrame(l.pts45[0]!));
    // The manifest is the rebuilt one, and stays it.
    expect(layout(await levelManifest())).toEqual(l);
    expect(fake.runs.length).toBe(2);
  });

  it('answers a read the restarted encoder won’t reach with retryAfter, so two reads two windows apart both finish (Minor 1)', async () => {
    service.close();
    service = makeService({ readAheadMs: 3000, waitFilmMs: 3000 });
    const l = layout(await levelManifest());
    const results: unknown[] = [];
    const a = readInterval(l, 0).then((r) => results.push(['a', r]));
    const b = readInterval(l, 8).then((r) => results.push(['b', r]));
    await vi.waitFor(() => expect(results.length).toBe(1));
    expect((results[0] as [string, unknown])[1]).toEqual({ retryAfter: 1 });
    fake.runs.at(-1)!.finish();
    await Promise.all([a, b]);
    expect(results.length).toBe(2);
    expect(Buffer.isBuffer((results[1] as [string, unknown])[1])).toBe(true);
    expect(fake.runs.length).toBeLessThanOrEqual(2);
  });

  it('fails the waiting reads when the encoder fails, then backs off for 5 s (Minor 2)', async () => {
    expect(FAILURE_BACKOFF_MS).toBe(5_000);
    const l = layout(await levelManifest());
    const zero = readInterval(l, 0);
    const one = readInterval(l, 1);
    await vi.waitFor(() => expect(fake.runs.length).toBe(1));
    fake.runs[0]!.step(1);
    fake.runs[0]!.fail();
    await expect(zero).rejects.toThrow(/exited with 1/);
    await expect(one).rejects.toThrow(/exited with 1/);
    expect(await readInterval(l, 0)).toEqual({ retryAfter: 1 });
    expect(fake.runs.length).toBe(1);
    clock.advance(FAILURE_BACKOFF_MS);
    fake.auto = true;
    expect(scan(await bytesOf(readInterval(l, 0))).videoPts[0]).toBe(epFrame(l.pts45[0]!));
    expect(fake.runs.length).toBe(2);
  });

  it('stops the old viewing’s encoders when a viewer’s lease moves (Minor 3)', async () => {
    const l = layout(await levelManifest());
    const zero = readInterval(l, 0);
    await vi.waitFor(() => expect(fake.runs.length).toBe(1));
    expect(await service.manifest(DISC_ID, 'h264-1080', 2, viewingIdOf('dev1', DISC_ID, 'h264-1080', 2))).not.toHaveProperty('busy');
    expect(fake.runs[0]!.child.killed).toBe(true);
    expect(await zero).toEqual({ retryAfter: 1 }); // the runner closed: the read comes back
  });

  it('release() stops the viewing’s encoders and frees its lease (Minor 8)', async () => {
    const l = layout(await levelManifest());
    const zero = readInterval(l, 0);
    await vi.waitFor(() => expect(fake.runs.length).toBe(1));
    service.release(VIEWING);
    expect(fake.runs[0]!.child.killed).toBe(true);
    expect(capacity.has(VIEWING)).toBe(false);
    expect(await zero).toEqual({ retryAfter: 1 }); // the runner closed: the read comes back
  });

  it('counts the device’s own lease on the disc as free when listing levels (Minor 4)', async () => {
    await levelManifest(); // dev1 holds an H.264 lease on this disc
    capacity.lease('h1', 'hevc', 24_000 / 1001);
    capacity.lease('h2', 'hevc', 24_000 / 1001);
    const client = { hevc: true, hevc10: false, hdr: false };
    expect((await service.levels(DISC_ID, client))!.find((x) => x.level === 'hevc-1080')).toMatchObject({ available: false, reason: 'busy' });
    expect((await service.levels(DISC_ID, client, 'dev1'))!.find((x) => x.level === 'hevc-1080')).toMatchObject({ available: true });
  });
});

describe('LevelService: final review', () => {
  it('prices the levels with the audio stream asked for', async () => {
    const client = { hevc: false, hevc10: false, hdr: false };
    const sizeAt = async (audio: number): Promise<number> => {
      const m = await service.manifest(DISC_ID, 'h264-1080', audio, viewingIdOf('dev-a', DISC_ID, 'h264-1080', audio));
      if (!m || 'busy' in m) throw new Error('no manifest');
      return m.files.find((f) => f.path === M2TS_PATH)!.size;
    };
    const [one, two] = [await sizeAt(1), await sizeAt(2)];
    expect(two).not.toBe(one); // stream 2 (AC-3) travels at another rate than stream 1 (TrueHD's core)
    const film = planClip(parseClpi(fixtureBytes('CLIPINF/00001.clpi')), levelDefFor('h264-1080', { height: 1080 }), 0, RAW_PLAN).intervals.reduce((n, iv) => n + iv.endPts45 - iv.startPts45, 0) / 45_000;
    const at = async (audio?: number): Promise<number> => (await service.levels(DISC_ID, client, undefined, audio))!.find((l) => l.level === 'h264-1080')!.budgetMbps;
    expect(await at()).toBeCloseTo((one * 8) / film / 1e6, 1);
    expect(await at(2)).toBeCloseTo((two * 8) / film / 1e6, 1);
  });

  it('falls back to the coding’s fallback audio rate, and logs it, when the kept audio has no readable frame at the clip’s start', async () => {
    const dir = discCopy();
    const m2ts = join(dir, 'BDMV/STREAM/00001.m2ts');
    const bytes = readFileSync(m2ts);
    for (let at = 0; at + 192 <= bytes.length; at += 192) {
      if (bytes[at + 4] === 0x47 && (((bytes[at + 5]! & 0x1f) << 8) | bytes[at + 6]!) === TRUEHD) {
        bytes[at + 5] = (bytes[at + 5]! & 0xe0) | 0x1f; // the TrueHD packets become null packets
        bytes[at + 6] = 0xff;
      }
    }
    writeFileSync(m2ts, bytes);
    const logged: string[] = [];
    service.close();
    service = serviceOn(dir, { log: (m) => logged.push(m) });
    const manifest = await levelManifest();
    const clpi = parseClpi(fixtureBytes('CLIPINF/00001.clpi'));
    const size = manifest.files.find((f) => f.path === M2TS_PATH)!.size;
    expect(size).toBe(planClip(clpi, levelDefFor('h264-1080', { height: 1080 }), fallbackAudioBps(CodingType.TRUEHD, null), RAW_PLAN).sizeBytes);
    expect(logged.some((m) => m.includes('fallback'))).toBe(true);
  });
});

describe('LevelService: for the routes', () => {
  it('offers no level of a codec whose encoder failed its self-test (x264: H.264 only)', async () => {
    const s = makeService({ codecs: new Set(['h264']) });
    const levels = (await s.levels(DISC_ID, { hevc: true, hevc10: true, hdr: true }))!;
    expect(levels.map((l) => [l.level, l.available, l.reason])).toEqual([
      ['original', true, undefined],
      ['h264-1080', true, undefined],
      ['hevc-1080', false, 'no-encoder'],
      ['phone-720', true, undefined],
    ]);
    expect(await s.manifest(DISC_ID, 'hevc-1080', 1, viewingIdOf('dev1', DISC_ID, 'hevc-1080', 1))).toBeNull();
    expect(await s.size(DISC_ID, 'hevc-1080', 1, M2TS_PATH)).toBeNull();
    expect(await s.read(DISC_ID, 'hevc-1080', 1, M2TS_PATH, 0, 192, viewingIdOf('dev1', DISC_ID, 'hevc-1080', 1), never)).toBeNull();
    expect(await s.manifest(DISC_ID, 'h264-1080', 1, VIEWING)).not.toBeNull();
    s.close();
  });

  it('gives a file’s size at a level, null for a file or level it doesn’t have', async () => {
    const manifest = await levelManifest();
    for (const f of manifest.files) expect(await service.size(DISC_ID, 'h264-1080', 1, f.path.toLowerCase())).toBe(f.size);
    expect(await service.size(DISC_ID, 'h264-1080', 1, 'BDMV/STREAM/99999.M2TS')).toBeNull();
    expect(await service.size(DISC_ID, 'original', 1, M2TS_PATH)).toBeNull();
    expect(await service.size('gone', 'h264-1080', 1, M2TS_PATH)).toBeNull();
  });

  it('says whether the disc’s original plays in the app', async () => {
    expect(await service.originalPlayable(DISC_ID)).toBe(true);
    expect(await service.originalPlayable('gone')).toBeNull();
    const s = makeService({ discs: async (id) => folderDiscSource(join(SYNTHETIC, 'disc-mpeg2'), { id, name: 'Starfall Wanderer' }) });
    expect(await s.originalPlayable('mpeg2')).toBe(false);
    s.close();
  });
});

describe('parseViewingId', () => {
  it('reads a viewing id from the end, whatever the device and disc ids hold', () => {
    expect(parseViewingId(viewingIdOf('dev1', 'abc', 'phone-720', 2))).toEqual({ deviceId: 'dev1', discId: 'abc', level: 'phone-720', audio: 2 });
    // ids are hex, so the last three colons split it; a colon in the device id stays in the device part
    expect(parseViewingId(viewingIdOf('d:e', 'abc', 'h264-1080', 1))).toEqual({ deviceId: 'd:e', discId: 'abc', level: 'h264-1080', audio: 1 });
    expect(parseViewingId('nonsense')).toBeNull();
    expect(parseViewingId('d:x:original:1')).toBeNull();
  });
});
