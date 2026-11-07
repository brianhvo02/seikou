import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { readFontFile } from './font-tables';
import { advanceEmSize, AssFonts, emSize, type FontLoader, type FontRequest } from './fonts';

const bytes = (f: string): Uint8Array => new Uint8Array(readFileSync(`fixtures/ass/fonts/${f}`));
function fakeLoader() {
  const loaded: string[] = [];
  const unloaded: string[] = [];
  const loader: FontLoader = { load: async (family) => { loaded.push(family); }, unload: (family) => { unloaded.push(family); } };
  return { loader, loaded, unloaded };
}
async function fonts(...files: string[]) {
  const { loader, loaded, unloaded } = fakeLoader();
  const f = new AssFonts(loader, await readFontFile('DejaVuSans.ttf', bytes('DejaVuSans.ttf')));
  await f.add(files.map((name) => ({ name, bytes: bytes(name) })));
  return { f, loaded, unloaded };
}
const req = (family: string, bold = 400, italic = 0, vertical = false): FontRequest => ({ family, bold, italic, vertical });

describe('AssFonts', () => {
  it('matches family names case-insensitively and picks the closest weight', async () => {
    const { f } = await fonts('DejaVuSans.ttf', 'DejaVuSans-Bold.ttf');
    expect(f.resolve(req('dejavu sans', 700)).face.postscriptName).toBe('DejaVuSans-Bold');
    expect(f.resolve(req('DejaVu Sans', 400)).face.postscriptName).toBe('DejaVuSans');
  });

  it('prefers an upright face for an upright request and an italic one for italic', async () => {
    const { f } = await fonts('DejaVuSans-Oblique.ttf', 'DejaVuSans.ttf');
    expect(f.resolve(req('DejaVu Sans')).face.postscriptName).toBe('DejaVuSans');
    expect(f.resolve(req('DejaVu Sans', 400, 100)).face.postscriptName).toBe('DejaVuSans-Oblique');
  });

  it('matches full names for TrueType faces', async () => {
    const { f } = await fonts('DejaVuSans-Bold.ttf');
    expect(f.resolve(req('DejaVu Sans Bold')).fallback).toBe(false);
    // a TrueType face whose full name differs from its PostScript name matches only the full name
    expect(f.resolve(req('DejaVuSans-Bold')).fallback).toBe(true);
  });

  it('synthesizes bold and italic as ass_font_get_glyph does', async () => {
    const { f } = await fonts('DejaVuSans.ttf');
    expect(f.resolve(req('DejaVu Sans', 700, 100))).toMatchObject({ synthBold: true, synthItalic: true, italicShear: 0x5700 / 0x10000 });
    expect(f.resolve(req('DejaVu Sans', 500))).toMatchObject({ synthBold: false, synthItalic: false });
    expect(f.resolve(req('DejaVu Sans', 400, 50)).synthItalic).toBe(false);
  });

  it('falls back to the default font and reports each missing family once', async () => {
    const { f } = await fonts('DejaVuSerif.ttf');
    expect(f.resolve(req('Fancy'))).toMatchObject({ fallback: true });
    expect(f.resolve(req('Fancy')).face.postscriptName).toBe('DejaVuSans');
    f.resolve(req('FANCY', 700));
    f.resolve(req('Other'));
    f.resolve(req(''));
    expect(f.missingFamilies()).toEqual(['Fancy', 'Other']);
  });

  it('strips a leading @ into the vertical flag (ass_update_font does) and matches the rest', async () => {
    const { f } = await fonts('DejaVuSerif.ttf');
    expect(f.resolve(req('DejaVu Serif', 400, 0, true)).fallback).toBe(false);
  });

  it('loads only the faces that were resolved, once', async () => {
    const { f, loaded } = await fonts('DejaVuSans.ttf', 'DejaVuSerif.ttf', 'DejaVuSansMono.ttf');
    f.resolve(req('DejaVu Serif'));
    f.resolve(req('DejaVu Serif', 700));
    await f.ready();
    await f.ready();
    expect(loaded).toHaveLength(1);
  });

  it('returns unreadable files by name', async () => {
    const { f } = await fonts();
    expect((await f.add([{ name: 'bad.ttf', bytes: new Uint8Array(10) }])).unreadable).toEqual(['bad.ttf']);
  });

  it('adds a face for a glyph the matched face lacks, from the default font', async () => {
    const { f } = await fonts('DejaVuSansMono.ttf');
    expect(f.faceFor(req('DejaVu Sans Mono'), 0x41).face.postscriptName).toBe('DejaVuSansMono');
    expect(f.faceFor(req('DejaVu Sans Mono'), 0x10ffff).face.postscriptName).toBe('DejaVuSans');
    expect(f.faceFor(req('DejaVu Sans Mono'), 0x0a).face.postscriptName).toBe('DejaVuSansMono'); // controls use face 0
  });

  it('unloads its faces on dispose', async () => {
    const { f, unloaded } = await fonts('DejaVuSerif.ttf');
    f.resolve(req('DejaVu Serif'));
    await f.ready();
    f.dispose();
    expect(unloaded).toHaveLength(1);
  });
});

describe('emSize and advanceEmSize', () => {
  it('makes ascender + descender equal the requested size, the advance em rounded to whole pixels for TrueType fonts that force it', async () => {
    const [face] = (await readFontFile('a.ttf', bytes('DejaVuSans.ttf'))).faces;
    expect(face!.integerPpem).toBe(true); // head.flags bit 3, glyf outlines
    const exact = (256 * face!.unitsPerEm) / (face!.ascender - face!.descender);
    expect(emSize(face!, 256)).toBeCloseTo(exact, 9);
    expect(advanceEmSize(face!, 256)).toBe(Math.round(exact));
    expect(advanceEmSize({ ...face!, integerPpem: false }, 256)).toBeCloseTo(exact, 9);
  });
});
