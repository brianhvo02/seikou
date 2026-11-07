import { readFileSync } from 'node:fs';
import { deflateSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { extractFace, FontFileError, readFontFile } from './font-tables';

const file = (f: string): Uint8Array => new Uint8Array(readFileSync(`fixtures/ass/fonts/${f}`));
const load = (f: string) => readFontFile(f, file(f));

interface Table { tag: string; data: Uint8Array }
function tablesOf(sfnt: Uint8Array): Table[] {
  const v = new DataView(sfnt.buffer, sfnt.byteOffset, sfnt.byteLength);
  const n = v.getUint16(4);
  return Array.from({ length: n }, (_, i) => {
    const at = 12 + 16 * i;
    const tag = String.fromCharCode(...sfnt.subarray(at, at + 4));
    const off = v.getUint32(at + 8);
    return { tag, data: sfnt.slice(off, off + v.getUint32(at + 12)) };
  });
}
const pad4 = (n: number): number => (n + 3) & ~3;

/** A 'ttcf' collection holding each font's tables (not shared), table offsets relative to the file start. */
function buildTtc(fonts: Uint8Array[]): Uint8Array {
  const sets = fonts.map(tablesOf);
  const headerSize = 12 + 4 * fonts.length;
  const dirSizes = sets.map((t) => 12 + 16 * t.length);
  let at = headerSize + dirSizes.reduce((a, b) => a + b, 0);
  const layout = sets.map((t) => t.map((tb) => { const off = at; at += pad4(tb.data.length); return off; }));
  const out = new Uint8Array(at);
  const v = new DataView(out.buffer);
  out.set([0x74, 0x74, 0x63, 0x66]);
  v.setUint32(4, 0x00010000);
  v.setUint32(8, fonts.length);
  let dir = headerSize;
  sets.forEach((t, f) => {
    v.setUint32(12 + 4 * f, dir);
    v.setUint32(dir, 0x00010000);
    v.setUint16(dir + 4, t.length);
    t.forEach((tb, i) => {
      const e = dir + 12 + 16 * i;
      out.set([...tb.tag].map((c) => c.charCodeAt(0)), e);
      v.setUint32(e + 8, layout[f]![i]!);
      v.setUint32(e + 12, tb.data.length);
      out.set(tb.data, layout[f]![i]!);
    });
    dir += dirSizes[f]!;
  });
  return out;
}

/** A WOFF 1.0 with every table zlib-compressed. */
function buildWoff(sfnt: Uint8Array): Uint8Array {
  const tables = tablesOf(sfnt).map((t) => { const z = new Uint8Array(deflateSync(t.data)); return { ...t, z: z.length < t.data.length ? z : t.data }; });
  let at = 44 + 20 * tables.length;
  const offs = tables.map((t) => { const o = at; at += pad4(t.z.length); return o; });
  const out = new Uint8Array(at);
  const v = new DataView(out.buffer);
  out.set([0x77, 0x4f, 0x46, 0x46]);
  v.setUint32(4, 0x00010000);
  v.setUint32(8, at);
  v.setUint16(12, tables.length);
  tables.forEach((t, i) => {
    const e = 44 + 20 * i;
    out.set([...t.tag].map((c) => c.charCodeAt(0)), e);
    v.setUint32(e + 4, offs[i]!);
    v.setUint32(e + 8, t.z.length);
    v.setUint32(e + 12, t.data.length);
    out.set(t.z, offs[i]!);
  });
  return out;
}

describe('readFontFile', () => {
  it('reads names, weight, style and GDI metrics from a TTF', async () => {
    const [face] = (await load('DejaVuSans-Bold.ttf')).faces;
    expect(face!.families).toEqual(['DejaVu Sans']);
    expect(face!.fullNames).toEqual(['DejaVu Sans Bold']);
    expect(face!.postscriptName).toBe('DejaVuSans-Bold');
    expect([face!.weight, face!.bold, face!.italic, face!.isPostscript]).toEqual([700, true, false, false]);
    expect(face!.unitsPerEm).toBe(2048);
    expect(face!.ascender).toBeGreaterThan(0);
    expect(face!.descender).toBeLessThan(0);
    expect(face!.underlineThickness).toBeGreaterThan(0);
  });

  it('reads italic from fsSelection', async () => {
    const [face] = (await load('DejaVuSans-Oblique.ttf')).faces;
    expect([face!.weight, face!.bold, face!.italic]).toEqual([400, false, true]);
  });

  it('answers cmap lookups', async () => {
    const [face] = (await load('DejaVuSans.ttf')).faces;
    expect(face!.hasGlyph(0x41)).toBe(true);
    expect(face!.hasGlyph(0x10ffff)).toBe(false);
    expect(face!.hasGlyph(0x3042)).toBe(false); // あ
  });

  it('reads every face of a collection, and extracts one as a standalone font', async () => {
    const ttc = buildTtc([file('DejaVuSans.ttf'), file('DejaVuSerif.ttf')]);
    const fonts = await readFontFile('pair.ttc', ttc);
    expect(fonts.faces.map((f) => [f.index, f.families[0]])).toEqual([[0, 'DejaVu Sans'], [1, 'DejaVu Serif']]);
    const serif = await readFontFile('serif.ttf', extractFace(fonts, 1));
    expect(serif.faces.map((f) => f.postscriptName)).toEqual(['DejaVuSerif']);
    // not toEqual: its element-by-element compare of the 740 KiB font took 0.6 s here and 2.7 s on CI
    const sans = file('DejaVuSans.ttf');
    const extracted = extractFace(await load('DejaVuSans.ttf'), 0);
    expect(extracted.length).toBe(sans.length);
    expect(extracted.findIndex((b, i) => b !== sans[i])).toBe(-1);
  });

  it('reads WOFF', async () => {
    const [face] = (await readFontFile('a.woff', buildWoff(file('DejaVuSansMono.ttf')))).faces;
    expect(face!.postscriptName).toBe('DejaVuSansMono');
    expect(face!.hasGlyph(0x41)).toBe(true);
  });

  it('rejects garbage with FontFileError', async () => {
    await expect(readFontFile('x.ttf', new Uint8Array(100))).rejects.toBeInstanceOf(FontFileError);
    await expect(readFontFile('x.ttf', file('DejaVuSans.ttf').subarray(0, 200))).rejects.toBeInstanceOf(FontFileError);
    await expect(readFontFile('x.ttc', new Uint8Array([0x74, 0x74, 0x63, 0x66, 0, 1, 0, 0, 0xff, 0xff, 0xff, 0xff]))).rejects.toBeInstanceOf(FontFileError);
  });
});
