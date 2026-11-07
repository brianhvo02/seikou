/// <reference types="node" />
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { beforeAll, describe, expect, it } from 'vitest';
import { FreeTypeError, loadFreeType, type FreeType } from './freetype';

const read = (path: string): Uint8Array => readFileSync(fileURLToPath(new URL(path, import.meta.url)));

interface GoldenGlyph {
  code: number;
  widthError: number;
  widthAdvance: number;
  renderError: number;
  advance?: number;
  left?: number;
  top?: number;
  width?: number;
  rows?: number;
  pixelMode?: number;
  bitmap?: string;
}

interface Golden {
  freetype: string;
  family: string;
  style: string;
  sizes: {
    size: number;
    metrics: { ascent: number; descent: number; leading: number; maxAdvance: number; height: number };
    kerning: { left: number; right: number; x: number }[];
    glyphs: GoldenGlyph[];
  }[];
}

// From the system FreeType libbluray links in the BD-J harness: tools/bdj-trace/freetype-golden.sh
const golden = JSON.parse(new TextDecoder().decode(read('../../../../tests/bdj/fonts/freetype-golden.json'))) as Golden;
const font = read('../../../../packages/ass/src/default-font.ttf');
const base64 = (bytes: Uint8Array): string => Buffer.from(bytes).toString('base64');

describe('freetype.wasm against the libbluray harness FreeType', () => {
  let ft: FreeType;
  beforeAll(async () => {
    ft = await loadFreeType(read('../../../wasm/freetype/freetype.wasm'));
  });

  it('is the harness version', () => {
    expect(golden.freetype).toBe('2.13.2');
  });

  it('renders "Ag" at 24 px like the harness', () => {
    const face = ft.newFace(font);
    ft.setSize(face, 24);
    const size = golden.sizes.find((s) => s.size === 24)!;
    expect(ft.metrics(face)).toEqual(size.metrics);
    for (const c of 'Ag') {
      const want = size.glyphs.find((g) => g.code === c.codePointAt(0))!;
      const got = ft.glyph(face, c.codePointAt(0)!)!;
      expect({ ...got, bitmap: base64(got.bitmap) }).toEqual({
        advance: want.advance,
        left: want.left,
        top: want.top,
        width: want.width,
        rows: want.rows,
        pixelMode: want.pixelMode,
        bitmap: want.bitmap,
      });
      expect(got.bitmap.some((v) => v > 0 && v < 255)).toBe(true); // anti-aliased coverage, not a mono bitmap
    }
    ft.free(face);
  });

  it('matches every golden size, metric, advance, kerning pair and bitmap', () => {
    const family = ft.newFace(font);
    expect([ft.familyName(family), ft.styleName(family)]).toEqual([golden.family, golden.style]);
    ft.free(family);
    for (const size of golden.sizes) {
      const face = ft.newFace(font); // loadFontN: a face per font and size
      expect(ft.setSize(face, size.size)).toBe(0);
      expect(ft.metrics(face), `metrics at ${size.size}`).toEqual(size.metrics);
      for (const k of size.kerning) expect(ft.kerning(face, k.left, k.right), `kerning ${k.left},${k.right}`).toBe(k.x);
      for (const g of size.glyphs) {
        const where = `U+${g.code.toString(16)} at ${size.size}`;
        expect(ft.advance(face, g.code), where).toBe(g.widthError === 0 ? g.widthAdvance : null);
        const got = ft.glyph(face, g.code);
        if (g.renderError !== 0) {
          expect(got, where).toBeNull();
          continue;
        }
        expect(got && { ...got, bitmap: base64(got.bitmap) }, where).toEqual({
          advance: g.advance,
          left: g.left,
          top: g.top,
          width: g.width,
          rows: g.rows,
          pixelMode: g.pixelMode,
          bitmap: g.bitmap,
        });
      }
      ft.free(face);
    }
  });

  it('reports a file FreeType cannot open, and keeps working', () => {
    expect(() => ft.newFace(new Uint8Array([1, 2, 3, 4]))).toThrow(FreeTypeError);
    const face = ft.newFace(font);
    expect(() => ft.free(face + 1)).toThrow(/no face/);
    ft.free(face);
    expect(() => ft.metrics(face)).toThrow(/no face/);
  });
});
