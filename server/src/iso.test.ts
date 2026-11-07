import { closeSync, ftruncateSync, mkdtempSync, openSync, rmSync, writeSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';
import * as udf from '@seikou/bdmv/udf';
import { buildUdf250, le, patchMetadata } from '../../tests/helpers/udf-image';
import { IsoTrees, isoFileStream } from './iso';

const ISO = join(import.meta.dirname, '../../fixtures/synthetic/disc1.iso');

describe('IsoTrees', () => {
  afterEach(() => vi.restoreAllMocks());

  it('parses each disc once and drops the least recently used past its bound', async () => {
    const parses = vi.spyOn(udf.UdfImage, 'open');
    const trees = new IsoTrees(2);
    expect((await trees.get('a', ISO)).get('BDMV/INDEX.BDMV')).toBeDefined();
    await trees.get('b', ISO);
    await trees.get('a', ISO);
    expect(parses).toHaveBeenCalledTimes(2);
    await trees.get('c', ISO); // evicts b, the least recently used
    await trees.get('a', ISO);
    expect(parses).toHaveBeenCalledTimes(3);
    await trees.get('b', ISO);
    expect(parses).toHaveBeenCalledTimes(4);
  });

  it('does not keep a failed parse', async () => {
    const trees = new IsoTrees(2);
    await expect(trees.get('x', join(import.meta.dirname, 'no-such.iso'))).rejects.toThrow();
    const parses = vi.spyOn(udf.UdfImage, 'open');
    await trees.get('x', ISO);
    expect(parses).toHaveBeenCalledTimes(1);
  });
});

describe('ISO reads past the end of the image', () => {
  const PSTART = 3000;
  const tmp = mkdtempSync(join(tmpdir(), 'iso-'));
  afterAll(() => rmSync(tmp, { recursive: true, force: true }));

  /** Writes the image to a file, cut at `size` bytes if given. */
  function write(name: string, image: ReturnType<typeof buildUdf250>['image'], size?: number): string {
    const path = join(tmp, name);
    const fd = openSync(path, 'w');
    for (const [lba, block] of image.blocks) writeSync(fd, block, 0, block.length, lba * 2048);
    if (size !== undefined) ftruncateSync(fd, size);
    closeSync(fd);
    return path;
  }

  afterEach(() => vi.restoreAllMocks());

  it('clamps requests to the image size before allocating', async () => {
    const { image } = buildUdf250(PSTART);
    patchMetadata(image, PSTART, 5, (b) => le(b, 216, 16 * 1024 * 1024, 4)); // STREAM: 16 MiB, at the cap
    const path = write('clamp.iso', image);
    const size = (PSTART + 4002) * 2048;
    const alloc = vi.spyOn(Buffer, 'alloc');
    const tree = await new IsoTrees().get('clamp', path);
    expect(Math.max(...alloc.mock.calls.map(([n]) => n))).toBeLessThanOrEqual(size);
    expect(tree.has('BDMV/INDEX.BDMV')).toBe(true);
    expect(tree.has('BDMV/STREAM/00001.M2TS')).toBe(false); // its directory reads short, so it is left out
  });

  it('leaves out files whose extents pass the end of the image', async () => {
    const { image } = buildUdf250(PSTART);
    const path = write('cut.iso', image, (PSTART + 4001) * 2048); // 00001.CLPI's second block is cut off
    const tree = await new IsoTrees().get('cut', path);
    expect(tree.has('BDMV/STREAM/00001.M2TS')).toBe(true);
    expect(tree.has('BDMV/CLIPINF/00001.CLPI')).toBe(false);
  });

  it('fails a body that reads short instead of ending it early', async () => {
    const { image } = buildUdf250(PSTART);
    const path = write('short.iso', image, (PSTART + 4001) * 2048);
    const file = { path: 'X', size: 4096, extents: [{ offset: (PSTART + 4000) * 2048, length: 4096 }] };
    const read = async (): Promise<number> => {
      let n = 0;
      for await (const chunk of isoFileStream(path, file, 0, 4095)) n += (chunk as Buffer).length;
      return n;
    };
    await expect(read()).rejects.toThrow('short read');
  });
});
