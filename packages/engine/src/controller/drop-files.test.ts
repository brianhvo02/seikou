import { describe, expect, it } from 'vitest';
import { collectDroppedFiles, splitPick } from './drop-files';

const f = (name: string) => new File(['x'], name);

describe('splitPick', () => {
  it('separates subtitle files and fonts, ignoring the rest', () => {
    const out = splitPick([f('b.ass'), f('a.srt'), f('x.ttf'), f('y.OTF'), f('readme.txt'), f('c.SSA'), f('z.woff2'), f('w.woff')]);
    expect(out.subtitles.map((x) => x.name)).toEqual(['b.ass', 'a.srt', 'c.SSA']);
    expect(out.fonts.map((x) => x.name)).toEqual(['x.ttf', 'y.OTF', 'w.woff']);
  });
});

/** A fake FileSystemEntry tree for webkitGetAsEntry. */
function fileEntry(name: string) {
  return { isFile: true, isDirectory: false, name, file: (ok: (file: File) => void) => ok(f(name)) };
}
function dirEntry(name: string, children: unknown[]) {
  return {
    isFile: false, isDirectory: true, name,
    createReader: () => {
      let done = false;
      return { readEntries: (ok: (entries: unknown[]) => void) => { ok(done ? [] : children); done = true; } };
    },
  };
}
const items = (...entries: unknown[]) => ({ length: entries.length, ...Object.fromEntries(entries.map((e, i) => [i, { kind: 'file', webkitGetAsEntry: () => e, getAsFile: () => null }])) }) as unknown as DataTransferItemList;

describe('collectDroppedFiles', () => {
  it('takes plain files and the files of dropped folders one level deep', async () => {
    const files = await collectDroppedFiles(items(fileEntry('top.ass'), dirEntry('show', [fileEntry('ep1.ass'), fileEntry('font.ttf'), dirEntry('fonts', [fileEntry('deep.otf'), dirEntry('deeper', [fileEntry('lost.ttf')])])])));
    expect(files.map((x) => x.name).sort()).toEqual(['deep.otf', 'ep1.ass', 'font.ttf', 'top.ass']);
  });

  it("takes a dropped file from getAsFile when its entry can't read it (WebKit, a file without a disk path)", async () => {
    const broken = { isFile: true, isDirectory: false, name: 'a.srt', file: (_ok: unknown, fail: (err: unknown) => void) => fail(new Error('NotFoundError')) };
    const list = { length: 1, 0: { kind: 'file', webkitGetAsEntry: () => broken, getAsFile: () => f('a.srt') } } as unknown as DataTransferItemList;
    expect((await collectDroppedFiles(list)).map((x) => x.name)).toEqual(['a.srt']);
  });
});
