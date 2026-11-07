/*
 * Ported from libudfread src/udfread.c and src/ecma167.c
 * Copyright (C) 2014-2015 VLC authors and VideoLAN
 * Authors: Petri Hintukainen <phintuka@users.sourceforge.net>
 *
 * Ported to TypeScript and modified for bluray-web, 2026.
 *
 * SPDX-License-Identifier: LGPL-2.1-or-later
 */

/*
 * A read-only UDF reader for Blu-ray images: the volume structure, the partitions (type 1 and the UDF 2.50/2.60
 * metadata partition), file entries and directories (see NOTICE). It lists files with their extents as byte offsets
 * in the image, and reads nothing but descriptors, directories and file entries. Byte offsets are plain Numbers,
 * exact far beyond 4 GiB; no bitwise operator ever touches one.
 */

/** A piece of a file in the image. `offset` is -1 for a piece that reads as zeros (unrecorded or unallocated). */
export interface UdfExtent {
  readonly offset: number;
  readonly length: number;
}

export interface UdfFile {
  /** Upper-case and '/'-separated: 'BDMV/STREAM/00001.M2TS'. */
  readonly path: string;
  readonly size: number;
  /** Cover the file in order; their lengths add up to `size`. */
  readonly extents: readonly UdfExtent[];
}

/** Reads `length` bytes at `offset` of the image; a short result means the image ends there. */
export type UdfRead = (offset: number, length: number) => Promise<Uint8Array>;

/** A malformed or unsupported image (as opposed to an error of `read`, which propagates as it is). */
export class UdfError extends Error {}

const BLOCK = 2048;
const NOT_UDF = 'not a UDF image';

/*
 * ecma167.c
 */

const u8 = (p: Uint8Array, o: number): number => p[o] ?? 0;
const u16 = (p: Uint8Array, o: number): number => u8(p, o) + u8(p, o + 1) * 0x100;
const u32 = (p: Uint8Array, o: number): number => u16(p, o) + u16(p, o + 2) * 0x10000;
const u64 = (p: Uint8Array, o: number): number => u32(p, o) + u32(p, o + 4) * 0x100000000;

const TAG_PVD = 1;
const TAG_AVDP = 2;
const TAG_VDP = 3;
const TAG_PD = 5;
const TAG_LVD = 6;
const TAG_TD = 8;
const TAG_FSD = 256;
const TAG_FID = 257;
const TAG_AED = 258;
const TAG_FE = 261;
const TAG_EFE = 266;
const TAG_INVALID = -1;

const AD_NORMAL = 0;
const AD_EXTENT_AD = 3;

const CHAR_DIR = 0x02;
const CHAR_DELETED = 0x04;
const CHAR_PARENT = 0x08;

const FT_DIR = 4;
const FT_BYTESTREAM = 5;
const FT_METADATA = 250;
const FT_METADATA_MIRROR = 251;

/** Descriptor Tag (ECMA 167, 3/7.2): its identifier, or TAG_INVALID when the checksum fails. */
function decodeDescriptorTag(buf: Uint8Array, at = 0): number {
  if (buf.length < at + 16) return TAG_INVALID;
  let checksum = 0;
  for (let i = 0; i < 16; i++) if (i !== 4) checksum = (checksum + u8(buf, at + i)) % 256;
  return checksum === u8(buf, at + 4) ? u16(buf, at) : TAG_INVALID;
}

interface ExtentAd {
  lba: number;
  length: number;
}

/** Extent Descriptor (ECMA 167, 3/7.1). */
const decodeExtentAd = (p: Uint8Array, o: number): ExtentAd => ({ length: u32(p, o), lba: u32(p, o + 4) });

interface LongAd {
  lba: number;
  length: number;
  partition: number;
  extentType: number;
}

/** Allocation descriptor length field: 30 bits of length, 2 of extent type. */
const adLength = (v: number): number => v % 0x40000000;
const adType = (v: number): number => Math.floor(v / 0x40000000);

/** Short Allocation Descriptor (ECMA 167, 4/14.14.1). */
function decodeShortAd(p: Uint8Array, o: number, partition: number): LongAd {
  const v = u32(p, o);
  return { extentType: adType(v), length: adLength(v), lba: u32(p, o + 4), partition };
}

/** Long Allocation Descriptor (ECMA 167, 4/14.14.2). */
function decodeLongAd(p: Uint8Array, o: number): LongAd {
  const v = u32(p, o);
  return { extentType: adType(v), length: adLength(v), lba: u32(p, o + 4), partition: u16(p, o + 8) };
}

/** Extended Allocation Descriptor (ECMA 167, 4/14.14.3). */
function decodeExtendedAd(p: Uint8Array, o: number): LongAd {
  const v = u32(p, o);
  return { extentType: adType(v), length: adLength(v), lba: u32(p, o + 12), partition: u16(p, o + 16) };
}

const AD_SIZES = [8, 16, 20] as const;

function decodeAds(p: Uint8Array, o: number, adKind: number, partition: number, count: number): LongAd[] {
  const out: LongAd[] = [];
  for (let i = 0; i < count; i++) {
    const at = o + i * AD_SIZES[adKind]!;
    out.push(adKind === 0 ? decodeShortAd(p, at, partition) : adKind === 1 ? decodeLongAd(p, at) : decodeExtendedAd(p, at));
  }
  return out;
}

interface PartitionDescriptor {
  number: number;
  startBlock: number;
  numBlocks: number;
}

/** Partition Descriptor (ECMA 167, 3/10.5). */
const decodePartition = (p: Uint8Array): PartitionDescriptor => ({ number: u16(p, 22), startBlock: u32(p, 188), numBlocks: u32(p, 192) });

interface LogicalVolumeDescriptor {
  blockSize: number;
  domainId: Uint8Array;
  domainSuffix: Uint8Array;
  contentsUse: Uint8Array;
  numPartitionMaps: number;
  partitionMapTable: Uint8Array;
}

/** Logical Volume Descriptor (ECMA 167, 3/10.6); the map table is cut at the end of the block. */
function decodeLogicalVolume(p: Uint8Array): LogicalVolumeDescriptor {
  const mapLength = Math.min(u32(p, 264), BLOCK - 440);
  return {
    blockSize: u32(p, 212),
    domainId: p.subarray(217, 240),
    domainSuffix: p.subarray(240, 248),
    contentsUse: p.subarray(248, 264),
    numPartitionMaps: u32(p, 268),
    partitionMapTable: p.subarray(440, 440 + mapLength),
  };
}

interface FileIdentifier {
  icb: LongAd;
  characteristic: number;
  filename: Uint8Array;
}

/** File Identifier Descriptor (ECMA 167, 4/14.4): the identifier and the bytes it uses (padded to 4), or null. */
function decodeFileIdentifier(p: Uint8Array, o: number, size: number): { fid: FileIdentifier; used: number } | null {
  if (size < 38) return null;
  const filenameLen = u8(p, o + 19);
  const lIu = u16(p, o + 36);
  if (size < 38 + lIu + filenameLen) return null;
  return {
    fid: { characteristic: u8(p, o + 18), icb: decodeLongAd(p, o + 20), filename: p.subarray(o + 38 + lIu, o + 38 + lIu + filenameLen) },
    used: 4 * Math.floor((38 + filenameLen + lIu + 3) / 4),
  };
}

interface FileEntry {
  length: number;
  fileType: number;
  adKind: number;
  /** Embedded data: where it sits in the image, its recorded length and its bytes. */
  inline: { offset: number; content: Uint8Array } | null;
  ads: LongAd[];
}

/** File Entry (ECMA 167, 4/14.9) and Extended File Entry (4/14.17): `pAd` is where the descriptors start. */
function decodeFileEntryAt(p: Uint8Array, partition: number, lAd: number, pAd: number, absOffset: number): FileEntry | null {
  if (pAd + lAd > BLOCK) return null;
  // ICB Tag (ECMA 167, 4/14.6). UDF records strategy 4 only.
  if (u16(p, 16 + 4) !== 4) return null;
  const flags = u16(p, 16 + 18) % 8;
  if (flags > 3) return null;
  const fe: FileEntry = { fileType: u8(p, 16 + 11), length: u64(p, 56), adKind: flags, inline: null, ads: [] };
  if (flags === 3) fe.inline = { offset: absOffset + pAd, content: p.slice(pAd, pAd + lAd) };
  else fe.ads = decodeAds(p, pAd, flags, partition, Math.floor(lAd / AD_SIZES[flags]!));
  return fe;
}

function decodeFileEntry(p: Uint8Array, tag: number, partition: number, absOffset: number): FileEntry | null {
  if (tag === TAG_FE) return decodeFileEntryAt(p, partition, u32(p, 172), 176 + u32(p, 168), absOffset);
  if (tag === TAG_EFE) return decodeFileEntryAt(p, partition, u32(p, 212), 216 + u32(p, 208), absOffset);
  return null;
}

/** Allocation Extent Descriptor (ECMA 167, 4/14.5): appends its descriptors to `fe`. */
function decodeAllocationExtent(fe: FileEntry, p: Uint8Array, size: number, partition: number): boolean {
  const lAd = u32(p, 20);
  if (size < 24 || size - 24 < lAd || fe.adKind > 2) return false;
  fe.ads.push(...decodeAds(p, 24, fe.adKind, partition, Math.floor(lAd / AD_SIZES[fe.adKind]!)));
  return true;
}

/*
 * udfread.c
 */

/** CS0 (UDF 2.1.1): 8 is Latin-1, 16 is UTF-16BE. Null for any other encoding. */
function cs0ToString(cs0: Uint8Array): string | null {
  if (cs0.length < 1) return '';
  let out = '';
  if (cs0[0] === 8) {
    for (let i = 1; i < cs0.length; i++) out += String.fromCharCode(cs0[i]!);
  } else if (cs0[0] === 16) {
    for (let i = 1; i < cs0.length - 1; i += 2) out += String.fromCharCode(cs0[i]! * 0x100 + cs0[i + 1]!);
  } else {
    return null;
  }
  return out;
}

const ascii = (s: string): Uint8Array => Uint8Array.from(s, (c) => c.charCodeAt(0));
const LVD_DOMAIN_ID = ascii('*OSTA UDF Compliant');
const META_DOMAIN_ID = ascii('*UDF Metadata Partition');

const startsWith = (bytes: Uint8Array, prefix: Uint8Array): boolean => prefix.every((b, i) => bytes[i] === b);

interface Partition {
  number: number;
  lba: number;
  mirrorLba: number;
}

interface DirEntry {
  name: string;
  icb: LongAd;
  characteristic: number;
}

const MAX_VDP_HOPS = 64;
const MAX_ALLOCATION_EXTENTS = 4096;
const MAX_DEPTH = 32;
/** Bounds on lengths read from the image, checked before anything is allocated or read. */
const MAX_DIR_BYTES = 16 * 1024 * 1024;
const MAX_VDS_BLOCKS = 256;
/** Files above 8 TiB are taken as corrupt entries. */
const MAX_FILE_BYTES = 2 ** 43;

class Volume {
  constructor(
    private readonly input: UdfRead,
    readonly part: Partition[],
  ) {}

  /** `count` blocks from absolute `lba`, or null when the image is shorter. */
  static async readBlocks(input: UdfRead, lba: number, count: number): Promise<Uint8Array | null> {
    if (count < 1) return null;
    const buf = await input(lba * BLOCK, count * BLOCK);
    return buf.length >= count * BLOCK ? buf : null;
  }

  private partitionIndex(number: number): number {
    if (number === this.part[0]!.number) return 0;
    if (this.part.length > 1 && number === this.part[1]!.number) return 1;
    return -1;
  }

  /** _read_metadata_blocks: the blocks of `loc`, from the mirror when the first one has no valid tag. */
  async readMetadata(loc: LongAd): Promise<{ tag: number; data: Uint8Array; lba: number } | null> {
    const count = Math.ceil(loc.length / BLOCK);
    const idx = this.partitionIndex(loc.partition);
    if (count < 1 || idx < 0) return null;
    const p = this.part[idx]!;
    for (const base of p.mirrorLba ? [p.lba, p.mirrorLba] : [p.lba]) {
      const data = await Volume.readBlocks(this.input, base + loc.lba, count);
      if (!data) continue;
      const tag = decodeDescriptorTag(data);
      if (tag !== TAG_INVALID) return { tag, data, lba: base + loc.lba };
    }
    return null;
  }

  /** _read_file_entry, following allocation extent descriptors. */
  async readFileEntry(icb: LongAd): Promise<FileEntry | null> {
    const read = await this.readMetadata({ ...icb, length: Math.min(icb.length, BLOCK) });
    if (!read) return null;
    const fe = decodeFileEntry(read.data, read.tag, icb.partition, read.lba * BLOCK);
    if (!fe || fe.inline) return fe;
    for (let n = 0; n < MAX_ALLOCATION_EXTENTS && fe.ads.at(-1)?.extentType === AD_EXTENT_AD; n++) {
      const next = fe.ads.pop()!;
      // An allocation extent is at most one block (UDF 2.60, 2.3.11).
      if (next.length > BLOCK) throw new UdfError('UDF: allocation extent longer than a block');
      const aed = await this.readMetadata(next);
      if (!aed || aed.tag !== TAG_AED || !decodeAllocationExtent(fe, aed.data, next.length, next.partition)) break;
    }
    return fe;
  }

  /** _read_dir: the entries of the directory whose file entry is at `icb`. */
  async readDir(icb: LongAd): Promise<DirEntry[] | null> {
    const fe = await this.readFileEntry(icb);
    if (!fe || fe.fileType !== FT_DIR) return null;
    if (fe.inline) return parseDir(fe.inline.content, fe.inline.content.length);
    // Like libudfread, a directory is read from its first extent only.
    const loc = fe.ads[0];
    if (!loc) return null;
    if (loc.length > MAX_DIR_BYTES) throw new UdfError('UDF: directory too large');
    const data = await this.readMetadata(loc);
    return data ? parseDir(data.data, loc.length) : null;
  }

  /** The extents of a file entry in the image (_file_lba): data always lives in the type 1 partition. */
  extents(fe: FileEntry): UdfExtent[] {
    const out: UdfExtent[] = [];
    let remaining = fe.length;
    if (fe.inline) {
      const recorded = Math.min(remaining, fe.inline.content.length);
      if (recorded > 0) out.push({ offset: fe.inline.offset, length: recorded });
      remaining -= recorded;
    } else {
      for (const ad of fe.ads) {
        if (remaining <= 0) break;
        const length = Math.min(Math.ceil(ad.length / BLOCK) * BLOCK, remaining);
        if (length === 0) continue;
        const mapped = ad.extentType === AD_NORMAL && ad.lba !== 0;
        out.push({ offset: mapped ? (this.part[0]!.lba + ad.lba) * BLOCK : -1, length });
        remaining -= length;
      }
    }
    // Past the descriptors the file reads as zeros, as in udfread_read_blocks.
    if (remaining > 0) out.push({ offset: -1, length: remaining });
    return out;
  }
}

/** _parse_dir: the file identifiers of a directory, without the parent entry and unnamed entries. */
function parseDir(data: Uint8Array, length: number): DirEntry[] | null {
  const end = Math.min(length, data.length);
  const out: DirEntry[] = [];
  let p = 0;
  while (p < end - 16) {
    if (decodeDescriptorTag(data, p) !== TAG_FID) return null;
    const decoded = decodeFileIdentifier(data, p, end - p);
    if (!decoded) break; // Not enough data: keep the entries read so far.
    p += decoded.used;
    const { fid } = decoded;
    if (fid.characteristic & (CHAR_PARENT | CHAR_DELETED) || fid.filename.length < 1) continue;
    const name = cs0ToString(fid.filename);
    if (!name) continue;
    out.push({ name, icb: fid.icb, characteristic: fid.characteristic });
  }
  return out;
}

/** _probe_volume: Volume Recognition (ECMA 167 2/8, UDF 2.60 2.1.7). */
async function probeVolume(input: UdfRead): Promise<boolean> {
  const id = (s: string): Uint8Array => Uint8Array.from([0, ...ascii(s), 1]);
  const bea = id('BEA01');
  const nsr02 = id('NSR02');
  const nsr03 = id('NSR03');
  const tea = id('TEA01');
  const nul = new Uint8Array(7);
  let beaSeen = false;
  for (let lba = 16; lba < 256; lba++) {
    const buf = await Volume.readBlocks(input, lba, 1);
    if (!buf) continue;
    if (startsWith(buf, tea)) return false;
    if (startsWith(buf, nul)) break;
    if (startsWith(buf, bea)) beaSeen = true;
    if (beaSeen && (startsWith(buf, nsr02) || startsWith(buf, nsr03))) return true;
  }
  return false;
}

/** _search_vds: the partition descriptor numbered 0 and the logical volume descriptor of one sequence. */
async function searchVds(input: UdfRead, first: ExtentAd): Promise<{ pd: PartitionDescriptor; lvd: LogicalVolumeDescriptor } | null> {
  let pd: PartitionDescriptor | null = null;
  let lvd: LogicalVolumeDescriptor | null = null;
  let pvd = false;
  let loc = first;
  for (let hops = 0; hops < MAX_VDP_HOPS; hops++) {
    let next: ExtentAd | null = null;
    const end = loc.lba + Math.min(Math.floor(loc.length / BLOCK), MAX_VDS_BLOCKS);
    for (let lba = loc.lba; lba < end; lba++) {
      const buf = await Volume.readBlocks(input, lba, 1);
      const tag = buf ? decodeDescriptorTag(buf) : TAG_INVALID;
      if (tag === TAG_VDP) {
        next = decodeExtentAd(buf!, 20);
        break;
      }
      if (tag === TAG_PVD) pvd = true;
      else if (tag === TAG_LVD) lvd = decodeLogicalVolume(buf!);
      else if (tag === TAG_PD && !pd) {
        const decoded = decodePartition(buf!);
        if (decoded.number === 0) pd = decoded;
      } else if (tag === TAG_TD) return pd && lvd ? { pd, lvd } : null;
      if (pd && lvd && pvd) return { pd, lvd };
    }
    if (!next) break;
    loc = next;
  }
  return pd && lvd ? { pd, lvd } : null;
}

/** _map_metadata_partition: where the metadata file and its mirror start. */
async function mapMetadataPartition(input: UdfRead, lba: number, mirrorLba: number, pd: PartitionDescriptor): Promise<{ lba: number; mirrorLba: number } | null> {
  let main = 0;
  let mirror = 0;
  for (const at of [lba, mirrorLba]) {
    const buf = await Volume.readBlocks(input, pd.startBlock + at, 1);
    if (!buf || decodeDescriptorTag(buf) !== TAG_EFE) continue;
    const fe = decodeFileEntry(buf, TAG_EFE, pd.number, 0);
    if (!fe || fe.inline || fe.ads.length === 0) continue;
    if (fe.fileType === FT_METADATA) main = pd.startBlock + fe.ads[0]!.lba;
    else if (fe.fileType === FT_METADATA_MIRROR) mirror = pd.startBlock + fe.ads[0]!.lba;
  }
  if (!main && mirror) return { lba: mirror, mirrorLba: 0 };
  return main ? { lba: main, mirrorLba: mirror } : null;
}

/** _parse_udf_partition_maps: the type 1 partition and the metadata partition, if any. */
async function parsePartitionMaps(input: UdfRead, pd: PartitionDescriptor, lvd: LogicalVolumeDescriptor): Promise<Partition[] | null> {
  const table = lvd.partitionMapTable;
  const part: Partition[] = [];
  let type1 = false;
  let metadata: Partition | null = null;
  let map = 0;
  for (let i = 0; i < lvd.numPartitionMaps && map + 2 < table.length; i++) {
    const type = u8(table, map);
    const len = u8(table, map + 1);
    if (len < 2 || map + len > table.length) break;
    if (type === 1) {
      if (len !== 6) break;
      if (!type1 && u16(table, map + 4) === pd.number) {
        part[0] = { number: i, lba: pd.startBlock, mirrorLba: 0 };
        type1 = true;
      }
    } else if (type === 2) {
      if (len !== 64) break;
      // Metadata Partition (UDF 2.60 2.2.10); other type 2 maps are not supported.
      if (startsWith(table.subarray(map + 5, map + 28), META_DOMAIN_ID)) {
        const mapped = await mapMetadataPartition(input, u32(table, map + 40), u32(table, map + 44), pd);
        if (mapped) metadata = { number: i, ...mapped };
      }
    }
    map += len;
  }
  if (!type1) return null;
  if (metadata) part[1] = metadata;
  return part;
}

/** udfread_open_input up to the root directory. */
async function openVolume(input: UdfRead): Promise<{ volume: Volume; root: DirEntry[] }> {
  if (!(await probeVolume(input))) throw new UdfError(NOT_UDF);
  // The Anchor Volume Descriptor Pointer at block 256 (UDF 2.60, 2.2.3).
  const anchor = await Volume.readBlocks(input, 256, 1);
  if (!anchor || decodeDescriptorTag(anchor) !== TAG_AVDP) throw new UdfError(NOT_UDF);
  const vds = (await searchVds(input, decodeExtentAd(anchor, 16))) ?? (await searchVds(input, decodeExtentAd(anchor, 24)));
  if (!vds) throw new UdfError(NOT_UDF);
  const { pd, lvd } = vds;
  if (lvd.blockSize !== BLOCK || !startsWith(lvd.domainId, LVD_DOMAIN_ID)) throw new UdfError(NOT_UDF);
  const fsdLoc = decodeLongAd(lvd.contentsUse, 0);

  const part = await parsePartitionMaps(input, pd, lvd);
  if (!part) throw new UdfError('UDF: no type 1 partition');
  const volume = new Volume(input, part);

  // _read_root_dir: the File Set Descriptor in the area fsdLoc describes.
  let fsd: Uint8Array | null = null;
  const last = fsdLoc.lba + Math.floor((Math.max(fsdLoc.length, 1) - 1) / BLOCK);
  for (let lba = fsdLoc.lba; lba <= last; lba++) {
    const read = await volume.readMetadata({ ...fsdLoc, lba, length: BLOCK });
    if (read?.tag === TAG_FSD) fsd = read.data;
    if (read?.tag === TAG_FSD || read?.tag === TAG_TD) break;
  }
  if (!fsd) throw new UdfError('UDF: no file set descriptor');
  const root = await volume.readDir(decodeLongAd(fsd, 400));
  if (!root) throw new UdfError('UDF: unreadable root directory');
  return { volume, root };
}

const isDir = (e: DirEntry): boolean => (e.characteristic & CHAR_DIR) !== 0;

/** An opened image: its root directory read, everything else on demand. */
export class UdfImage {
  private constructor(
    private readonly volume: Volume,
    private readonly root: DirEntry[],
  ) {}

  static async open(read: UdfRead): Promise<UdfImage> {
    const { volume, root } = await openVolume(read);
    return new UdfImage(volume, root);
  }

  /** The regular file at `path` (any case, '/'-separated), reading only the directories on the way; null if absent. */
  async find(path: string): Promise<UdfFile | null> {
    const segments = path.toUpperCase().split('/').filter((s) => s !== '');
    let dir: DirEntry[] | null = this.root;
    for (const [i, segment] of segments.entries()) {
      const entry: DirEntry | undefined = dir?.find((e) => e.name.toUpperCase() === segment);
      if (!entry) return null;
      if (i === segments.length - 1) return isDir(entry) ? null : this.file(segments.join('/'), entry);
      if (!isDir(entry)) return null;
      dir = await this.volume.readDir(entry.icb);
    }
    return null;
  }

  /**
   * Every regular file, sorted by path; on a case clash the first name wins, and unreadable entries (and other file
   * types) are left out. Rejects with a UdfError when a directory or allocation extent is malformed.
   */
  async files(): Promise<UdfFile[]> {
    const out = new Map<string, UdfFile>();
    const seen = new Set<string>();
    const walk = async (entries: DirEntry[], prefix: string, depth: number): Promise<void> => {
      for (const entry of entries) {
        const path = `${prefix}${entry.name.toUpperCase()}`;
        if (isDir(entry)) {
          const key = `${entry.icb.partition}:${entry.icb.lba}`;
          if (depth >= MAX_DEPTH || seen.has(key)) continue;
          seen.add(key);
          const sub = await this.volume.readDir(entry.icb);
          if (sub) await walk(sub, `${path}/`, depth + 1);
        } else if (!out.has(path)) {
          const file = await this.file(path, entry);
          if (file) out.set(path, file);
        }
      }
    };
    await walk(this.root, '', 0);
    return [...out.values()].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  }

  /** A regular file (a byte stream, UDF 2.60 2.3.5.2) of a sane size, or null. */
  private async file(path: string, entry: DirEntry): Promise<UdfFile | null> {
    const fe = await this.volume.readFileEntry(entry.icb);
    if (!fe || fe.fileType !== FT_BYTESTREAM || fe.length > MAX_FILE_BYTES) return null;
    return { path, size: fe.length, extents: this.volume.extents(fe) };
  }
}

/** Every regular file of the UDF image `read` reads. Rejects with `not a UDF image` when it isn't one. */
export async function readUdf(read: UdfRead): Promise<UdfFile[]> {
  return (await UdfImage.open(read)).files();
}

/** The pieces of the image (or zero runs, offset -1) holding bytes `[start, end)` of `file`. */
export function udfPieces(file: UdfFile, start: number, end: number): UdfExtent[] {
  const out: UdfExtent[] = [];
  let pos = 0;
  for (const extent of file.extents) {
    const from = Math.max(start, pos);
    const to = Math.min(end, pos + extent.length);
    if (from < to) out.push({ offset: extent.offset < 0 ? -1 : extent.offset + (from - pos), length: to - from });
    pos += extent.length;
    if (pos >= end) break;
  }
  return out;
}
