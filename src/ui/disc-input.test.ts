import { describe, expect, it } from 'vitest';
import { collectFromDirectoryHandle, collectFromFileList, discFromDataTransfer } from './disc-input';
import { readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { normalizeDiscPaths } from '@seikou/engine/disc/paths';

function file(name: string, relative = ''): File {
  const f = new File(['x'], name);
  Object.defineProperty(f, 'webkitRelativePath', { value: relative });
  return f;
}

function dir(name: string, children: Record<string, File | FileSystemDirectoryHandle>): FileSystemDirectoryHandle {
  return {
    kind: 'directory',
    name,
    async *entries() {
      for (const [childName, child] of Object.entries(children)) {
        if (child instanceof File) yield [childName, { kind: 'file', name: childName, getFile: async () => child }];
        else yield [childName, child];
      }
    },
  } as unknown as FileSystemDirectoryHandle;
}

describe('disc input', () => {
  it('uses webkitRelativePath from a folder <input>', () => {
    const a = file('index.bdmv', 'Movie/BDMV/index.bdmv');
    expect(collectFromFileList([a])).toEqual([['Movie/BDMV/index.bdmv', a]]);
  });

  it('walks a directory handle, prefixing the folder name', async () => {
    const idx = file('index.bdmv');
    const m2ts = file('00000.m2ts');
    const root = dir('Movie', { BDMV: dir('BDMV', { 'index.bdmv': idx, STREAM: dir('STREAM', { '00000.m2ts': m2ts }) }) });
    expect(await collectFromDirectoryHandle(root)).toEqual([
      ['Movie/BDMV/index.bdmv', idx],
      ['Movie/BDMV/STREAM/00000.m2ts', m2ts],
    ]);
  });

  it('finds a dropped directory handle', async () => {
    const handle = dir('Movie', {});
    const dt = { items: [{ kind: 'file', getAsFileSystemHandle: async () => handle }] } as unknown as DataTransfer;
    expect(await discFromDataTransfer(dt)).toEqual({ kind: 'handle', handle });
    const noHandles = { items: [{ kind: 'string' }] } as unknown as DataTransfer;
    expect(await discFromDataTransfer(noHandles)).toBeNull();
  });

  it('falls back to webkitGetAsEntry when items lack getAsFileSystemHandle', async () => {
    const idx = new File([], 'index.bdmv');
    const bdmv = {
      isFile: false,
      isDirectory: true,
      name: 'BDMV',
      createReader() {
        let done = false;
        return {
          readEntries(ok: (e: unknown[]) => void) {
            ok(done ? [] : [{ isFile: true, isDirectory: false, name: 'index.bdmv', file: (cb: (f: File) => void) => cb(idx) }]);
            done = true;
          },
        };
      },
    };
    const dt = { items: [{ kind: 'file', webkitGetAsEntry: () => bdmv }] } as unknown as DataTransfer;
    expect(await discFromDataTransfer(dt)).toEqual({ kind: 'entries', entries: [['BDMV/index.bdmv', idx]] });
  });

  it('returns null when only plain files are dropped', async () => {
    const f = new File([], 'a.srt');
    const dt = { items: [{ kind: 'file', webkitGetAsEntry: () => ({ isFile: true, isDirectory: false, name: 'a.srt', file: (cb: (x: File) => void) => cb(f) }) }] } as unknown as DataTransfer;
    expect(await discFromDataTransfer(dt)).toBeNull();
  });

  describe('fixtures/synthetic/disc1 picked from a file list', () => {
    const walk = (dir: string, prefix: string): string[] =>
      readdirSync(dir).flatMap((n) => (statSync(join(dir, n)).isDirectory() ? walk(join(dir, n), `${prefix}${n}/`) : [`${prefix}${n}`]));
    const listed = walk('fixtures/synthetic/disc1', ''); // BDMV/index.bdmv, ...
    const pick = (rootPrefix: string | null) =>
      collectFromFileList(listed.map((rel) => file(rel.split('/').pop()!, rootPrefix === null ? '' : `${rootPrefix}${rel}`)));
    const expected = listed.map((r) => r.toUpperCase()).sort();

    it('finds the root when paths are rooted at BDMV (iOS Files pick of the BDMV folder)', () => {
      expect([...normalizeDiscPaths(pick('')).keys()].sort()).toEqual(expected);
    });

    it('finds the root when paths are rooted at disc1/BDMV', () => {
      expect([...normalizeDiscPaths(pick('disc1/')).keys()].sort()).toEqual(expected);
    });

    it('fails with not-bdmv when every webkitRelativePath is empty (bare names lose the folder structure)', () => {
      const entries = pick(null);
      expect(entries.map(([p]) => p)).toEqual(listed.map((r) => r.split('/').pop()));
      expect(() => normalizeDiscPaths(entries)).toThrowError(expect.objectContaining({ code: 'not-bdmv' }));
    });
  });
});
