import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';
import { UdfError, UdfImage, readUdf, udfPieces } from './udf';
import type { UdfFile, UdfRead } from './udf';
import { UDF250_META as META, UDF250_PARTITION_START as PSTART, buildUdf250, le, patchMetadata, tag } from '../../../tests/helpers/udf-image';

const FIXTURES = join(import.meta.dirname, '../../../fixtures/synthetic');
const BLOCK = 2048;

function walk(dir: string, base = dir): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(join(dir, e.name), base) : [relative(base, join(dir, e.name))]));
}

const bufferRead =
  (image: Uint8Array): UdfRead =>
  async (offset, length) =>
    image.subarray(offset, offset + length);

/** The bytes of `file` read through its extents (zeros for offset -1). */
async function readThrough(read: UdfRead, file: UdfFile, start = 0, end = file.size): Promise<Uint8Array> {
  const out = new Uint8Array(end - start);
  let at = 0;
  for (const piece of udfPieces(file, start, end)) {
    if (piece.offset >= 0) out.set(await read(piece.offset, piece.length), at);
    at += piece.length;
  }
  return out;
}

describe('readUdf over disc1.iso (UDF 1.02, type 1 partition)', () => {
  const iso = readFileSync(join(FIXTURES, 'disc1.iso'));
  const disc1 = join(FIXTURES, 'disc1');

  it('lists every file of disc1 with its size', async () => {
    const files = await readUdf(bufferRead(iso));
    const expected = walk(disc1)
      .map((p) => ({ path: p.toUpperCase(), size: statSync(join(disc1, p)).size }))
      .sort((a, b) => (a.path < b.path ? -1 : 1));
    expect(files.map(({ path, size }) => ({ path, size }))).toEqual(expected);
  });

  it('reads every file byte for byte through its extents', async () => {
    const files = await readUdf(bufferRead(iso));
    for (const p of walk(disc1)) {
      const file = files.find((f) => f.path === p.toUpperCase())!;
      expect(Buffer.from(await readThrough(bufferRead(iso), file)).equals(readFileSync(join(disc1, p))), p).toBe(true);
    }
  });

  it('finds BDMV/INDEX.BDMV in any case', async () => {
    const image = await UdfImage.open(bufferRead(iso));
    expect((await image.find('bdmv/index.bdmv'))?.size).toBe(statSync(join(disc1, 'BDMV/index.bdmv')).size);
    expect(await image.find('BDMV/NOPE.BDMV')).toBeNull();
    expect(await image.find('BDMV')).toBeNull();
  });

  it('rejects a file that is not a UDF image', async () => {
    const clip = readFileSync(join(disc1, 'BDMV/STREAM/00001.m2ts')).subarray(0, 1024 * 1024);
    await expect(readUdf(bufferRead(clip))).rejects.toThrow('not a UDF image');
    await expect(readUdf(bufferRead(new Uint8Array(0)))).rejects.toThrow('not a UDF image');
  });
});

describe('readUdf over a UDF 2.50 image with a metadata partition', () => {
  it('lists the files with sizes and extents past 4 GiB', async () => {
    const { image, m2ts, clpi, index } = buildUdf250();
    const files = await readUdf(image.read);
    expect(files.map(({ path, size }) => ({ path, size }))).toEqual([
      { path: 'BDMV/CLIPINF/00001.CLPI', size: clpi.length },
      { path: 'BDMV/INDEX.BDMV', size: index.length },
      { path: 'BDMV/STREAM/00001.M2TS', size: m2ts.length },
    ]);
    const stream = files[2]!;
    expect(stream.extents).toEqual([
      { offset: (PSTART + 2000) * BLOCK, length: 3 * BLOCK },
      { offset: (PSTART + 1500) * BLOCK, length: 2 * BLOCK },
      { offset: (PSTART + 3000) * BLOCK, length: BLOCK },
      { offset: (PSTART + 2500) * BLOCK, length: 1000 },
    ]);
    expect(stream.extents[0]!.offset).toBeGreaterThan(2 ** 32);
    expect(files[0]!.extents).toEqual([
      { offset: (PSTART + 4000) * BLOCK, length: 2 * BLOCK },
      { offset: -1, length: 100 },
    ]);
  });

  it('reads files through extents, embedded data and zero runs, and ranges across extents', async () => {
    const { image, m2ts, clpi, index } = buildUdf250();
    const files = await readUdf(image.read);
    const byPath = new Map(files.map((f) => [f.path, f]));
    expect(await readThrough(image.read, byPath.get('BDMV/STREAM/00001.M2TS')!)).toEqual(m2ts);
    expect(await readThrough(image.read, byPath.get('BDMV/CLIPINF/00001.CLPI')!)).toEqual(clpi);
    expect(await readThrough(image.read, byPath.get('BDMV/INDEX.BDMV')!)).toEqual(index);
    // A range spanning the first three extents.
    const start = 3 * BLOCK - 10;
    const end = 5 * BLOCK + 20;
    expect(await readThrough(image.read, byPath.get('BDMV/STREAM/00001.M2TS')!, start, end)).toEqual(m2ts.subarray(start, end));
  });

  it('reads no file data while listing', async () => {
    const { image, dataBlocks } = buildUdf250();
    await readUdf(image.read);
    const touched = new Set<number>();
    for (const [offset, length] of image.reads) for (let b = Math.floor(offset / BLOCK); b * BLOCK < offset + length; b++) touched.add(b);
    expect(dataBlocks.filter((b) => touched.has(b))).toEqual([]);
  });

  it('falls back to the metadata mirror', async () => {
    const { image, m2ts } = buildUdf250();
    image.blocks.get(PSTART + META + 7)![4]! ^= 0xff; // breaks the tag of 00001.m2ts's entry in the main copy
    const file = await (await UdfImage.open(image.read)).find('BDMV/STREAM/00001.M2TS');
    expect(file?.size).toBe(m2ts.length);
    image.blocks.delete(PSTART + 0); // no metadata file entry: everything comes from the mirror
    expect((await readUdf(image.read)).map((f) => f.path)).toHaveLength(3);
  });

  it('reads identifiers with implementation use and 16-bit names, extended attributes and a directory over a block', async () => {
    const { image, m2ts, clpi } = buildUdf250();
    const udf = await UdfImage.open(image.read);
    // CLIPINF: L_IU 32 and 16-bit CS0 names; 00001.m2ts: L_EA 64, last in a STREAM directory of two blocks.
    expect((await udf.find('BDMV/CLIPINF/00001.CLPI'))?.size).toBe(clpi.length);
    expect((await udf.find('BDMV/STREAM/00001.M2TS'))?.size).toBe(m2ts.length);
  });

  it('leaves out deleted identifiers, entries that are not byte streams and sizes over 2^43', async () => {
    const { image } = buildUdf250();
    const udf = await UdfImage.open(image.read);
    const paths = (await udf.files()).map((f) => f.path);
    expect(paths.some((p) => p.includes('DEL'))).toBe(false);
    expect(await udf.find('BDMV/LINK')).toBeNull();
    expect(await udf.find('BDMV/STREAM/HUGE.M2TS')).toBeNull();
    expect(await udf.find('BDMV/STREAM/DEL00000.M2TS')).toBeNull();
  });
});

describe('readUdf over corrupt images', () => {
  /** Rejects quickly with a UdfError, never asking for more than 64 KiB at once. */
  async function rejectsQuickly(image: ReturnType<typeof buildUdf250>['image'], message: string): Promise<void> {
    const started = Date.now();
    const err = await readUdf(image.read).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(UdfError);
    expect((err as Error).message).toBe(message);
    expect(Math.max(...image.reads.map(([, length]) => length))).toBeLessThanOrEqual(64 * 1024);
    expect(Date.now() - started).toBeLessThan(1000);
  }

  it('refuses a directory over 16 MiB', async () => {
    const { image } = buildUdf250();
    patchMetadata(image, PSTART, 5, (b) => le(b, 216, 0x3fff0000, 4)); // STREAM's extent length
    await rejectsQuickly(image, 'UDF: directory too large');
  });

  it('refuses an allocation extent over one block', async () => {
    const { image } = buildUdf250();
    patchMetadata(image, PSTART, 7, (b) => le(b, 216 + 64 + 16, 3 * 0x40000000 + 0x100000, 4)); // the AED pointer
    await rejectsQuickly(image, 'UDF: allocation extent longer than a block');
  });

  it('reads at most 256 blocks of a volume descriptor sequence extent', async () => {
    const { image } = buildUdf250();
    const anchor = image.block(256);
    for (const at of [16, 24]) {
      le(anchor, at, 0xfffff800, 4); // 2^21 blocks
      le(anchor, at + 4, 1000, 4); // where there is nothing
    }
    tag(anchor, 2);
    await rejectsQuickly(image, 'not a UDF image');
    expect(image.reads.length).toBeLessThanOrEqual(240 + 1 + 2 * 256);
  });
});
