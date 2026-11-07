import { describe, expect, it } from 'vitest';
import { DiscError } from '@seikou/bdmv/byte-source';
import type { DiscManifest } from '@seikou/nas/nas-api';
import { RemoteSource, type RangeTransport } from './remote-source';

const MiB = 1024 * 1024;
const CHUNK = 2 * MiB;

interface Call {
  readonly path: string;
  readonly offset: number;
  readonly length: number;
  readonly signal: AbortSignal | undefined;
  settled: boolean;
  resolve(): void;
  reject(err: unknown): void;
}

/** Answers from `files`; requests wait until the test resolves them, unless `auto`. */
class FakeTransport implements RangeTransport {
  readonly calls: Call[] = [];
  /** Most requests pending at once. */
  maxPending = 0;
  private pending = 0;

  constructor(
    private readonly files: ReadonlyMap<string, Uint8Array>,
    private readonly auto = false,
  ) {}

  read(path: string, offset: number, length: number, signal?: AbortSignal): Promise<Uint8Array> {
    this.maxPending = Math.max(this.maxPending, ++this.pending);
    return new Promise((resolve, reject) => {
      const call: Call = {
        path,
        offset,
        length,
        signal,
        settled: false,
        resolve: () => {
          if (call.settled) return;
          call.settled = true;
          this.pending--;
          resolve(this.files.get(path)!.slice(offset, offset + length));
        },
        reject: (err) => {
          if (call.settled) return;
          call.settled = true;
          this.pending--;
          reject(err);
        },
      };
      signal?.addEventListener('abort', () => call.reject(signal.reason), { once: true });
      this.calls.push(call);
      if (this.auto) setTimeout(() => call.resolve(), 0);
    });
  }

  setToken(): void {}

  inFlight(): Call[] {
    return this.calls.filter((c) => !c.settled);
  }

  /** Resolves the pending call at `offset`. */
  answer(offset: number): void {
    this.inFlight().find((c) => c.offset === offset)!.resolve();
  }
}

function pattern(size: number): Uint8Array {
  const out = new Uint8Array(size);
  for (let i = 0; i < size; i++) out[i] = (i * 7 + (i >> 16)) % 251;
  return out;
}

/** Byte equality without a deep diff of megabytes. */
function expectBytes(got: Uint8Array, want: Uint8Array): void {
  expect(got.length).toBe(want.length);
  expect(Buffer.from(got.buffer, got.byteOffset, got.length).equals(Buffer.from(want.buffer, want.byteOffset, want.length))).toBe(true);
}
const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

function manifest(files: ReadonlyMap<string, Uint8Array>, inline: Record<string, string> = {}): DiscManifest {
  return { discId: 'd', name: 'Disc', files: [...files].map(([path, b]) => ({ path, size: b.length })), inline };
}

describe('RemoteSource', () => {
  it('answers exists/size/list from the manifest, case-insensitively, and serves inlined files without the transport', async () => {
    const index = new Uint8Array([1, 2, 3, 4, 5]);
    const files = new Map<string, Uint8Array>([
      ['BDMV/INDEX.BDMV', index],
      ['BDMV/PLAYLIST/00000.MPLS', new Uint8Array(1)],
      ['BDMV/PLAYLIST/00001.MPLS', new Uint8Array(2)],
      ['BDMV/PLAYLIST/SUB/IGNORED.MPLS', new Uint8Array(3)],
    ]);
    const transport = new FakeTransport(files);
    const s = new RemoteSource(manifest(files, { 'BDMV/INDEX.BDMV': Buffer.from(index).toString('base64') }), transport, { readAheadBytes: 8 * MiB, chunkBytes: CHUNK, inFlight: 4 });
    expect(s.exists('bdmv/index.bdmv')).toBe(true);
    expect(s.exists('BDMV/MovieObject.bdmv')).toBe(false);
    expect(s.size('BDMV/index.bdmv')).toBe(5);
    expect(s.list('bdmv/playlist')).toEqual(['00000.MPLS', '00001.MPLS']);
    expect(s.list('AACS')).toEqual([]);
    expect(s.paths().sort()).toEqual([...files.keys()].sort());
    expect(Array.from(await s.read('BDMV/index.bdmv', 1, 2))).toEqual([2, 3]);
    expect(Array.from(await s.read('BDMV/INDEX.BDMV', 3, 100))).toEqual([4, 5]);
    expect(transport.calls).toEqual([]);
    expect(() => s.size('BDMV/STREAM/00000.M2TS')).toThrow(DiscError);
    await expect(s.read('BDMV/STREAM/00000.M2TS', 0, 1)).rejects.toMatchObject({ code: 'missing-file' });
  });

  it('reads a listed file the manifest did not inline (past its inline budget) through the transport', async () => {
    const index = new Uint8Array([1, 2, 3]);
    const playlist = pattern(1000);
    const files = new Map<string, Uint8Array>([
      ['BDMV/INDEX.BDMV', index],
      ['BDMV/PLAYLIST/00900.MPLS', playlist],
    ]);
    const transport = new FakeTransport(files, true);
    const s = new RemoteSource(manifest(files, { 'BDMV/INDEX.BDMV': Buffer.from(index).toString('base64') }), transport, { readAheadBytes: 8 * MiB, chunkBytes: CHUNK, inFlight: 4 });
    expect(s.size('BDMV/PLAYLIST/00900.MPLS')).toBe(1000);
    expectBytes(await s.read('BDMV/PLAYLIST/00900.MPLS', 0, 1000), playlist);
    expect(transport.calls.every((c) => c.path === 'BDMV/PLAYLIST/00900.MPLS')).toBe(true);
    expect(transport.calls.length).toBeGreaterThan(0);
  });

  it('reads ahead of sequential reads, at most 4 requests at once and never more than the budget', async () => {
    const clip = pattern(40 * MiB);
    const files = new Map([['BDMV/STREAM/00001.M2TS', clip]]);
    const transport = new FakeTransport(files);
    const budget = 16 * MiB;
    const s = new RemoteSource(manifest(files), transport, { readAheadBytes: budget, chunkBytes: CHUNK, inFlight: 4 });
    const first = s.read('BDMV/STREAM/00001.M2TS', 0, CHUNK);
    expect(transport.inFlight().map((c) => c.offset)).toEqual([0, 2, 4, 6].map((m) => m * MiB));
    transport.answer(0);
    expectBytes(await first, clip.subarray(0, CHUNK));
    await tick();
    // the first read has landed: four chunks in flight ahead of it
    expect(transport.inFlight().map((c) => c.offset)).toEqual([2, 4, 6, 8].map((m) => m * MiB));
    expect(transport.inFlight().every((c) => c.length === CHUNK)).toBe(true);

    // a transport that answers by itself, read through to the end
    const auto = new FakeTransport(files, true);
    const streamed = new RemoteSource(manifest(files), auto, { readAheadBytes: budget, chunkBytes: CHUNK, inFlight: 4 });
    let peak = 0;
    for (let at = 0; at < clip.length; at += CHUNK) {
      expectBytes(await streamed.read('BDMV/STREAM/00001.M2TS', at, CHUNK), clip.subarray(at, at + CHUNK));
      for (let k = 0; k < 4; k++) {
        peak = Math.max(peak, streamed.bufferedBytes);
        expect(streamed.bufferedBytes).toBeLessThanOrEqual(budget);
        await tick();
      }
    }
    expect(peak).toBe(budget); // the read-ahead filled the budget
    expect(auto.maxPending).toBe(4);
    // every chunk was fetched once
    expect(auto.calls.map((c) => c.offset)).toEqual(Array.from({ length: 20 }, (_, i) => i * CHUNK));
  });

  it('assembles reads that straddle chunks and clamps at the end of the file', async () => {
    const clip = pattern(5 * MiB + 100);
    const files = new Map([['A', clip]]);
    const s = new RemoteSource(manifest(files), new FakeTransport(files, true), { readAheadBytes: 8 * MiB, chunkBytes: CHUNK, inFlight: 4 });
    expectBytes(await s.read('A', CHUNK - 10, 20), clip.subarray(CHUNK - 10, CHUNK + 10));
    expectBytes(await s.read('A', 1000, 2_095_104), clip.subarray(1000, 1000 + 2_095_104));
    expectBytes(await s.read('A', 5 * MiB, 1000), clip.subarray(5 * MiB));
    expect((await s.read('A', clip.length, 4)).length).toBe(0);
    await expect(s.read('A', -2, 2)).rejects.toThrow(RangeError);
  });

  it('a read far away (a seek) aborts the outstanding read-ahead and starts it again there', async () => {
    const clip = pattern(40 * MiB);
    const files = new Map([['C', clip]]);
    const transport = new FakeTransport(files);
    const s = new RemoteSource(manifest(files), transport, { readAheadBytes: 16 * MiB, chunkBytes: CHUNK, inFlight: 4 });
    const first = s.read('C', 0, CHUNK);
    transport.answer(0);
    await first;
    await tick();
    const ahead = transport.inFlight();
    expect(ahead.map((c) => c.offset)).toEqual([2, 4, 6, 8].map((m) => m * MiB));
    const far = s.read('C', 30 * MiB, CHUNK);
    expect(ahead.every((c) => c.signal?.aborted)).toBe(true);
    expect(transport.inFlight().map((c) => c.offset)).toEqual([30, 32, 34, 36].map((m) => m * MiB));
    transport.answer(30 * MiB);
    expectBytes(await far, clip.subarray(30 * MiB, 32 * MiB));
    await tick();
    expect(transport.inFlight().map((c) => c.offset)).toEqual([32, 34, 36, 38].map((m) => m * MiB));
  });

  it('rejects a read with its signal reason when aborted, and the chunk it waited for is still read ahead', async () => {
    const clip = pattern(4 * MiB);
    const files = new Map([['C', clip]]);
    const transport = new FakeTransport(files);
    const s = new RemoteSource(manifest(files), transport, { readAheadBytes: 16 * MiB, chunkBytes: CHUNK, inFlight: 4 });
    const controller = new AbortController();
    const reading = s.read('C', 0, 100, controller.signal);
    const reason = new DOMException('stop', 'AbortError');
    controller.abort(reason);
    await expect(reading).rejects.toBe(reason);
    transport.answer(0);
    await tick();
    expectBytes(await s.read('C', 0, 100), clip.subarray(0, 100));
    expect(transport.calls.filter((c) => c.offset === 0)).toHaveLength(1);
  });

  it('reports a failed chunk to the read and fetches it again on the next one', async () => {
    const clip = pattern(MiB);
    const files = new Map([['C', clip]]);
    const transport = new FakeTransport(files);
    const s = new RemoteSource(manifest(files), transport, { readAheadBytes: 16 * MiB, chunkBytes: CHUNK, inFlight: 4 });
    const failing = s.read('C', 0, 10);
    const err = new DiscError('read-failed', 'Connection to the NAS lost.');
    transport.calls[0]!.reject(err);
    await expect(failing).rejects.toBe(err);
    const again = s.read('C', 0, 10);
    transport.answer(0);
    expectBytes(await again, clip.subarray(0, 10));
  });

  it('counts the landed bytes after the last read, up to the first chunk still missing, and says when read-ahead stops', async () => {
    const clip = pattern(10 * MiB + 100);
    const files = new Map([['C', clip], ['D', pattern(MiB)]]);
    const transport = new FakeTransport(files);
    const s = new RemoteSource(manifest(files), transport, { readAheadBytes: 8 * MiB, chunkBytes: CHUNK, inFlight: 2 });
    expect(s.bufferedAhead('C')).toEqual({ bytes: 0, toEnd: false });
    const first = s.read('C', 0, 100);
    expect(s.readingAhead).toBe(true);
    transport.answer(0);
    await first;
    await tick();
    expect(s.bufferedAhead('C')).toEqual({ bytes: 0, toEnd: false }); // the chunk read is the reader's, not ahead of it
    transport.answer(4 * MiB); // lands out of order: not contiguous yet
    await tick();
    expect(s.bufferedAhead('C')).toEqual({ bytes: 0, toEnd: false });
    transport.answer(2 * MiB);
    await tick();
    expect(s.bufferedAhead('C')).toEqual({ bytes: 2 * CHUNK, toEnd: false });
    expect(s.bufferedAhead('c').bytes).toBe(2 * CHUNK); // paths are case-insensitive
    expect(s.bufferedAhead('D')).toEqual({ bytes: 0, toEnd: false }); // not the file being read
    // The budget (8 MiB) holds chunks 1 to 4 once chunk 0 is dropped; read-ahead stops when they have landed.
    transport.answer(6 * MiB);
    await tick();
    expect(s.readingAhead).toBe(true);
    transport.answer(8 * MiB);
    await tick();
    expect(transport.inFlight()).toHaveLength(0);
    expect(s.readingAhead).toBe(false);
    expect(s.bufferedAhead('C')).toEqual({ bytes: 4 * CHUNK, toEnd: false });
  });

  it('says when the bytes ahead run to the end of the file', async () => {
    const clip = pattern(5 * MiB);
    const files = new Map([['C', clip]]);
    const transport = new FakeTransport(files, true);
    const s = new RemoteSource(manifest(files), transport, { readAheadBytes: 16 * MiB, chunkBytes: CHUNK, inFlight: 4 });
    await s.read('C', 0, 100);
    await tick();
    await tick();
    expect(s.bufferedAhead('C')).toEqual({ bytes: 3 * MiB, toEnd: true });
    expect(s.readingAhead).toBe(false);
  });
});
