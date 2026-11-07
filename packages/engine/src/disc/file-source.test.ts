import { describe, expect, it } from 'vitest';
import { DiscError } from '@seikou/bdmv/byte-source';
import { FileSource } from './file-source';

function source(): FileSource {
  return new FileSource(
    new Map<string, Blob>([
      ['BDMV/INDEX.BDMV', new Blob([new Uint8Array([1, 2, 3, 4, 5])])],
      ['BDMV/PLAYLIST/00000.MPLS', new Blob(['a'])],
      ['BDMV/PLAYLIST/00001.MPLS', new Blob(['b'])],
      ['BDMV/PLAYLIST/SUB/IGNORED.MPLS', new Blob(['c'])],
    ]),
  );
}

describe('FileSource', () => {
  it('answers exists/size/list case-insensitively', () => {
    const s = source();
    expect(s.exists('bdmv/index.bdmv')).toBe(true);
    expect(s.exists('BDMV/MovieObject.bdmv')).toBe(false);
    expect(s.size('BDMV/INDEX.BDMV')).toBe(5);
    expect(s.list('BDMV/PLAYLIST')).toEqual(['00000.MPLS', '00001.MPLS']);
    expect(s.list('AACS')).toEqual([]);
  });

  it('reports its normalised paths', () => {
    expect(source().paths().sort()).toEqual(['BDMV/INDEX.BDMV', 'BDMV/PLAYLIST/00000.MPLS', 'BDMV/PLAYLIST/00001.MPLS', 'BDMV/PLAYLIST/SUB/IGNORED.MPLS']);
  });

  it('reads byte ranges and clamps at end of file', async () => {
    const s = source();
    expect(Array.from(await s.read('BDMV/INDEX.BDMV', 1, 2))).toEqual([2, 3]);
    expect(Array.from(await s.read('BDMV/INDEX.BDMV', 3, 100))).toEqual([4, 5]);
    expect((await s.read('BDMV/INDEX.BDMV', 9, 4)).length).toBe(0);
  });

  it('throws missing-file for unknown paths', async () => {
    await expect(source().read('BDMV/STREAM/00000.M2TS', 0, 1)).rejects.toMatchObject({ code: 'missing-file' });
    expect(() => source().size('BDMV/STREAM/00000.M2TS')).toThrow(DiscError);
  });

  it('maps NotReadableError to source-changed and other failures to read-failed', async () => {
    const failing = (err: unknown): Blob =>
      ({ size: 10, slice: () => ({ arrayBuffer: () => Promise.reject(err) }) }) as unknown as Blob;
    const changed = new FileSource(new Map([['A', failing(new DOMException('gone', 'NotReadableError'))]]));
    await expect(changed.read('A', 0, 4)).rejects.toMatchObject({ code: 'source-changed' });
    const broken = new FileSource(new Map([['A', failing(new Error('boom'))]]));
    await expect(broken.read('A', 0, 4)).rejects.toMatchObject({ code: 'read-failed' });
  });

  it('rejects negative offsets instead of reading from the end of the file', async () => {
    await expect(source().read('BDMV/INDEX.BDMV', -2, 2)).rejects.toThrow(RangeError);
  });

  it('reads the same bytes through a stream when given a signal', async () => {
    const bytes = new Uint8Array(300_000).map((_, i) => i % 251);
    const s = new FileSource(new Map([['A', new Blob([bytes])]]));
    const got = await s.read('A', 1000, 200_000, new AbortController().signal);
    expect(got).toEqual(bytes.subarray(1000, 201_000));
  });

  it('stops pulling from the stream and rejects with the reason when aborted', async () => {
    let pulls = 0;
    const stream = new ReadableStream<Uint8Array>(
      {
        pull: async (c) => {
          pulls++;
          await new Promise((r) => setTimeout(r, 1)); // a disk that takes time per chunk
          c.enqueue(new Uint8Array(10));
        },
      },
      { highWaterMark: 0 },
    );
    const blob = { size: 1000, slice: () => ({ stream: () => stream }) } as unknown as Blob;
    const s = new FileSource(new Map([['A', blob]]));
    const controller = new AbortController();
    const reading = s.read('A', 0, 1000, controller.signal);
    await new Promise((r) => setTimeout(r, 5));
    const reason = new DOMException('stop', 'AbortError');
    controller.abort(reason);
    await expect(reading).rejects.toBe(reason);
    const after = pulls;
    await new Promise((r) => setTimeout(r, 10));
    expect(pulls).toBe(after);
    expect(after).toBeLessThan(100);
  });

  it('rejects at once for an already-aborted signal', async () => {
    const controller = new AbortController();
    controller.abort(new DOMException('stop', 'AbortError'));
    await expect(source().read('BDMV/INDEX.BDMV', 0, 2, controller.signal)).rejects.toMatchObject({ name: 'AbortError' });
  });
});
