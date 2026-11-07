import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { readFontFile } from './font-tables';

const face = async (f: string) => (await readFontFile(f, new Uint8Array(readFileSync(`fixtures/ass/fonts/${f}`)))).faces[0]!;
const cps = (s: string): number[] => [...s].map((c) => c.codePointAt(0)!);

describe('FaceInfo.clusters (GSUB ligatures)', () => {
  it('merges fi and fl the way HarfBuzz does with liga on', async () => {
    const f = await face('DejaVuSans.ttf');
    expect(f.clusters(cps('first'))).toEqual([0, 0, 2, 3, 4]);
    expect(f.clusters(cps('fill'))).toEqual([0, 0, 2, 3]);
    expect(f.clusters(cps('flow'))).toEqual([0, 0, 2, 3]);
  });

  it('leaves text without ligatures alone', async () => {
    const f = await face('DejaVuSans.ttf');
    expect(f.clusters(cps('hello'))).toEqual([0, 1, 2, 3, 4]);
    expect(f.clusters([])).toEqual([]);
  });

  it('maps code points to glyph ids', async () => {
    const f = await face('DejaVuSans.ttf');
    expect(f.glyphId(0x41)).toBeGreaterThan(0);
    expect(f.glyphId(0x10ffff)).toBe(0);
  });

  it('has no ligatures in a monospaced face that defines none', async () => {
    const f = await face('DejaVuSansMono.ttf');
    expect(f.clusters(cps('first'))).toEqual([0, 1, 2, 3, 4]);
  });
});
