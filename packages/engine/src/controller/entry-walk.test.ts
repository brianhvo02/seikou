import { describe, expect, it } from 'vitest';
import { walkEntries, type EntryLike } from './entry-walk';

const fileEntry = (name: string, file: File): EntryLike =>
  ({ isFile: true, isDirectory: false, name, file: (ok: (f: File) => void) => ok(file) }) as unknown as EntryLike;

/** Returns its children in batches of one, then an empty batch, like a browser's paged reader. */
function dirEntry(name: string, children: EntryLike[], reads: { count: number } = { count: 0 }): EntryLike {
  return {
    isFile: false,
    isDirectory: true,
    name,
    createReader() {
      let next = 0;
      return {
        readEntries(ok: (e: EntryLike[]) => void) {
          reads.count++;
          ok(next < children.length ? [children[next++]!] : []);
        },
      };
    },
  } as unknown as EntryLike;
}

describe('walkEntries', () => {
  it('joins names from the dropped entry and reads until an empty batch', async () => {
    const idx = new File([], 'index.bdmv');
    const mpls = new File([], '00000.mpls');
    const reads = { count: 0 };
    const tree = dirEntry('DISC', [dirEntry('BDMV', [fileEntry('index.bdmv', idx), dirEntry('PLAYLIST', [fileEntry('00000.mpls', mpls)])])], reads);
    expect(await walkEntries([tree], 6)).toEqual([
      ['DISC/BDMV/index.bdmv', idx],
      ['DISC/BDMV/PLAYLIST/00000.mpls', mpls],
    ]);
    expect(reads.count).toBe(2);
  });

  it('stops descending below maxDepth', async () => {
    const f = new File([], 'a.txt');
    const tree = dirEntry('A', [dirEntry('B', [dirEntry('C', [fileEntry('a.txt', f)])])]);
    expect(await walkEntries([tree], 1)).toEqual([]);
    expect(await walkEntries([tree], 2)).toEqual([['A/B/C/a.txt', f]]);
  });
});
