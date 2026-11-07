import type { UdfRead } from '@seikou/bdmv/udf';

/*
 * A UDF 2.50 image built in memory: a metadata partition (with its mirror) in a type 1 partition that starts past
 * 4 GiB, extended and plain file entries, short and long allocation descriptors, an allocation extent descriptor
 * chain, an unrecorded extent, an embedded file and an embedded directory.
 */

const BLOCK = 2048;
/** The default partition start block: byte offset ~4.5 GB. */
export const UDF250_PARTITION_START = 2_200_000;
/** Where the metadata file and its mirror start, partition-relative. */
export const UDF250_META = 10;
const MIRROR = 100;
const META_BLOCKS = 16;

/** An image as a sparse map of blocks; reads past the written blocks give zeros, and every read is recorded. */
export class SparseImage {
  readonly blocks = new Map<number, Uint8Array>();
  readonly reads: [number, number][] = [];

  block(lba: number): Uint8Array {
    let b = this.blocks.get(lba);
    if (!b) this.blocks.set(lba, (b = new Uint8Array(BLOCK)));
    return b;
  }

  read: UdfRead = async (offset, length) => {
    this.reads.push([offset, length]);
    const out = new Uint8Array(length);
    for (let at = 0; at < length; ) {
      const pos = offset + at;
      const lba = Math.floor(pos / BLOCK);
      const within = pos - lba * BLOCK;
      const n = Math.min(BLOCK - within, length - at);
      const b = this.blocks.get(lba);
      if (b) out.set(b.subarray(within, within + n), at);
      at += n;
    }
    return out;
  };
}

export const le = (b: Uint8Array, o: number, v: number, bytes: number): void => {
  for (let i = 0; i < bytes; i++) b[o + i] = Math.floor(v / 256 ** i) % 256;
};
const text = (b: Uint8Array, o: number, s: string): void => {
  for (let i = 0; i < s.length; i++) b[o + i] = s.charCodeAt(i);
};
export function tag(b: Uint8Array, id: number, at = 0): void {
  le(b, at, id, 2);
  le(b, at + 2, 3, 2);
  let sum = 0;
  for (let i = 0; i < 16; i++) if (i !== 4) sum += b[at + i]!;
  b[at + 4] = sum % 256;
}
const shortAd = (b: Uint8Array, o: number, length: number, lba: number, type = 0): void => {
  le(b, o, length + type * 0x40000000, 4);
  le(b, o + 4, lba, 4);
};
const longAd = (b: Uint8Array, o: number, length: number, lba: number, partition: number, type = 0): void => {
  shortAd(b, o, length, lba, type);
  le(b, o + 8, partition, 2);
};

/**
 * An (Extended) File Entry: `kind` 0 short ADs, 1 long ADs, 3 embedded, with `lEa` bytes of extended attributes.
 * Returns where its AD area starts.
 */
function fileEntry(b: Uint8Array, opts: { ext: boolean; fileType: number; kind: number; length: number; lAd: number; lEa?: number }): number {
  const lEa = opts.lEa ?? 0;
  le(b, 16 + 4, 4, 2); // strategy 4
  b[16 + 11] = opts.fileType;
  le(b, 16 + 18, opts.kind, 2);
  le(b, 56, opts.length, 8);
  le(b, opts.ext ? 208 : 168, lEa, 4);
  le(b, opts.ext ? 212 : 172, opts.lAd, 4);
  return (opts.ext ? 216 : 176) + lEa;
}

type Fid = [name: string, lba: number, dir: boolean, deleted?: boolean];

/**
 * File identifiers (parent first) of a directory, with `lIu` bytes of implementation use, and names in 16-bit CS0
 * when `cs16`.
 */
function fids(entries: Fid[], opts: { lIu?: number; cs16?: boolean } = {}): Uint8Array {
  const lIu = opts.lIu ?? 0;
  const parts: Uint8Array[] = [];
  for (const [name, lba, dir, deleted] of [['', 0, true] as Fid, ...entries]) {
    const parent = name === '';
    const lFi = parent ? 0 : opts.cs16 ? 2 * name.length + 1 : name.length + 1;
    const fid = new Uint8Array(4 * Math.ceil((38 + lIu + lFi) / 4));
    fid[18] = (dir ? 0x02 : 0) | (deleted ? 0x04 : 0) | (parent ? 0x08 : 0);
    fid[19] = lFi;
    longAd(fid, 20, BLOCK, lba, 1);
    le(fid, 36, lIu, 2);
    fid.fill(0xee, 38, 38 + lIu);
    const at = 38 + lIu;
    if (!parent && opts.cs16) {
      fid[at] = 16;
      for (let i = 0; i < name.length; i++) le(fid, at + 1 + 2 * i, name.charCodeAt(i) * 256 + Math.floor(name.charCodeAt(i) / 256), 2);
    } else if (!parent) {
      fid[at] = 8;
      text(fid, at + 1, name);
    }
    tag(fid, 257);
    parts.push(fid);
  }
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) out.set(p, (at += p.length) - p.length);
  return out;
}

const pattern = (n: number, seed: number): Uint8Array => Uint8Array.from({ length: n }, (_, i) => (i * 7 + seed) % 251);

export function buildUdf250(partitionStart = UDF250_PARTITION_START): { image: SparseImage; m2ts: Uint8Array; clpi: Uint8Array; index: Uint8Array; dataBlocks: number[] } {
  const img = new SparseImage();
  const vrs = ['BEA01', 'NSR03', 'TEA01'];
  vrs.forEach((id, i) => {
    const b = img.block(16 + i);
    b[0] = 0;
    text(b, 1, id);
    b[6] = 1;
  });
  const anchor = img.block(256);
  le(anchor, 16, 16 * BLOCK, 4);
  le(anchor, 20, 32, 4);
  le(anchor, 24, 16 * BLOCK, 4);
  le(anchor, 28, 48, 4);
  tag(anchor, 2);
  tag(img.block(32), 1);
  const pd = img.block(33);
  le(pd, 22, 0, 2);
  le(pd, 188, partitionStart, 4);
  le(pd, 192, 10_000, 4);
  tag(pd, 5);
  const lvd = img.block(34);
  le(lvd, 212, BLOCK, 4);
  text(lvd, 217, '*OSTA UDF Compliant');
  le(lvd, 240, 0x0250, 2);
  longAd(lvd, 248, BLOCK, 0, 1); // FSD at metadata block 0
  le(lvd, 264, 6 + 64, 4);
  le(lvd, 268, 2, 4);
  const maps = 440;
  lvd[maps] = 1;
  lvd[maps + 1] = 6;
  le(lvd, maps + 4, 0, 2);
  const m2 = maps + 6;
  lvd[m2] = 2;
  lvd[m2 + 1] = 64;
  text(lvd, m2 + 5, '*UDF Metadata Partition');
  le(lvd, m2 + 38, 0, 2);
  le(lvd, m2 + 40, 0, 4); // metadata file entry at partition block 0
  le(lvd, m2 + 44, 1, 4); // mirror file entry at partition block 1
  tag(lvd, 6);
  tag(img.block(35), 8);

  // Metadata file and mirror entries (short ADs into the physical partition).
  for (const [lba, type, at] of [
    [0, 250, UDF250_META],
    [1, 251, MIRROR],
  ] as const) {
    const b = img.block(partitionStart + lba);
    const ad = fileEntry(b, { ext: true, fileType: type, kind: 0, length: META_BLOCKS * BLOCK, lAd: 8 });
    shortAd(b, ad, META_BLOCKS * BLOCK, at);
    tag(b, 266);
  }

  // Metadata blocks, written to the metadata file and its mirror.
  const meta = new Map<number, Uint8Array>();
  const mb = (n: number): Uint8Array => {
    let b = meta.get(n);
    if (!b) meta.set(n, (b = new Uint8Array(BLOCK)));
    return b;
  };
  // 0: File Set Descriptor, root at 1.
  longAd(mb(0), 400, BLOCK, 1, 1);
  tag(mb(0), 256);
  // 1: root directory, data at 2 (short AD, so in the metadata partition).
  const rootFids = fids([['BDMV', 3, true]]);
  shortAd(mb(1), fileEntry(mb(1), { ext: true, fileType: 4, kind: 0, length: rootFids.length, lAd: 8 }), rootFids.length, 2);
  tag(mb(1), 266);
  mb(2).set(rootFids);
  // 3: BDMV, an embedded directory.
  const bdmvFids = fids([
    ['index.bdmv', 4, false],
    ['STREAM', 5, true],
    ['CLIPINF', 9, true],
    ['LINK', 14, false], // a symbolic link: not a regular file
  ]);
  mb(3).set(bdmvFids, fileEntry(mb(3), { ext: true, fileType: 4, kind: 3, length: bdmvFids.length, lAd: bdmvFids.length }));
  tag(mb(3), 266);
  // 4: index.bdmv, embedded.
  const index = new TextEncoder().encode('INDX0200 embedded');
  mb(4).set(index, fileEntry(mb(4), { ext: true, fileType: 5, kind: 3, length: index.length, lAd: index.length }));
  tag(mb(4), 266);
  // 5: STREAM, data at 12-13: more than a block of identifiers, most of them deleted, then 00001.m2ts and an entry
  // whose size (2^44) is taken as corrupt.
  const deleted: Fid[] = Array.from({ length: 45 }, (_, i) => [`DEL${String(i).padStart(5, '0')}.M2TS`, 7, false, true]);
  const streamFids = fids([...deleted, ['00001.m2ts', 7, false], ['HUGE.M2TS', 15, false]]);
  if (streamFids.length <= BLOCK) throw new Error('STREAM should span two blocks');
  shortAd(mb(5), fileEntry(mb(5), { ext: true, fileType: 4, kind: 0, length: streamFids.length, lAd: 8 }), streamFids.length, 12);
  tag(mb(5), 266);
  mb(12).set(streamFids.subarray(0, BLOCK));
  mb(13).set(streamFids.subarray(BLOCK));
  // 14: LINK, a symbolic link entry; 15: HUGE.M2TS.
  shortAd(mb(14), fileEntry(mb(14), { ext: true, fileType: 12, kind: 0, length: 10, lAd: 8 }), 10, 4000);
  tag(mb(14), 266);
  shortAd(mb(15), fileEntry(mb(15), { ext: true, fileType: 5, kind: 0, length: 2 ** 44, lAd: 8 }), BLOCK, 4000);
  tag(mb(15), 266);
  // 7: 00001.m2ts (with extended attributes), four extents out of order; the last two through an allocation extent
  // descriptor at 8.
  const extents: [number, number][] = [
    [3 * BLOCK, 2000],
    [2 * BLOCK, 1500],
    [BLOCK, 3000],
    [1000, 2500],
  ];
  const m2tsSize = extents.reduce((n, [len]) => n + len, 0);
  const fe7 = fileEntry(mb(7), { ext: true, fileType: 5, kind: 0, length: m2tsSize, lAd: 24, lEa: 64 });
  shortAd(mb(7), fe7, extents[0]![0], extents[0]![1]);
  shortAd(mb(7), fe7 + 8, extents[1]![0], extents[1]![1]);
  shortAd(mb(7), fe7 + 16, BLOCK, 8, 3);
  tag(mb(7), 266);
  le(mb(8), 20, 16, 4);
  shortAd(mb(8), 24, extents[2]![0], extents[2]![1]);
  shortAd(mb(8), 32, extents[3]![0], extents[3]![1]);
  tag(mb(8), 258);
  // 9: CLIPINF, data at 10, identifiers with implementation use and 16-bit names; 11: 00001.clpi, a plain File
  // Entry with long ADs and an unrecorded extent.
  const clipFids = fids([['00001.clpi', 11, false]], { lIu: 32, cs16: true });
  shortAd(mb(9), fileEntry(mb(9), { ext: true, fileType: 4, kind: 0, length: clipFids.length, lAd: 8 }), clipFids.length, 10);
  tag(mb(9), 266);
  mb(10).set(clipFids);
  const fe11 = fileEntry(mb(11), { ext: false, fileType: 5, kind: 1, length: 2 * BLOCK + 100, lAd: 32 });
  longAd(mb(11), fe11, 2 * BLOCK, 4000, 0);
  longAd(mb(11), fe11 + 16, 100, 0, 0, 1);
  tag(mb(11), 261);

  for (const [n, b] of meta) {
    img.blocks.set(partitionStart + UDF250_META + n, b);
    img.blocks.set(partitionStart + MIRROR + n, b.slice());
  }

  // File data.
  const m2ts = pattern(m2tsSize, 1);
  const dataBlocks: number[] = [];
  let at = 0;
  for (const [len, lba] of extents) {
    for (let i = 0; i * BLOCK < len; i++) {
      img.block(partitionStart + lba + i).set(m2ts.subarray(at + i * BLOCK, at + Math.min(len, (i + 1) * BLOCK)));
      dataBlocks.push(partitionStart + lba + i);
    }
    at += len;
  }
  const clpi = new Uint8Array(2 * BLOCK + 100);
  clpi.set(pattern(2 * BLOCK, 2));
  img.block(partitionStart + 4000).set(clpi.subarray(0, BLOCK));
  img.block(partitionStart + 4001).set(clpi.subarray(BLOCK, 2 * BLOCK));
  dataBlocks.push(partitionStart + 4000, partitionStart + 4001);
  return { image: img, m2ts, clpi, index, dataBlocks };
}

/**
 * Changes metadata block `n` of a `buildUdf250(partitionStart)` image in the main copy and the mirror with `edit`,
 * then recomputes its tag checksum.
 */
export function patchMetadata(image: SparseImage, partitionStart: number, n: number, edit: (b: Uint8Array) => void): void {
  for (const base of [UDF250_META, MIRROR]) {
    const b = image.block(partitionStart + base + n);
    edit(b);
    tag(b, b[0]! + b[1]! * 256);
  }
}
