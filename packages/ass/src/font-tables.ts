/*
 * Reads what font matching and layout need from TrueType/OpenType files (TTF, OTF, TTC collections, WOFF):
 * names, weight and style as libass derives them, GDI metrics, decoration metrics and the cmap. FreeType's part in
 * libass is replaced by reading the sfnt tables directly.
 *
 * Ported from libass 0.17.5 (ass_fontselect.c): get_font_info; (ass_font.c): ass_face_get_weight,
 * fsSelection_to_style_flags, ass_face_get_style_flags, set_font_metrics, ass_face_is_postscript, ass_charmap_magic.
 * libass is ISC-licensed; see src/engine/NOTICE. Modified for bluray-web, 2026.
 *
 * SPDX-License-Identifier: LGPL-2.1-or-later AND ISC
 */

import { ligatureClusters, readLigatureLookups, scriptTag } from './gsub';

export interface FaceInfo {
  readonly file: string;
  /** Face index inside a collection (0 otherwise). */
  readonly index: number;
  /** Microsoft-platform name ID 1 records, in table order, all languages. */
  readonly families: readonly string[];
  /** Microsoft-platform name ID 4 records. */
  readonly fullNames: readonly string[];
  readonly postscriptName: string | null;
  readonly weight: number;
  readonly italic: boolean;
  readonly bold: boolean;
  /** CFF outlines (libass's ass_face_is_postscript). */
  readonly isPostscript: boolean;
  readonly unitsPerEm: number;
  /**
   * A TrueType face whose head flags force an integer ppem (bit 3): FreeType's TrueType driver rounds the pixel
   * size of hinted loads, so the shaper's advances use the rounded em; unhinted outlines and the size metrics don't.
   */
  readonly integerPpem: boolean;
  /** set_font_metrics's GDI ascender and descender, font units, descender negative. */
  readonly ascender: number;
  readonly descender: number;
  readonly underlinePosition: number;
  readonly underlineThickness: number;
  readonly strikeoutPosition: number;
  readonly strikeoutSize: number;
  hasGlyph(codepoint: number): boolean;
  /** The cmap's glyph id, 0 when missing. */
  glyphId(codepoint: number): number;
  /** Per character of a run, the index of the character whose ligature cluster it joins (GSUB liga/clig/rlig). */
  clusters(codepoints: readonly number[]): number[];
}

export interface FontFile { readonly name: string; readonly bytes: Uint8Array; readonly faces: readonly FaceInfo[] }

export class FontFileError extends Error {}

type Tables = Map<string, Uint8Array>;
interface Decoded { readonly flavor: number; readonly collection: boolean; readonly faces: readonly Tables[] }
const decoded = new WeakMap<FontFile, Decoded>();

const tag = (b: Uint8Array, at: number): string => String.fromCharCode(b[at]!, b[at + 1]!, b[at + 2]!, b[at + 3]!);
const view = (b: Uint8Array): DataView => new DataView(b.buffer, b.byteOffset, b.byteLength);

function need(cond: boolean, what: string): asserts cond {
  if (!cond) throw new FontFileError(what);
}

function readDirectory(bytes: Uint8Array, at: number): Tables {
  const v = view(bytes);
  need(at + 12 <= bytes.length, 'truncated table directory');
  const n = v.getUint16(at + 4);
  need(at + 12 + 16 * n <= bytes.length, 'truncated table directory');
  const tables: Tables = new Map();
  for (let i = 0; i < n; i++) {
    const e = at + 12 + 16 * i;
    const off = v.getUint32(e + 8);
    const len = v.getUint32(e + 12);
    need(off + len <= bytes.length, 'table outside the file');
    tables.set(tag(bytes, e), bytes.subarray(off, off + len));
  }
  return tables;
}

async function inflate(data: Uint8Array): Promise<Uint8Array> {
  const stream = new Blob([data as BlobPart]).stream().pipeThrough(new DecompressionStream('deflate'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

async function readWoff(bytes: Uint8Array): Promise<Tables> {
  const v = view(bytes);
  need(bytes.length >= 44, 'truncated WOFF header');
  const n = v.getUint16(12);
  need(44 + 20 * n <= bytes.length, 'truncated WOFF directory');
  const tables: Tables = new Map();
  for (let i = 0; i < n; i++) {
    const e = 44 + 20 * i;
    const off = v.getUint32(e + 4);
    const compLength = v.getUint32(e + 8);
    const origLength = v.getUint32(e + 12);
    need(off + compLength <= bytes.length, 'WOFF table outside the file');
    const data = bytes.subarray(off, off + compLength);
    let table: Uint8Array;
    try {
      table = compLength < origLength ? await inflate(data) : data;
    } catch {
      throw new FontFileError('bad WOFF table data');
    }
    need(table.length === origLength, 'bad WOFF table length');
    tables.set(tag(bytes, e), table);
  }
  return tables;
}

async function decode(bytes: Uint8Array): Promise<Decoded> {
  need(bytes.length >= 12, 'too short to be a font');
  const v = view(bytes);
  const magic = tag(bytes, 0);
  if (magic === 'ttcf') {
    const n = v.getUint32(8);
    need(n > 0 && 12 + 4 * n <= bytes.length, 'truncated collection header');
    const faces = Array.from({ length: n }, (_, i) => readDirectory(bytes, v.getUint32(12 + 4 * i)));
    return { flavor: v.getUint32(v.getUint32(12)), collection: true, faces };
  }
  if (magic === 'wOFF') return { flavor: v.getUint32(4), collection: false, faces: [await readWoff(bytes)] };
  const flavor = v.getUint32(0);
  need(flavor === 0x00010000 || magic === 'OTTO' || magic === 'true', 'not a TrueType or OpenType font');
  return { flavor, collection: false, faces: [readDirectory(bytes, 0)] };
}

interface NameRecord { readonly platform: number; readonly encoding: number; readonly language: number; readonly id: number; readonly text: string }

function utf16be(b: Uint8Array): string {
  let s = '';
  for (let i = 0; i + 1 < b.length; i += 2) s += String.fromCharCode((b[i]! << 8) | b[i + 1]!);
  return s;
}

function readNames(t: Uint8Array): NameRecord[] {
  const v = view(t);
  need(t.length >= 6, 'bad name table');
  const count = v.getUint16(2);
  const strings = v.getUint16(4);
  const out: NameRecord[] = [];
  for (let i = 0; i < count && 6 + 12 * i + 12 <= t.length; i++) {
    const e = 6 + 12 * i;
    const [platform, encoding, language, id, len, off] = [0, 2, 4, 6, 8, 10].map((k) => v.getUint16(e + k)) as [number, number, number, number, number, number];
    const data = t.subarray(strings + off, strings + off + len);
    if (data.length !== len) continue;
    const text = platform === 3 || platform === 0 ? utf16be(data) : String.fromCharCode(...data);
    out.push({ platform, encoding, language, id, text });
  }
  return out;
}

/** A cmap lookup to glyph ids: the subtable libass's ass_charmap_magic selects (formats 4, 12 and 0 understood). */
function readCmap(t: Uint8Array | undefined): (cp: number) => number {
  if (!t || t.length < 4) return () => 0;
  const v = view(t);
  const n = v.getUint16(2);
  const records = Array.from({ length: n }, (_, i) => ({ platform: v.getUint16(4 + 8 * i), encoding: v.getUint16(6 + 8 * i), offset: v.getUint32(8 + 8 * i) }))
    .filter((r) => r.offset + 4 <= t.length);
  const ms = records.filter((r) => r.platform === 3);
  const pick = ms.find((r) => r.encoding === 10) ?? ms.find((r) => r.encoding === 1) ?? ms[0]
    ?? records.find((r) => r.platform === 0 && (r.encoding === 4 || r.encoding === 6)) ?? records.find((r) => r.platform === 0) ?? records[0];
  if (!pick) return () => 0;
  const lookup = subtable(t, pick.offset);
  if (pick.platform === 3 && pick.encoding === 0) return (cp) => lookup(cp) || lookup(0xf000 | cp); // symbol fonts
  return lookup;
}

function subtable(t: Uint8Array, at: number): (cp: number) => number {
  const v = view(t);
  const format = v.getUint16(at);
  if (format === 4) {
    const segX2 = v.getUint16(at + 6);
    const ends = at + 14;
    const starts = ends + segX2 + 2;
    const deltas = starts + segX2;
    const rangeOffsets = deltas + segX2;
    if (rangeOffsets + segX2 > t.length) return () => 0;
    return (cp) => {
      if (cp > 0xffff) return 0;
      for (let s = 0; s < segX2; s += 2) {
        if (cp > v.getUint16(ends + s)) continue;
        const start = v.getUint16(starts + s);
        if (cp < start) return 0;
        const ro = v.getUint16(rangeOffsets + s);
        if (ro === 0) return (cp + v.getInt16(deltas + s)) & 0xffff;
        const g = rangeOffsets + s + ro + 2 * (cp - start);
        if (g + 2 > t.length) return 0;
        const glyph = v.getUint16(g);
        return glyph === 0 ? 0 : (glyph + v.getInt16(deltas + s)) & 0xffff;
      }
      return 0;
    };
  }
  if (format === 12) {
    const groups = v.getUint32(at + 12);
    if (at + 16 + 12 * groups > t.length) return () => 0;
    return (cp) => {
      let lo = 0;
      let hi = groups - 1;
      while (lo <= hi) {
        const mid = (lo + hi) >> 1;
        const g = at + 16 + 12 * mid;
        if (cp < v.getUint32(g)) hi = mid - 1;
        else if (cp > v.getUint32(g + 4)) lo = mid + 1;
        else return v.getUint32(g + 8) + (cp - v.getUint32(g));
      }
      return 0;
    };
  }
  if (format === 0) return (cp) => (cp < 256 && at + 6 + cp < t.length ? t[at + 6 + cp]! : 0);
  return () => 0;
}

/** ass_face_get_weight */
function weightOf(usWeightClass: number, bold: boolean): number {
  const table: Record<number, number> = { 1: 100, 2: 200, 3: 300, 4: 350, 5: 400, 6: 600, 7: 700, 8: 800, 9: 900 };
  if (usWeightClass === 0) return 300 * (bold ? 1 : 0) + 400;
  return table[usWeightClass] ?? usWeightClass;
}

function faceInfo(file: string, index: number, tables: Tables): FaceInfo {
  const head = tables.get('head');
  const nameTable = tables.get('name');
  need(head !== undefined && head.length >= 54, 'no head table');
  need(nameTable !== undefined, 'no name table');
  const hv = view(head);
  const unitsPerEm = hv.getUint16(18);
  need(unitsPerEm > 0, 'bad unitsPerEm');
  const macStyle = hv.getUint16(44);
  const os2 = tables.get('OS/2');
  const ov = os2 && os2.length >= 78 ? view(os2) : null;
  const hhea = tables.get('hhea');
  const post = tables.get('post');

  const names = readNames(nameTable);
  const msNames = (id: number): string[] => names.filter((n) => n.platform === 3 && n.id === id).map((n) => n.text);
  let families = msNames(1);
  if (families.length === 0) families = names.filter((n) => n.id === 1).map((n) => n.text).slice(0, 1);
  need(families.length > 0, 'font has no family name');
  const ps = names.find((n) => n.platform === 3 && (n.encoding === 1 || n.encoding === 0) && n.language === 0x409 && n.id === 6)
    ?? names.find((n) => n.platform === 3 && n.id === 6) ?? names.find((n) => n.platform === 1 && n.encoding === 0 && n.id === 6);

  // ass_face_get_style_flags: fsSelection when there is an OS/2 table, else FreeType's flags (head.macStyle)
  const fsSelection = os2 && os2.length >= 64 ? view(os2).getUint16(62) : null;
  const italic = fsSelection !== null ? (fsSelection & 1) !== 0 : (macStyle & 2) !== 0;
  const bold = fsSelection !== null ? (fsSelection & (1 << 5)) !== 0 : (macStyle & 1) !== 0;
  const usWeightClass = os2 && os2.length >= 6 ? view(os2).getUint16(4) : 0;

  // set_font_metrics: GDI's Win metrics, else FreeType's (hhea), else typo, else the bbox
  let ascender = 0;
  let descender = 0;
  if (ov && ov.getInt16(74) + ov.getInt16(76) !== 0) {
    ascender = ov.getInt16(74);
    descender = -ov.getInt16(76);
  } else if (hhea && hhea.length >= 8) {
    ascender = view(hhea).getInt16(4);
    descender = view(hhea).getInt16(6);
  }
  if (ascender - descender === 0) {
    if (ov && ov.getInt16(68) - ov.getInt16(70) !== 0) {
      ascender = ov.getInt16(68);
      descender = ov.getInt16(70);
    } else {
      ascender = hv.getInt16(42);
      descender = hv.getInt16(38);
    }
  }

  const glyphId = readCmap(tables.get('cmap'));
  const gsub = tables.get('GSUB');
  const ligatureLookups = new Map<string, ReturnType<typeof readLigatureLookups>>();
  return {
    file, index, families, fullNames: msNames(4), postscriptName: ps?.text ?? null,
    weight: weightOf(usWeightClass, bold), italic, bold,
    isPostscript: tables.has('CFF ') || tables.has('CFF2'),
    unitsPerEm, integerPpem: tables.has('glyf') && (hv.getUint16(16) & 8) !== 0, ascender, descender,
    underlinePosition: post && post.length >= 12 ? view(post).getInt16(8) : 0,
    underlineThickness: post && post.length >= 12 ? view(post).getInt16(10) : 0,
    strikeoutSize: os2 && os2.length >= 30 ? view(os2).getInt16(26) : 0,
    strikeoutPosition: os2 && os2.length >= 30 ? view(os2).getInt16(28) : 0,
    hasGlyph: (cp) => glyphId(cp) !== 0,
    glyphId,
    clusters(cps) {
      if (cps.length < 2) return cps.map((_, i) => i);
      const script = scriptTag(cps);
      let lookups = ligatureLookups.get(script);
      if (!lookups) {
        lookups = readLigatureLookups(gsub, script);
        ligatureLookups.set(script, lookups);
      }
      return lookups.length ? ligatureClusters(cps.map(glyphId), lookups) : cps.map((_, i) => i);
    },
  };
}

/** Throws FontFileError for anything unreadable. */
export async function readFontFile(name: string, bytes: Uint8Array): Promise<FontFile> {
  let d: Decoded;
  let faces: FaceInfo[];
  try {
    d = await decode(bytes);
    faces = d.faces.map((t, i) => faceInfo(name, i, t));
  } catch (e) {
    if (e instanceof FontFileError) throw e;
    throw new FontFileError(e instanceof Error ? e.message : String(e)); // a DataView read past a table's end
  }
  const file: FontFile = { name, bytes, faces };
  decoded.set(file, d);
  return file;
}

function checksum(data: Uint8Array): number {
  let sum = 0;
  for (let i = 0; i < data.length; i += 4) sum = (sum + (((data[i] ?? 0) << 24) | ((data[i + 1] ?? 0) << 16) | ((data[i + 2] ?? 0) << 8) | (data[i + 3] ?? 0))) >>> 0;
  return sum;
}

/** One face as a standalone font for FontFace (which reads only the first face of a collection); a single-face file as is. */
export function extractFace(file: FontFile, index: number): Uint8Array {
  const d = decoded.get(file);
  if (!d) throw new Error('not a FontFile from readFontFile');
  if (!d.collection) return file.bytes;
  const tables = [...d.faces[index]!.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  const n = tables.length;
  let at = 12 + 16 * n;
  const offsets = tables.map(([, data]) => { const o = at; at += (data.length + 3) & ~3; return o; });
  const out = new Uint8Array(at);
  const v = view(out);
  v.setUint32(0, d.flavor);
  v.setUint16(4, n);
  const p = 2 ** Math.floor(Math.log2(n));
  v.setUint16(6, p * 16);
  v.setUint16(8, Math.log2(p));
  v.setUint16(10, n * 16 - p * 16);
  tables.forEach(([t, data], i) => {
    const e = 12 + 16 * i;
    for (let k = 0; k < 4; k++) out[e + k] = t.charCodeAt(k);
    v.setUint32(e + 4, checksum(data));
    v.setUint32(e + 8, offsets[i]!);
    v.setUint32(e + 12, data.length);
    out.set(data, offsets[i]!);
  });
  return out;
}
