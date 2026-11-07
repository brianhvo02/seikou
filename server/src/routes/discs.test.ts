import { spawnSync, type spawn as nodeSpawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { cpSync, mkdtempSync, rmSync } from 'node:fs';
import type http from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { afterEach, beforeAll, afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { parseClpi } from '@seikou/bdmv/clpi-parser';
import { CodingType } from '@seikou/bdmv/stream-types';
import type { DiscManifest } from '../../../src/engine/disc/nas-api';
import { appHandlers } from '../app';
import type { Auth } from '../auth';
import { BdjStore } from '../bdj-store';
import { createServer } from '../http';
import type { Handler } from '../http';
import { Library } from '../library';
import { Capacity } from '../levels/capacity';
import { RetryLater, type Clock } from '../levels/clip-run';
import { x264Backend, type EncoderBackend } from '../levels/encoder';
import { LevelService, libraryDiscSources, viewingIdOf } from '../levels/level-service';
import { SegmentCache } from '../levels/segment-cache';
import type { TitleService } from '../titles/service';
import type { OwnerStore } from '../titles/owner-store';
import { BUSY_COPY, BUSY_TRY_LATER_COPY, MAX_LEVEL_READ_BYTES, discRoutes, type LevelRouteService } from './discs';

const SYNTHETIC = join(import.meta.dirname, '../../../fixtures/synthetic');
const M2TS = 'BDMV/STREAM/00001.M2TS';
const CLPI = 'BDMV/CLIPINF/00001.CLPI';
const DEVICE = 'dev1';

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

/** An ffmpeg that starts and says nothing until killed: reads wait on it. */
function silentFfmpeg(): { spawn: typeof nodeSpawn; runs: { killed: boolean }[]; backend: EncoderBackend } {
  const runs: { killed: boolean }[] = [];
  const spawn = (() => {
    const child = Object.assign(new EventEmitter(), {
      stdout: new PassThrough(),
      stderr: new PassThrough(),
      stdin: new PassThrough().resume(),
      killed: false,
      kill: (): boolean => {
        child.killed = true;
        return true;
      },
    });
    runs.push(child);
    return child;
  }) as unknown as typeof nodeSpawn;
  return { spawn, runs, backend: { id: 'fake', binary: 'fake-ffmpeg', args: () => [] } };
}

/** Every token is valid; it names the device `dev<n>` for token `t<n>`. */
const auth = { verify: (token: string) => ({ id: token.replace(/^t/, 'dev'), owner: true, personId: 'p', personName: 'Owner' }) } as unknown as Auth;

let tmp: string;
let library: Library;
const ids: Record<string, string> = {};

beforeAll(async () => {
  tmp = mkdtempSync(join(tmpdir(), 'disc-levels-routes-'));
  const root = join(tmp, 'root');
  cpSync(join(SYNTHETIC, 'disc-levels'), join(root, 'levels'), { recursive: true });
  cpSync(join(SYNTHETIC, 'disc-mpeg2'), join(root, 'mpeg2'), { recursive: true });
  library = new Library([{ name: 'mediaA', dir: root }], join(tmp, 'library.json'), { scanPauseMs: 0, now: () => Date.now() + 3_600_001 });
  await library.scan();
  for (const d of library.list('mediaA')!.discs) ids[d.name] = d.id;
});

afterAll(() => {
  rmSync(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
});

let server: http.Server | null = null;
let base = '';
let clock: ManualClock;
let capacity: Capacity;
let service: LevelService;
let ffmpeg: ReturnType<typeof silentFfmpeg>;
let cacheDir: string;

async function listen(handlers: Handler[]): Promise<void> {
  server = createServer(handlers);
  await new Promise<void>((r) => server!.listen(0, r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api`;
}

function makeService(options: { backend?: EncoderBackend; realClock?: boolean } = {}): LevelService {
  capacity = new Capacity({ h264: 190, hevc: 100 }, options.realClock ? Date.now : clock.now);
  return new LevelService({
    discs: libraryDiscSources(library),
    cache: new SegmentCache(cacheDir, 1 << 30),
    capacity,
    backend: options.backend ?? ffmpeg.backend,
    ...(options.backend ? {} : { spawn: ffmpeg.spawn, clock }),
    // disc-levels' frames are 3750 ticks apart (24 fps), as the real probe finds, though its CLPI says 23.976.
    probe: async () => ({ interlaced: false, softPulldown: false, frameTicks: 3750 }),
  });
}

beforeEach(() => {
  clock = new ManualClock();
  ffmpeg = silentFfmpeg();
  cacheDir = mkdtempSync(join(tmpdir(), 'disc-levels-cache-'));
  service = makeService();
});

afterEach(async () => {
  service.close();
  if (server) await new Promise((r) => server!.close(r));
  server = null;
  await new Promise((r) => setTimeout(r, 20));
  rmSync(cacheDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
});

const withToken = (path: string, token = 't1'): string => `${base}${path}${path.includes('?') ? '&' : '?'}t=${token}`;

async function levelManifest(disc: string, level = 'h264-1080'): Promise<DiscManifest> {
  const res = await fetch(withToken(`/discs/${ids[disc]}/manifest?level=${level}&audio=1`));
  expect(res.status).toBe(200);
  return (await res.json()) as DiscManifest;
}

describe('disc routes at a quality level', () => {
  beforeEach(async () => {
    await listen([discRoutes(library, { service, auth })]);
  });

  it('lists the levels of an MPEG-2 disc: no playable original, and 1080p', async () => {
    const res = await fetch(withToken(`/discs/${ids.mpeg2}/levels?hevc=0&hevc10=0&hdr=0`));
    expect(res.status).toBe(200);
    const { levels } = (await res.json()) as { levels: { level: string; available: boolean; reason?: string }[] };
    expect(levels[0]).toMatchObject({ level: 'original', available: false, reason: 'unplayable' });
    expect(levels.find((l) => l.level === 'h264-1080')).toMatchObject({ available: true });
    expect(levels.find((l) => l.level === 'hevc-1080')).toMatchObject({ available: false, reason: 'no-hevc' });
    const hevc = (await (await fetch(withToken(`/discs/${ids.mpeg2}/levels?hevc=1&hevc10=0&hdr=0`))).json()) as { levels: { level: string; available: boolean }[] };
    expect(hevc.levels.find((l) => l.level === 'hevc-1080')).toMatchObject({ available: true });
  });

  it('prices the levels with the audio stream asked for (audio=, 1 by default); a bad audio number is 404', async () => {
    type Levels = { levels: { level: string; budgetMbps: number }[] };
    const at = async (query: string): Promise<number> =>
      ((await (await fetch(withToken(`/discs/${ids.levels}/levels?hevc=0&hevc10=0&hdr=0${query}`))).json()) as Levels).levels.find((l) => l.level === 'h264-1080')!.budgetMbps;
    expect(await at('&audio=1')).toBe(await at(''));
    expect(await at('&audio=2')).not.toBe(await at(''));
    expect((await fetch(withToken(`/discs/${ids.levels}/levels?audio=x`))).status).toBe(404);
  });

  it('serves a manifest at a level with the rewritten CLPI, and leases for the token’s device', async () => {
    const original = (await (await fetch(withToken(`/discs/${ids.mpeg2}/manifest`))).json()) as DiscManifest;
    const level = await levelManifest('mpeg2');
    const video = (m: DiscManifest): number =>
      parseClpi(new Uint8Array(Buffer.from(m.inline[CLPI]!, 'base64'))).programs[0]!.streams.find((s) => s.codingType === CodingType.MPEG2_VIDEO || s.codingType === CodingType.AVC)!.codingType;
    expect(video(original)).toBe(CodingType.MPEG2_VIDEO);
    expect(video(level)).toBe(CodingType.AVC);
    expect(level.files.find((f) => f.path === M2TS)!.size).not.toBe(original.files.find((f) => f.path === M2TS)!.size);
    expect(capacity.has(viewingIdOf(DEVICE, ids.mpeg2!, 'h264-1080', 1))).toBe(true);
  });

  it('reads a level’s rewritten CLPI through the files route, and HEAD gives its size without a read', async () => {
    const manifest = await levelManifest('levels');
    const clpi = Buffer.from(manifest.inline[CLPI]!, 'base64');
    const res = await fetch(withToken(`/discs/${ids.levels}/files/${CLPI}?level=h264-1080&audio=1`), { headers: { Range: 'bytes=0-' } });
    expect(res.status).toBe(206);
    expect(res.headers.get('content-range')).toBe(`bytes 0-${clpi.length - 1}/${clpi.length}`);
    expect(Buffer.from(await res.arrayBuffer())).toEqual(clpi);
    const head = await fetch(withToken(`/discs/${ids.levels}/files/${M2TS}?level=h264-1080&audio=1`), { method: 'HEAD' });
    const size = manifest.files.find((f) => f.path === M2TS)!.size;
    expect(head.status).toBe(size <= MAX_LEVEL_READ_BYTES ? 200 : 206);
    expect(head.headers.get('content-length')).toBe(String(Math.min(size, MAX_LEVEL_READ_BYTES)));
    expect(ffmpeg.runs).toHaveLength(0);
  });

  it('answers a read still waiting after 15 s with 503 and Retry-After: 1', async () => {
    const manifest = await levelManifest('levels');
    const size = manifest.files.find((f) => f.path === M2TS)!.size;
    const pending = fetch(withToken(`/discs/${ids.levels}/files/${M2TS}?level=h264-1080&audio=1`), { headers: { Range: `bytes=${size - 192}-${size - 1}` } });
    await vi.waitFor(() => expect(ffmpeg.runs.length).toBe(1));
    clock.advance(14_999);
    await new Promise((r) => setTimeout(r, 20));
    clock.advance(1);
    const res = await pending;
    expect(res.status).toBe(503);
    expect(res.headers.get('retry-after')).toBe('1');
    expect(await res.json()).toEqual({ error: 'retry' });
  });

  it('answers a read whose encoder was closed under it (a release) with 503 and Retry-After: 1, never 500', async () => {
    await levelManifest('levels');
    const pending = fetch(withToken(`/discs/${ids.levels}/files/${M2TS}?level=h264-1080&audio=1`), { headers: { Range: 'bytes=0-191' } });
    await vi.waitFor(() => expect(ffmpeg.runs.length).toBe(1));
    const release = await fetch(withToken(`/discs/${ids.levels}/viewing?level=h264-1080&audio=1`), { method: 'DELETE' });
    expect(release.status).toBe(204);
    expect(ffmpeg.runs[0]!.killed).toBe(true);
    expect(capacity.has(viewingIdOf(DEVICE, ids.levels!, 'h264-1080', 1))).toBe(false);
    const res = await pending;
    expect(res.status).toBe(503);
    expect(res.headers.get('retry-after')).toBe('1');
  });

  it('releases only the token’s own viewing', async () => {
    await levelManifest('levels');
    const other = await fetch(withToken(`/discs/${ids.levels}/viewing?level=h264-1080&audio=1`, 't2'), { method: 'DELETE' });
    expect(other.status).toBe(204);
    expect(capacity.has(viewingIdOf(DEVICE, ids.levels!, 'h264-1080', 1))).toBe(true);
    expect((await fetch(withToken(`/discs/${ids.levels}/viewing?level=original&audio=1`), { method: 'DELETE' })).status).toBe(400);
    expect((await fetch(withToken(`/discs/${ids.levels}/viewing?level=h264-1080&audio=x`), { method: 'DELETE' })).status).toBe(400);
  });

  it('refuses a lease when the GPU is full, with the busy copy', async () => {
    for (let i = 0; i < 6; i++) expect(capacity.lease(`other${i}`, 'h264', 24_000 / 1001)).toBe(true);
    const res = await fetch(withToken(`/discs/${ids.levels}/manifest?level=h264-1080&audio=1`));
    expect(res.status).toBe(503);
    expect(res.headers.get('retry-after')).toBeNull();
    expect(await res.json()).toEqual({ error: 'busy', message: 'The NAS is busy re-encoding for others. This will play at original quality.' });
    expect(BUSY_COPY).toBe('The NAS is busy re-encoding for others. This will play at original quality.');
    const mpeg2 = await fetch(withToken(`/discs/${ids.mpeg2}/manifest?level=h264-1080&audio=1`));
    expect(mpeg2.status).toBe(503);
    expect(await mpeg2.json()).toEqual({ error: 'busy', message: 'The NAS is busy. Try again in a few minutes.' });
    expect(BUSY_TRY_LATER_COPY).toBe('The NAS is busy. Try again in a few minutes.');
    // a read by a viewing with no lease is refused the same way
    const read = await fetch(withToken(`/discs/${ids.levels}/files/${M2TS}?level=h264-1080&audio=1`), { headers: { Range: 'bytes=0-191' } });
    expect(read.status).toBe(503);
    expect(await read.json()).toEqual({ error: 'busy', message: BUSY_COPY });
  });

  it('answers 404 for a level the disc isn’t offered at, a bad audio number and an unknown file', async () => {
    expect((await fetch(withToken(`/discs/${ids.levels}/manifest?level=hevc-1080-hdr&audio=1`))).status).toBe(404);
    expect((await fetch(withToken(`/discs/${ids.levels}/manifest?level=h264-1080&audio=0`))).status).toBe(404);
    expect((await fetch(withToken(`/discs/${ids.levels}/manifest?level=nonsense&audio=1`))).status).toBe(404);
    expect((await fetch(withToken(`/discs/${ids.levels}/files/BDMV/STREAM/99999.M2TS?level=h264-1080&audio=1`))).status).toBe(404);
    expect((await fetch(withToken(`/discs/gone/manifest?level=h264-1080&audio=1`))).status).toBe(404);
  });

  it('keeps level=original (or none) as today, byte for byte', async () => {
    const plain = await fetch(withToken(`/discs/${ids.levels}/manifest`));
    const original = await fetch(withToken(`/discs/${ids.levels}/manifest?level=original&audio=2`));
    const empty = await fetch(withToken(`/discs/${ids.levels}/manifest?level=`));
    const text = await plain.text();
    expect(await original.text()).toBe(text);
    expect(await empty.text()).toBe(text);
    const range = { headers: { Range: 'bytes=192-383' } };
    const a = await fetch(withToken(`/discs/${ids.levels}/files/${M2TS}`), range);
    const b = await fetch(withToken(`/discs/${ids.levels}/files/${M2TS}?level=original`), range);
    expect(b.status).toBe(206);
    expect([...b.headers.entries()].filter(([k]) => k !== 'date')).toEqual([...a.headers.entries()].filter(([k]) => k !== 'date'));
    expect(Buffer.from(await b.arrayBuffer())).toEqual(Buffer.from(await a.arrayBuffer()));
    expect(capacity.inUse().viewings).toEqual([]);
  });
});

describe('range reads at a level, against a stub service', () => {
  const SIZE = 10 * MAX_LEVEL_READ_BYTES;
  let size = SIZE;
  const reads: { offset: number; length: number }[] = [];
  let answer: () => Promise<Buffer | { retryAfter: 1 } | { busy: true } | null>;
  const stub: LevelRouteService = {
    manifest: async () => null,
    levels: async () => null,
    release: () => {},
    size: async () => size,
    originalPlayable: async () => true,
    read: async (_d, _l, _a, _p, offset, length) => {
      reads.push({ offset, length });
      const got = await answer();
      return got ?? null;
    },
  };

  beforeEach(async () => {
    size = SIZE;
    reads.length = 0;
    answer = async () => Buffer.alloc(reads.at(-1)!.length, 1);
    await listen([discRoutes(library, { service: stub, auth })]);
  });

  it('clamps a range to 4 MiB, and a read with no Range to the first 4 MiB', async () => {
    expect(MAX_LEVEL_READ_BYTES).toBe(4 * 1024 * 1024);
    const res = await fetch(withToken(`/discs/${ids.levels}/files/${M2TS}?level=h264-1080&audio=1`), { headers: { Range: `bytes=100-${SIZE}` } });
    expect(res.status).toBe(206);
    expect(res.headers.get('content-range')).toBe(`bytes 100-${100 + MAX_LEVEL_READ_BYTES - 1}/${SIZE}`);
    expect((await res.arrayBuffer()).byteLength).toBe(MAX_LEVEL_READ_BYTES);
    const whole = await fetch(withToken(`/discs/${ids.levels}/files/${M2TS}?level=h264-1080&audio=1`));
    expect(whole.status).toBe(206);
    expect(whole.headers.get('content-range')).toBe(`bytes 0-${MAX_LEVEL_READ_BYTES - 1}/${SIZE}`);
    await whole.arrayBuffer();
    const small = await fetch(withToken(`/discs/${ids.levels}/files/${M2TS}?level=h264-1080&audio=1`), { headers: { Range: 'bytes=0-2097151' } });
    expect(small.headers.get('content-length')).toBe('2097152');
    await small.arrayBuffer();
    expect(reads).toEqual([
      { offset: 100, length: MAX_LEVEL_READ_BYTES },
      { offset: 0, length: MAX_LEVEL_READ_BYTES },
      { offset: 0, length: 2_097_152 },
    ]);
  });

  it('reads a Range it doesn’t serve as bytes=0-, and an empty file as 200 with no body', async () => {
    const res = await fetch(withToken(`/discs/${ids.levels}/files/${M2TS}?level=h264-1080&audio=1`), { headers: { Range: 'bytes=500-100' } });
    expect(res.status).toBe(206);
    expect(res.headers.get('content-range')).toBe(`bytes 0-${MAX_LEVEL_READ_BYTES - 1}/${SIZE}`);
    await res.arrayBuffer();
    size = 2000;
    const small = await fetch(withToken(`/discs/${ids.levels}/files/${M2TS}?level=h264-1080&audio=1`), { headers: { Range: 'bytes=0-1,5-6' } });
    expect(small.status).toBe(200);
    expect(small.headers.get('content-range')).toBeNull();
    expect((await small.arrayBuffer()).byteLength).toBe(2000);
    size = 0;
    for (const range of [undefined, 'bytes=0-']) {
      const empty = await fetch(withToken(`/discs/${ids.levels}/files/${M2TS}?level=h264-1080&audio=1`), range ? { headers: { Range: range } } : {});
      expect(empty.status).toBe(200);
      expect(empty.headers.get('content-length')).toBe('0');
      expect(await empty.text()).toBe('');
    }
    expect(reads).toEqual([
      { offset: 0, length: MAX_LEVEL_READ_BYTES },
      { offset: 0, length: 2000 },
    ]);
  });

  it('answers 416 past the end', async () => {
    const res = await fetch(withToken(`/discs/${ids.levels}/files/${M2TS}?level=h264-1080&audio=1`), { headers: { Range: `bytes=${SIZE}-` } });
    expect(res.status).toBe(416);
    expect(res.headers.get('content-range')).toBe(`bytes */${SIZE}`);
    expect(reads).toEqual([]);
  });

  it('maps a RetryLater thrown by the service to 503 Retry-After: 1, and a size that moved to disc-changed', async () => {
    answer = async () => {
      throw new RetryLater('levels: the clip runner was closed');
    };
    const res = await fetch(withToken(`/discs/${ids.levels}/files/${M2TS}?level=h264-1080&audio=1`), { headers: { Range: 'bytes=0-191' } });
    expect(res.status).toBe(503);
    expect(res.headers.get('retry-after')).toBe('1');
    answer = async () => {
      throw new RangeError('levels: bytes lie past the file');
    };
    const moved = await fetch(withToken(`/discs/${ids.levels}/files/${M2TS}?level=h264-1080&audio=1`), { headers: { Range: 'bytes=0-191' } });
    expect(moved.status).toBe(404);
    expect(await moved.json()).toEqual({ error: 'disc-changed' });
  });
});

describe('with LEVELS_BACKEND=off', () => {
  it('answers every level request 404, and me.levels is false (Review Focus 5)', async () => {
    const titles = { service: { gate: () => 'everyone' } as unknown as TitleService, owner: {} as OwnerStore };
    await listen(appHandlers({ auth, library, bdjStore: new BdjStore(tmp), publicBase: 'https://nas.example/', titles }));
    const me = (await (await fetch(withToken('/me'))).json()) as { levels: boolean };
    expect(me.levels).toBe(false);
    expect((await fetch(withToken(`/discs/${ids.levels}/manifest?level=h264-1080&audio=1`))).status).toBe(404);
    expect((await fetch(withToken(`/discs/${ids.levels}/files/${M2TS}?level=h264-1080&audio=1`), { headers: { Range: 'bytes=0-191' } })).status).toBe(404);
    expect((await fetch(withToken(`/discs/${ids.levels}/levels`))).status).toBe(404);
    expect((await fetch(withToken(`/discs/${ids.levels}/viewing?level=h264-1080&audio=1`), { method: 'DELETE' })).status).toBe(404);
    expect((await fetch(withToken(`/discs/${ids.levels}/manifest?level=original`))).status).toBe(200);
  });

  it('says me.levels is true with a level service, and needs the token for level routes', async () => {
    const titles = { service: { gate: () => 'everyone' } as unknown as TitleService, owner: {} as OwnerStore };
    const strict = { verify: (token: string) => (token === 't1' ? { id: DEVICE, owner: true, personId: 'p', personName: 'Owner' } : null) } as unknown as Auth;
    await listen(appHandlers({ auth: strict, library, bdjStore: new BdjStore(tmp), publicBase: 'https://nas.example/', titles, levels: service }));
    expect(((await (await fetch(withToken('/me'))).json()) as { levels: boolean }).levels).toBe(true);
    expect((await fetch(`${base}/discs/${ids.levels}/levels`)).status).toBe(401);
    expect((await fetch(withToken(`/discs/${ids.levels}/levels`))).status).toBe(200);
  });
});

const hasX264 = spawnSync('ffmpeg', ['-hide_banner', '-encoders'], { encoding: 'utf8' }).stdout?.includes('libx264') ?? false;
/** CI installs ffmpeg: there, a missing libx264 fails this test instead of skipping it. */
const runFfmpegTests = hasX264 || Boolean(process.env.CI);

describe.skipIf(!runFfmpegTests)('disc routes with libx264 (LEVELS_BACKEND=x264)', () => {
  it('answers a range read of a level’s .m2ts with 206 and the right length', async () => {
    service.close();
    service = makeService({ backend: x264Backend, realClock: true });
    await listen([discRoutes(library, { service, auth })]);
    const manifest = await levelManifest('levels');
    const size = manifest.files.find((f) => f.path === M2TS)!.size;
    const end = Math.min(size, 2 * 1024 * 1024) - 1;
    let res: Response | null = null;
    for (let tries = 0; tries < 20; tries++) {
      res = await fetch(withToken(`/discs/${ids.levels}/files/${M2TS}?level=h264-1080&audio=1`), { headers: { Range: `bytes=0-${end}` } });
      if (res.status !== 503) break;
      expect(res.headers.get('retry-after')).toBe('1');
      await res.arrayBuffer();
      await new Promise((r) => setTimeout(r, 1000));
    }
    expect(res!.status).toBe(206);
    expect(res!.headers.get('content-range')).toBe(`bytes 0-${end}/${size}`);
    const body = Buffer.from(await res!.arrayBuffer());
    expect(body.length).toBe(end + 1);
    expect(body[4]).toBe(0x47);
  }, 60_000);
});
