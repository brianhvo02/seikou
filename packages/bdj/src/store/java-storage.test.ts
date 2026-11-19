import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { beforeAll, describe, expect, it } from 'vitest';
import { assembleClass } from '../../../../tests/helpers/jvm-asm';
import { Jvm } from '../jvm/jvm';
import type { JObject } from '../jvm/values';
import { Vfs } from '../jvm/vfs';
import { ZipArchive } from '../jvm/zip';
import { SCOPE_QUOTA_BYTES, type BdjStore, type LoadedSnapshot, type SaveResult, type Snapshot } from './bdj-store';
import { ScopeSync } from './scope-sync';

const jar = (name: string): Uint8Array => new Uint8Array(readFileSync(fileURLToPath(new URL(`../../../bdj-classlib/${name}`, import.meta.url))));
const RT = jar('rt-bdj.jar');

const NEW = 0xbb, DUP = 0x59, ALOAD_0 = 0x2a, ALOAD_2 = 0x2c, ASTORE_2 = 0x4d, ILOAD_1 = 0x1b, NEWARRAY = 0xbc, T_BYTE = 8;
const INVOKESPECIAL = 0xb7, INVOKEVIRTUAL = 0xb6, ACONST_NULL = 0x01, ARETURN = 0xb0, IRETURN = 0xac;
const m = (cls: string, name: string, desc: string): { c: ['method', string, string, string] } => ({ c: ['method', cls, name, desc] });

/** What a disc's xlet does with its saved data: File.exists, FileInputStream.read and FileOutputStream.write. */
const PROBE = assembleClass('StoreProbe', [
  {
    name: 'exists',
    desc: '(Ljava/lang/String;)Z',
    code: [NEW, { c: ['class', 'java/io/File'] }, DUP, ALOAD_0, INVOKESPECIAL, m('java/io/File', '<init>', '(Ljava/lang/String;)V'), INVOKEVIRTUAL, m('java/io/File', 'exists', '()Z'), IRETURN],
  },
  {
    name: 'first',
    desc: '(Ljava/lang/String;)I',
    code: [NEW, { c: ['class', 'java/io/FileInputStream'] }, DUP, ALOAD_0, INVOKESPECIAL, m('java/io/FileInputStream', '<init>', '(Ljava/lang/String;)V'),
      INVOKEVIRTUAL, m('java/io/FileInputStream', 'read', '()I'), IRETURN],
  },
  {
    // try { o = new FileOutputStream(path); o.write(new byte[n]); o.close(); return null; } catch (IOException e) { return e.getMessage(); }
    name: 'fill',
    desc: '(Ljava/lang/String;I)Ljava/lang/String;',
    code: [NEW, { c: ['class', 'java/io/FileOutputStream'] }, DUP, ALOAD_0, INVOKESPECIAL, m('java/io/FileOutputStream', '<init>', '(Ljava/lang/String;)V'), ASTORE_2,
      ALOAD_2, ILOAD_1, NEWARRAY, T_BYTE, INVOKEVIRTUAL, m('java/io/FileOutputStream', 'write', '([B)V'),
      ALOAD_2, INVOKEVIRTUAL, m('java/io/FileOutputStream', 'close', '()V'), ACONST_NULL, ARETURN,
      ASTORE_2, ALOAD_2, INVOKEVIRTUAL, m('java/lang/Throwable', 'getMessage', '()Ljava/lang/String;'), ARETURN],
    handlers: [[0, 22, 22, 'java/io/IOException']],
  },
]);

class OneScopeStore implements BdjStore {
  // counted as the NAS counts it (ruling R24): a new file needs room for its tar header
  readonly quotaAccounting = 'tar';
  stored: Snapshot = { files: [{ path: '4001/save', mtime: 1_600_000_000_000, bytes: new Uint8Array([42, 1, 2]) }] };
  etag = 'e0';
  saves = 0;
  async load(): Promise<LoadedSnapshot> {
    return { files: this.stored.files, etag: this.etag };
  }
  async save(_scope: string, snapshot: Snapshot, etag: string | null): Promise<SaveResult> {
    if (etag !== this.etag) return { conflict: { ...this.stored, etag: this.etag } };
    this.stored = { files: snapshot.files.map((f) => ({ ...f, bytes: f.bytes.slice() })) };
    this.etag = `e${++this.saves}`;
    return { etag: this.etag };
  }
}

describe('Java and the storage scopes', () => {
  const store = new OneScopeStore();
  let jvm: Jvm;
  let sync: ScopeSync;
  const call = async <T,>(name: string, desc: string, ...args: (string | number)[]): Promise<T> =>
    (await jvm.callStatic('StoreProbe', name, desc, args.map((a) => (typeof a === 'string' ? jvm.heap.newString(a) : a)))) as T;

  beforeAll(async () => {
    sync = await ScopeSync.load([{ key: 'persistent/7fff0123', dir: '/persistent/7fff0123' }], { store, setTimer: () => () => undefined, log: () => undefined });
    const vfs = new Vfs({
      disc: null,
      jdkLib: ZipArchive.open(RT),
      nowMs: () => Date.now(),
      onChange: (p, c, to) => sync.changed(p, c, to),
      onFull: (p) => sync.refused(p),
    });
    sync.attach(vfs);
    jvm = new Jvm({
      bootJars: [jar('libbluray-j2se.jar'), jar('libbluray-awt-j2se.jar'), RT],
      nowMs: () => Date.now(),
      setTimer: (ms, fn) => {
        const id = setTimeout(fn, ms);
        return () => clearTimeout(id);
      },
      stdout: () => undefined,
      stderr: () => undefined,
      vfs,
    });
    await jvm.boot();
    jvm.loader.define('StoreProbe', PROBE, null, null);
  }, 60_000);

  it('sees a loaded snapshot through File.exists and FileInputStream', async () => {
    expect(await call<number>('exists', '(Ljava/lang/String;)Z', '/persistent/7fff0123/4001/save')).toBe(1);
    expect(await call<number>('exists', '(Ljava/lang/String;)Z', '/persistent/7fff0123/4001/none')).toBe(0);
    expect(await call<number>('first', '(Ljava/lang/String;)I', '/persistent/7fff0123/4001/save')).toBe(42);
  });

  it('gets an IOException (no space) for a write past 16 MB in a scope, and the store keeps the last complete snapshot', async () => {
    const message = await call<JObject | null>('fill', '(Ljava/lang/String;I)Ljava/lang/String;', '/persistent/7fff0123/4001/big', SCOPE_QUOTA_BYTES);
    expect(message && jvm.heap.jsString(message)).toBe('No space left on device');
    await sync.flush();
    expect(store.saves).toBe(0);
    expect(store.stored.files.map((f) => f.path)).toEqual(['4001/save']);
    // the disc carries on: a write that fits is saved, the one that did not is not
    expect(await call<JObject | null>('fill', '(Ljava/lang/String;I)Ljava/lang/String;', '/persistent/7fff0123/4001/small', 10)).toBeNull();
    await sync.flush();
    expect(store.stored.files.map((f) => [f.path, f.bytes.length])).toEqual([['4001/save', 3], ['4001/small', 10]]);
  });

  it('gets an IOException (no space) for a write that needs more room once the NAS is full (its 507), and room again after', async () => {
    sync.full('persistent/7fff0123', true);
    // a new file: refused at its open, for its tar header (a FileNotFoundException naming a full disk, as open(2) does)
    const message = await call<JObject | null>('fill', '(Ljava/lang/String;I)Ljava/lang/String;', '/persistent/7fff0123/4001/more', 1);
    expect(message && jvm.heap.jsString(message)).toBe('/persistent/7fff0123/4001/more (No space left on device)');
    // a file there already: refused at the write that needs another block
    const grow = await call<JObject | null>('fill', '(Ljava/lang/String;I)Ljava/lang/String;', '/persistent/7fff0123/4001/small', 600);
    expect(grow && jvm.heap.jsString(grow)).toBe('No space left on device');
    // what is there stays readable
    expect(await call<number>('first', '(Ljava/lang/String;)I', '/persistent/7fff0123/4001/save')).toBe(42);
    sync.full('persistent/7fff0123', false);
    expect(await call<JObject | null>('fill', '(Ljava/lang/String;I)Ljava/lang/String;', '/persistent/7fff0123/4001/more', 1)).toBeNull();
  });
});
