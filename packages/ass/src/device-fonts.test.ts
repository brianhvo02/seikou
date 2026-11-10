// SPDX-License-Identifier: LGPL-3.0-or-later
import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { deviceFaceInfo, localNames, type DeviceFontSource } from './device-fonts';
import { readFontFile } from './font-tables';
import { AssFonts, type FontRequest } from './fonts';

const bytes = (f: string): Uint8Array => new Uint8Array(readFileSync(`fixtures/ass/fonts/${f}`));
const req = (family: string, bold = 400, italic = 0): FontRequest => ({ family, bold, italic, vertical: false });

/** A device with the families in `installed` (lower case), each in the styles given. */
function fakeDevice(installed: Record<string, readonly ('regular' | 'bold' | 'italic' | 'boldItalic')[]>) {
  const asked: string[][] = [];
  const unloaded: string[] = [];
  const source: DeviceFontSource = {
    async load(_cssFamily, names) {
      asked.push([...names]);
      for (const [family, styles] of Object.entries(installed)) {
        for (const style of styles) if (localNames(family, style).some((n) => names.some((m) => m.toLowerCase() === n.toLowerCase()))) return { ascent: 0.9, descent: 0.2 };
      }
      return null;
    },
    unload: (cssFamily) => { unloaded.push(cssFamily); },
  };
  return { source, asked, unloaded };
}

async function fonts(device: DeviceFontSource | null, ...files: string[]) {
  const f = new AssFonts({ load: async () => {}, unload: () => {} }, await readFontFile('DejaVuSans.ttf', bytes('DejaVuSans.ttf')), { deviceFonts: device });
  await f.add(files.map((name) => ({ name, bytes: bytes(name) })));
  return f;
}

describe('device fonts', () => {
  it('resolves a family no supplied face matches to the installed face once ready, and does not report it missing', async () => {
    const { source } = fakeDevice({ arial: ['regular', 'bold'] });
    const f = await fonts(source);
    expect(f.resolve(req('Arial')).fallback).toBe(true); // not looked up yet: the default draws meanwhile
    expect(f.hasPending()).toBe(true);
    await f.ready();
    const r = f.resolve(req('Arial'));
    expect(r).toMatchObject({ fallback: false, synthBold: false });
    expect(r.face.families).toEqual(['Arial']);
    expect(r.face.ascender - r.face.descender).toBe(1100);
    expect(f.resolve(req('Arial', 700)).face.bold).toBe(true); // the installed bold face, not a synthetic one
    expect(f.faceFor(req('Arial'), 0x3042)).toBe(r); // device faces are taken to cover every character
    expect(f.missingFamilies()).toEqual([]);
    expect(f.hasPending()).toBe(false);
  });

  it('synthesizes bold when only the regular face is installed', async () => {
    const f = await fonts(fakeDevice({ arial: ['regular'] }).source);
    f.resolve(req('Arial', 700));
    await f.ready();
    expect(f.resolve(req('Arial', 700))).toMatchObject({ fallback: false, synthBold: true });
  });

  it('falls back to the default as before and lists a family the device lacks', async () => {
    const f = await fonts(fakeDevice({}).source);
    f.resolve(req('Fancy'));
    await f.ready();
    expect(f.resolve(req('Fancy'))).toMatchObject({ fallback: true });
    expect(f.resolve(req('Fancy')).face.postscriptName).toBe('DejaVuSans');
    expect(f.missingFamilies()).toEqual(['Fancy']);
  });

  it('asks once per family, failures included', async () => {
    const { source, asked } = fakeDevice({ arial: ['regular'] });
    const f = await fonts(source);
    f.resolve(req('Arial'));
    f.resolve(req('arial', 700));
    f.resolve(req('Fancy'));
    await f.ready();
    f.resolve(req('ARIAL', 400, 100));
    f.resolve(req('Fancy', 700));
    await f.add([]);
    f.resolve(req('Fancy'));
    await f.ready();
    expect(asked).toHaveLength(8); // four styles for each of the two families
  });

  it('never asks the device for a family a supplied face matches', async () => {
    const { source, asked } = fakeDevice({ 'dejavu serif': ['regular'] });
    const f = await fonts(source, 'DejaVuSerif.ttf');
    f.resolve(req('DejaVu Serif'));
    f.resolve(req('DejaVu Serif', 700)); // supplied regular face with synthetic bold, as libass draws it
    await f.ready();
    expect(asked).toEqual([]);
    expect(f.resolve(req('DejaVu Serif', 700))).toMatchObject({ synthBold: true });
    expect(f.resolve(req('DejaVu Serif')).face.postscriptName).toBe('DejaVuSerif');
  });

  it('lets a supplied face added later win over the installed one', async () => {
    const f = await fonts(fakeDevice({ 'dejavu serif': ['regular'] }).source);
    f.resolve(req('DejaVu Serif'));
    await f.ready();
    expect(f.resolve(req('DejaVu Serif')).face.postscriptName).toBeNull();
    await f.add([{ name: 'DejaVuSerif.ttf', bytes: bytes('DejaVuSerif.ttf') }]);
    expect(f.resolve(req('DejaVu Serif')).face.postscriptName).toBe('DejaVuSerif');
  });

  it('never asks with deviceFonts off', async () => {
    const f = await fonts(null);
    f.resolve(req('Arial'));
    await f.ready();
    expect(f.hasPending()).toBe(false);
    expect(f.resolve(req('Arial')).fallback).toBe(true);
    expect(f.missingFamilies()).toEqual(['Arial']);
  });

  it('never asks for the bundled default family, so its lines keep the bundled face', async () => {
    const { source, asked } = fakeDevice({ 'dejavu sans': ['regular'] });
    const f = await fonts(source);
    f.resolve(req('dejavu sans'));
    await f.ready();
    expect(asked).toEqual([]);
    expect(f.resolve(req('DejaVu Sans')).face.postscriptName).toBe('DejaVuSans');
  });

  it('looks up at most 32 families; later ones take the default and are reported missing', async () => {
    const families = Array.from({ length: 34 }, (_, i) => `Family ${i}`);
    const { source, asked } = fakeDevice(Object.fromEntries(families.map((n) => [n.toLowerCase(), ['regular'] as const])));
    const f = await fonts(source);
    for (const n of families) f.resolve(req(n));
    await f.ready();
    expect(asked).toHaveLength(32 * 4);
    expect(f.resolve(req('Family 31')).fallback).toBe(false);
    expect(f.resolve(req('Family 32')).fallback).toBe(true);
    expect(f.missingFamilies()).toEqual(['Family 32', 'Family 33']);
  });

  it('counts a lookup that takes over 3 s as a miss, and unloads a face that arrives after', async () => {
    vi.useFakeTimers();
    try {
      let late: (m: { ascent: number; descent: number }) => void = () => {};
      const unloaded: string[] = [];
      const source: DeviceFontSource = {
        load: (_css, names) => (names[0] === 'Stuck' ? new Promise((r) => { late = r; }) : new Promise(() => {})),
        unload: (css) => { unloaded.push(css); },
      };
      const f = await fonts(source);
      f.resolve(req('Stuck'));
      const ready = f.ready();
      await vi.advanceTimersByTimeAsync(3000);
      await ready;
      expect(f.resolve(req('Stuck')).fallback).toBe(true);
      expect(f.missingFamilies()).toEqual(['Stuck']);
      late({ ascent: 0.9, descent: 0.2 });
      await vi.runAllTimersAsync();
      expect(unloaded).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('unloads the device faces on dispose', async () => {
    const { source, unloaded } = fakeDevice({ arial: ['regular', 'italic'] });
    const f = await fonts(source);
    f.resolve(req('Arial'));
    await f.ready();
    f.dispose();
    expect(unloaded).toHaveLength(2);
  });
});

describe('localNames', () => {
  it('names the full and PostScript-style names of each style', () => {
    expect(localNames('Times New Roman', 'regular')).toEqual(['Times New Roman', 'Times New Roman Regular', 'TimesNewRoman', 'TimesNewRoman-Regular']);
    expect(localNames('Arial', 'boldItalic')).toEqual(['Arial Bold Italic', 'Arial-BoldItalic']);
  });
});

describe('deviceFaceInfo', () => {
  it('turns measured em fractions into font units, with no ligature table', () => {
    const f = deviceFaceInfo('Arial', 'bold', { ascent: 0.905, descent: 0.212 });
    expect(f).toMatchObject({ unitsPerEm: 1000, ascender: 905, descender: -212, weight: 700, bold: true, italic: false, integerPpem: false });
    expect(f.hasGlyph(0x1f600)).toBe(true);
    expect(f.clusters([0x66, 0x69])).toEqual([0, 1]);
  });
});
