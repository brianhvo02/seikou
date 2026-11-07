import { readFileSync } from 'node:fs';
import SevenZip from '7z-wasm';
import { describe, expect, it } from 'vitest';
import { ARCHIVE_MODULE, fontsIn7z, PACK_LIMITS, TooLargeArchive, unxz } from './archive';

async function makePack(files: Record<string, Buffer>): Promise<Buffer> {
  const sz = await SevenZip({ wasmBinary: readFileSync(new URL('../../../node_modules/7z-wasm/7zz.wasm', import.meta.url)).buffer as ArrayBuffer, print: () => {}, printErr: () => {}, stdout: () => {} });
  for (const [n, d] of Object.entries(files)) {
    if (n.includes('/') && !sz.FS.readdir('.').includes('d')) sz.FS.mkdir('d');
    sz.FS.writeFile(n, d);
  }
  sz.callMain(['a', '-t7z', 'p.7z', ...Object.keys(files)]);
  return Buffer.from(sz.FS.readFile('p.7z'));
}

const fixture = (name: string): Buffer => readFileSync(new URL(`./__fixtures__/${name}`, import.meta.url));

describe('archives', () => {
  it('unxz restores the track', async () => {
    const out = await unxz(fixture('track.ass.xz'), 1 << 20);
    expect(out.toString('utf8').startsWith('[Script Info]')).toBe(true);
  });

  it('unxz refuses past maxBytes', async () => {
    await expect(unxz(fixture('track.ass.xz'), 10)).rejects.toBeInstanceOf(TooLargeArchive);
    // the instance still works afterwards
    expect((await unxz(fixture('track.ass.xz'), 1 << 20)).length).toBeGreaterThan(10);
  });

  it('fontsIn7z lists only fonts', async () => {
    const fonts = await fontsIn7z(fixture('pack.7z'));
    expect(fonts.map((f) => f.name)).toEqual(['Default.ttf']);
    const original = readFileSync(new URL('../../../packages/ass/src/default-font.ttf', import.meta.url));
    expect(fonts[0]!.data.equals(original)).toBe(true);
  });

  it('fontsIn7z rejects a broken archive', async () => {
    const pack = fixture('pack.7z');
    await expect(fontsIn7z(pack.subarray(0, 100))).rejects.toThrow();
    expect((await fontsIn7z(pack)).length).toBe(1);
  });

  it('fontsIn7z finds mixed-case extensions in subfolders', async () => {
    const font = readFileSync(new URL('../../../packages/ass/src/default-font.ttf', import.meta.url));
    const pack = await makePack({ 'A.TTF': font, 'd/b.Otf': font, 'd/c.ttf': font, 'd/notes.txt': Buffer.from('x') });
    const fonts = await fontsIn7z(pack);
    expect(fonts.map((f) => f.name).sort()).toEqual(['A.TTF', 'b.Otf', 'c.ttf']);
  });

  it('fontsIn7z refuses a pack whose entries or total size pass the limits, fonts or not', async () => {
    const pack = await makePack({ 'a.txt': Buffer.alloc(1000, 1), 'b.txt': Buffer.alloc(1000, 2), 'c.ttf': Buffer.alloc(10, 3) });
    const saved = { ...PACK_LIMITS };
    try {
      PACK_LIMITS.entries = 2;
      await expect(fontsIn7z(pack)).rejects.toBeInstanceOf(TooLargeArchive);
      PACK_LIMITS.entries = saved.entries;
      PACK_LIMITS.bytes = 1500;
      await expect(fontsIn7z(pack)).rejects.toBeInstanceOf(TooLargeArchive);
    } finally {
      Object.assign(PACK_LIMITS, saved);
    }
    expect((await fontsIn7z(pack)).map((f) => f.name)).toEqual(['c.ttf']);
  });

  it('drops the 7-Zip module after a job whose input or output passed the recycle size, and keeps it otherwise', async () => {
    const track = fixture('track.ass.xz');
    const saved = ARCHIVE_MODULE.recycleBytes;
    try {
      await unxz(track, 1 << 20);
      const loads = ARCHIVE_MODULE.loads;
      await unxz(track, 1 << 20);
      expect(ARCHIVE_MODULE.loads).toBe(loads);
      // the output is past it, the input not: the next job loads a fresh module
      const out = await unxz(track, 1 << 20);
      ARCHIVE_MODULE.recycleBytes = Math.max(track.length, out.length - 1);
      await unxz(track, 1 << 20);
      await unxz(track, 1 << 20);
      expect(ARCHIVE_MODULE.loads).toBe(loads + 1);
      ARCHIVE_MODULE.recycleBytes = 10;
      await fontsIn7z(fixture('pack.7z'));
      expect((await fontsIn7z(fixture('pack.7z'))).length).toBe(1);
      expect(ARCHIVE_MODULE.loads).toBe(loads + 3);
    } finally {
      ARCHIVE_MODULE.recycleBytes = saved;
    }
  });
});
