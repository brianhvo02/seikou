import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { beforeAll, describe, expect, it } from 'vitest';
import { Jvm } from '../../src/bdj/jvm/jvm';
import { Vfs } from '../../src/bdj/jvm/vfs';
import { ZipArchive } from '../../src/bdj/jvm/zip';
import type { JArray, JObject, JValue } from '../../src/bdj/jvm/values';
import { assembleClass, storedZip } from '../helpers/jvm-asm';
import type { AsmMethod } from '../helpers/jvm-asm';
import { syntheticSource } from '../helpers/synthetic-disc';
import { byteArray } from '../../src/bdj/jvm/natives/util';
import { deflateSync, gzipSync } from 'node:zlib';

const file = (rel: string): Uint8Array => readFileSync(fileURLToPath(new URL(rel, import.meta.url)));

const RT = file('../../src/bdj-classlib/rt-bdj.jar');
const BOOT_JARS = [file('../../src/bdj-classlib/libbluray-j2se.jar'), file('../../src/bdj-classlib/libbluray-awt-j2se.jar'), RT, file('./conformance.jar')];

const NEW = 0xbb, DUP = 0x59, INVOKESPECIAL = 0xb7, INVOKEVIRTUAL = 0xb6, INVOKESTATIC = 0xb8, RETURN = 0xb1, ARETURN = 0xb0;
const ALOAD_0 = 0x2a, ASTORE_0 = 0x4b, ICONST_0 = 0x03, ICONST_1 = 0x04, ICONST_5 = 0x08, NEWARRAY = 0xbc, ACONST_NULL = 0x01, AALOAD = 0x32;
const T_INT = 10;
const GETSTATIC = 0xb2, ISTORE_1 = 0x3c, ILOAD_1 = 0x1b, IFLE = 0x9e, IINC = 0x84, GOTO = 0xa7;
const ACC_PUBLIC = 0x0001;

function bootedJvm(
  stdout: (s: string) => void = () => {},
  stderr: (s: string) => void = () => {},
  bootJars = BOOT_JARS,
  discFiles?: ReadonlyMap<string, Uint8Array<ArrayBuffer>>,
  failRead?: (path: string) => boolean,
): Jvm {
  const disc = discFiles ? syntheticSource(discFiles) : null;
  if (disc && failRead) {
    const read = disc.read.bind(disc);
    disc.read = (path, offset, length, signal) => (failRead(path) ? Promise.reject(new Error('file was removed')) : read(path, offset, length, signal));
  }
  return new Jvm({
    bootJars,
    nowMs: () => Date.now(),
    setTimer: (ms, fn) => {
      const id = setTimeout(fn, ms);
      return () => clearTimeout(id);
    },
    stdout,
    stderr,
    vfs: new Vfs({ disc, discPaths: disc?.paths(), jdkLib: ZipArchive.open(RT), nowMs: () => Date.now() }),
    systemProperties: new Map([['awt.toolkit', 'java.awt.BDToolkit']]),
  });
}

describe('Bare (before boot)', () => {
  const jvm = new Jvm({
    bootJars: BOOT_JARS,
    nowMs: () => 0,
    setTimer: () => () => {},
    stdout: () => {},
    stderr: () => {},
  });
  const expected = new TextDecoder()
    .decode(file('./conformance/Bare.out'))
    .split('\n')
    .filter((l) => l !== '')
    .map((l) => l.split(' ') as [string, string]);

  it.each(expected)('%s returns %s as on HotSpot', async (name, value) => {
    expect(await jvm.callStatic('conformance/Bare', name, '()I')).toBe(Number(value));
  });
});

describe('class-file bytes the classes keep', () => {
  it('are counted, and going over the budget is reported once', async () => {
    const warned: string[] = [];
    const jvm = new Jvm({ bootJars: BOOT_JARS, nowMs: () => 0, setTimer: () => () => {}, stdout: () => {}, stderr: () => {}, classBytesBudget: 100, warn: (l) => warned.push(l) });
    await jvm.callStatic('conformance/Bare', 'sum', '()I');
    const s = jvm.memoryStats();
    expect(s.classes).toBeGreaterThan(1);
    expect(s.classFileBytes).toBeGreaterThan(100);
    expect(warned).toEqual([expect.stringMatching(/^BD-J: classes keep [\d.]+ MB of class files, over the memory budget of 0\.0 MB$/)]);
  });
});

describe('kept annotation bytes', () => {
  it("are a runtime-visible annotation's bytes as HotSpot's reflection hands them out, after the class file is dropped", () => {
    const jvm = new Jvm({ bootJars: BOOT_JARS, nowMs: () => 0, setTimer: () => () => {}, stdout: () => {}, stderr: () => {} });
    const target = jvm.loader.loadBoot('conformance/Reflect$Target')!;
    const add = target.file!.methods.find((m) => m.name === 'add')!;
    const bytes = new Int8Array(add.annotations!.buffer, add.annotations!.byteOffset, add.annotations!.length);
    let sum = 0;
    for (const b of bytes) sum = (Math.imul(sum, 31) + b) | 0;
    // @Tag("adder") on Reflect.Target.add: length and `sum = sum * 31 + b` over Method.annotations, as a Java program
    // printed them on HotSpot 8 (the class library has no AnnotationParser, so Java cannot read them in our JVM)
    expect([bytes.length, sum]).toEqual([11, -1974274957]);
    expect(add.annotations!.buffer).toBe(add.code!.code.buffer);
    expect(target.file!.methods.find((m) => m.name === 'secret')!.annotations).toBeNull();
  });
});

describe('after JDK boot', () => {
  let out = '';
  let err = '';
  let jvm: Jvm;

  beforeAll(async () => {
    jvm = bootedJvm(
      (s) => (out += s),
      (s) => (err += s),
    );
    const start = performance.now();
    await jvm.boot();
    const ms = performance.now() - start;
    console.log(`JDK boot took ${ms.toFixed(0)} ms`);
    expect(ms).toBeLessThan(10_000);
  }, 60_000);

  async function property(name: string): Promise<string | null> {
    const v = await jvm.callStatic('java/lang/System', 'getProperty', '(Ljava/lang/String;)Ljava/lang/String;', [jvm.heap.newString(name)]);
    return jvm.heap.jsString(v as JObject | null);
  }

  it('sets the system properties, with the runtime-supplied ones', async () => {
    expect(await property('java.home')).toBe('/jdk');
    expect(await property('java.io.tmpdir')).toBe('/tmp');
    expect(await property('file.encoding')).toBe('UTF-8');
    expect(await property('line.separator')).toBe('\n');
    expect(await property('awt.toolkit')).toBe('java.awt.BDToolkit');
  });

  it('runs on the main thread of the main thread group, as HotSpot creates them', async () => {
    const t = (await jvm.callStatic('java/lang/Thread', 'currentThread', '()Ljava/lang/Thread;')) as JObject;
    expect(t).toBe(jvm.mainThread);
    expect(jvm.heap.jsString(jvm.getField(t, 'name', 'Ljava/lang/String;') as JObject)).toBe('main');
    const group = jvm.getField(t, 'group', 'Ljava/lang/ThreadGroup;') as JObject;
    expect(jvm.heap.jsString(jvm.getField(group, 'name', 'Ljava/lang/String;') as JObject)).toBe('main');
    const parent = jvm.getField(group, 'parent', 'Ljava/lang/ThreadGroup;') as JObject;
    expect(jvm.heap.jsString(jvm.getField(parent, 'name', 'Ljava/lang/String;') as JObject)).toBe('system');
    expect(jvm.getField(t, 'threadStatus', 'I')).toBe(5);
  });

  it('Thread.join wakes however the joiner is preempted between isAlive and wait', async () => {
    const thread = (n: string, d: string): { c: ['method', string, string, string] } => ({ c: ['method', 'java/lang/Thread', n, d] });
    jvm.loader.define(
      'JoinT',
      assembleClass(
        'JoinT',
        [
          { name: '<init>', desc: '()V', access: ACC_PUBLIC, code: [ALOAD_0, INVOKESPECIAL, thread('<init>', '()V'), RETURN] },
          { name: 'run', desc: '()V', access: ACC_PUBLIC, code: [RETURN] },
          {
            name: 'go',
            desc: '()V',
            // t = new JoinT(); t.start(); for (int i = n; i > 0; i--) {} t.join();
            code: [NEW, { c: ['class', 'JoinT'] }, DUP, INVOKESPECIAL, { c: ['method', 'JoinT', '<init>', '()V'] }, ASTORE_0, ALOAD_0,
              INVOKEVIRTUAL, thread('start', '()V'),
              GETSTATIC, { c: ['field', 'JoinT', 'n', 'I'] }, ISTORE_1, ILOAD_1, IFLE, 0, 9, IINC, 1, 0xff, GOTO, 0xff, 0xf9,
              ALOAD_0, INVOKEVIRTUAL, thread('join', '()V'), RETURN],
          },
        ],
        [['n', 'I']],
        'java/lang/Thread',
      ),
      null,
      null,
    );
    const cls = jvm.loader.loadBoot('JoinT')!;
    const n = cls.declaredField('n', 'I')!.slot;
    try {
      for (let slice = 1; slice <= 12; slice++) {
        for (let spin = 0; spin <= 80; spin++) {
          jvm.threads.slice = slice;
          cls.staticValues[n] = spin;
          await jvm.callStatic('JoinT', 'go', '()V');
        }
      }
    } finally {
      jvm.threads.slice = 10_000;
    }
  }, 60_000);

  it('puts a native method that throws at the top of the stack trace, as (Native Method)', async () => {
    jvm.loader.define(
      'NativeTop',
      assembleClass('NativeTop', [
        {
          name: 'copy',
          desc: '()Ljava/lang/Throwable;',
          code: [ICONST_1, NEWARRAY, T_INT, ICONST_0, ICONST_1, NEWARRAY, T_INT, ICONST_0, ICONST_5,
            INVOKESTATIC, { c: ['method', 'java/lang/System', 'arraycopy', '(Ljava/lang/Object;ILjava/lang/Object;II)V'] }, ACONST_NULL, ARETURN, ARETURN],
          handlers: [[0, 12, 14, 'java/lang/ArrayIndexOutOfBoundsException']],
        },
        {
          name: 'top',
          desc: '(Ljava/lang/Throwable;)Ljava/lang/StackTraceElement;',
          code: [ALOAD_0, INVOKEVIRTUAL, { c: ['method', 'java/lang/Throwable', 'getStackTrace', '()[Ljava/lang/StackTraceElement;'] }, ICONST_0, AALOAD, ARETURN],
        },
      ]),
      null,
      null,
    );
    const e = (await jvm.callStatic('NativeTop', 'copy', '()Ljava/lang/Throwable;')) as JObject;
    expect(e.cls.name).toBe('java/lang/ArrayIndexOutOfBoundsException');
    const top = (await jvm.callStatic('NativeTop', 'top', '(Ljava/lang/Throwable;)Ljava/lang/StackTraceElement;', [e])) as JObject;
    const text = (f: string): string | null => jvm.heap.jsString(jvm.getField(top, f, 'Ljava/lang/String;') as JObject | null);
    expect(text('declaringClass')).toBe('java.lang.System');
    expect(text('methodName')).toBe('arraycopy');
    expect(jvm.getField(top, 'lineNumber', 'I')).toBe(-2);
  });

  async function runMain(name: string): Promise<string> {
    out = '';
    err = '';
    const loader = jvm.loader;
    const args: JValue = jvm.heap.newArray(loader.arrayOf(loader.loadBoot('java/lang/String')!), 0);
    try {
      await jvm.callStatic(`conformance/${name}`, 'main', '([Ljava/lang/String;)V', [args]);
    } catch (e) {
      throw new Error(`${(e as Error).message}\nstdout so far:\n${out}\nstderr:\n${err}`);
    }
    return out;
  }

  it.each(['Arith', 'Arrays', 'Exceptions', 'Init', 'Strings', 'Collections', 'Reflect', 'Threads', 'Sorted', 'Rmi', 'FieldReflect'])(
    '%s prints what HotSpot prints',
    async (name) => {
      const expected = new TextDecoder().decode(file(`./conformance/${name}.out`));
      expect(await runMain(name)).toBe(expected);
    },
    60_000,
  );

  it('java.time, which uses lambdas inside the JDK, adds days to a date', async () => {
    const LDC2_W = 0x14, SIPUSH = 0x11, BIPUSH = 0x10;
    const date = (n: string, d: string): { c: ['method', string, string, string] } => ({ c: ['method', 'java/time/LocalDate', n, d] });
    jvm.loader.define(
      'Dates',
      assembleClass('Dates', [
        {
          name: 'go',
          desc: '()Ljava/lang/String;',
          code: [SIPUSH, 0x07, 0xea, BIPUSH, 10, BIPUSH, 15, INVOKESTATIC, date('of', '(III)Ljava/time/LocalDate;'),
            LDC2_W, { c: ['long', 30n] }, INVOKEVIRTUAL, date('plusDays', '(J)Ljava/time/LocalDate;'),
            INVOKEVIRTUAL, date('toString', '()Ljava/lang/String;'), ARETURN],
        },
      ]),
      null,
      null,
    );
    const start = performance.now();
    const s = (await jvm.callStatic('Dates', 'go', '()Ljava/lang/String;')) as JObject;
    console.log(`LocalDate took ${(performance.now() - start).toFixed(0)} ms`);
    expect(jvm.heap.jsString(s)).toBe('2026-11-14');
  }, 60_000);
});

// HotSpot ran the programs on the JDK's class path alone. With libbluray's jars, opening a file goes through its
// FileInputStream, whose Logger takes over System.out; Lambdas opens one (String.format reads currency.data).
describe('on the JDK class path alone', () => {
  it('Lambdas prints what HotSpot prints', async () => {
    let out = '';
    const jvm = bootedJvm((s) => (out += s), () => {}, [RT, file('./conformance.jar')]);
    const defined: string[] = [];
    const define = jvm.loader.define.bind(jvm.loader);
    const defineAnonymous = jvm.loader.defineAnonymous.bind(jvm.loader);
    jvm.loader.define = (name, bytes, loader, pd) => (defined.push(name), define(name, bytes, loader, pd));
    jvm.loader.defineAnonymous = (host, bytes, patches) => {
      const c = defineAnonymous(host, bytes, patches);
      defined.push(c.name);
      return c;
    };
    await jvm.boot();
    const loader = jvm.loader;
    const args: JValue = jvm.heap.newArray(loader.arrayOf(loader.loadBoot('java/lang/String')!), 0);
    const start = performance.now();
    await jvm.callStatic('conformance/Lambdas', 'main', '([Ljava/lang/String;)V', [args]);
    console.log(`Lambdas took ${(performance.now() - start).toFixed(0)} ms`);
    expect(out).toBe(new TextDecoder().decode(file('./conformance/Lambdas.out')));
    // LambdaForms are interpreted: no LambdaForm$ class is spun. BoundMethodHandle.Factory still spins the species
    // (plain data holders) that rt-bdj.jar lacks, with the JDK's ASM and Unsafe.defineClass; these are the ones Lambdas needs.
    const rt = ZipArchive.open(RT);
    const spun = (prefix: string): string[] => defined.filter((n) => n.startsWith(prefix) && !rt.read(`${n}.class`)).sort();
    expect(defined.some((n) => n.includes('$$Lambda$'))).toBe(true);
    expect(spun('java/lang/invoke/LambdaForm$')).toEqual([]);
    expect(spun('java/lang/invoke/BoundMethodHandle$Species_')).toEqual(
      ['L3', 'L4', 'LL'].map((s) => `java/lang/invoke/BoundMethodHandle$Species_${s}`),
    );
  }, 60_000);
});

/** Runs `main` of a class, returning what it printed; failures carry the output so far. */
async function runCapturing(jvm: Jvm, io: { out: string; err: string }, cls: string, name = 'main', desc = '([Ljava/lang/String;)V', args?: JValue[]): Promise<JValue | undefined> {
  io.out = '';
  io.err = '';
  try {
    return await jvm.callStatic(cls, name, desc, args ?? [jvm.heap.newArray(jvm.loader.arrayOf(jvm.bootClass('java/lang/String')), 0)]);
  } catch (e) {
    throw new Error(`${(e as Error).message}\nstdout so far:\n${io.out}\nstderr:\n${io.err}`);
  }
}

describe('I/O and zip on the JDK class path alone', () => {
  const io = { out: '', err: '' };
  let jvm: Jvm;

  beforeAll(async () => {
    jvm = bootedJvm((s) => (io.out += s), (s) => (io.err += s), [RT, file('./conformance.jar')]);
    await jvm.boot();
  }, 60_000);

  it.each(['Io', 'Zip', 'Threads', 'Urls', 'Net', 'Dates', 'Awt'])(
    '%s prints what HotSpot prints',
    async (name) => {
      await runCapturing(jvm, io, `conformance/${name}`);
      expect(io.out).toBe(new TextDecoder().decode(file(`./conformance/${name}.out`)));
    },
    60_000,
  );

  // HotSpot wrote under java.io.tmpdir; a disc writes under /persistent
  it('FileWriting prints what HotSpot prints, under /persistent', async () => {
    const args = jvm.heap.newArray(jvm.loader.arrayOf(jvm.bootClass('java/lang/String')), 1) as JArray;
    (args.data as JValue[])[0] = jvm.heap.newString('/persistent');
    await runCapturing(jvm, io, 'conformance/FileWriting', 'main', '([Ljava/lang/String;)V', [args]);
    expect(io.out).toBe(new TextDecoder().decode(file('./conformance/FileWriting.out')));
  }, 60_000);
});

// Ruling R20: AccessController.checkPermission under the JDK's policy file, as libbluray's BDJSecurityManager falls back
// on it. The program installs a security manager, so it has a JVM of its own.
describe('access control under a security manager', () => {
  it('Security prints what HotSpot prints', async () => {
    const io = { out: '', err: '' };
    const jvm = bootedJvm((s) => (io.out += s), (s) => (io.err += s), [RT, file('./conformance.jar')]);
    await jvm.boot();
    await runCapturing(jvm, io, 'conformance/Security');
    expect(io.out).toBe(new TextDecoder().decode(file('./conformance/Security.out')));
  }, 60_000);
});

// Green threads switch only between bytecodes, but they do switch inside java.util.concurrent's read-then-CAS loops,
// so a CAS can lose to another thread as on HotSpot. A one-bytecode slice runs the putters in lockstep, which makes
// ConcurrentHashMap.addCount lose its baseCount CAS every time and take the counter-cell path (fullAddCount), which
// seeds the thread's probe from ThreadLocalRandom. A disc's class loader hit it at random and its xlet failed to load.
describe('java.util.concurrent when threads race', () => {
  it('Concurrent prints what HotSpot prints, after its putters lost a CAS to each other', async () => {
    const io = { out: '', err: '' };
    const jvm = bootedJvm((s) => (io.out += s), (s) => (io.err += s), [RT, file('./conformance.jar')]);
    await jvm.boot();
    const slice = jvm.threads.slice;
    jvm.threads.slice = 1;
    try {
      await runCapturing(jvm, io, 'conformance/Concurrent');
    } finally {
      jvm.threads.slice = slice;
    }
    expect(io.err).toBe('');
    expect(io.out).toBe(new TextDecoder().decode(file('./conformance/Concurrent.out')));
    const cls = jvm.loader.loadBoot('conformance/Concurrent')!;
    const map = cls.staticValues[cls.findField('map', 'Ljava/util/concurrent/ConcurrentHashMap;')!.slot] as JObject;
    expect(jvm.getField(map, 'counterCells', '[Ljava/util/concurrent/ConcurrentHashMap$CounterCell;')).not.toBeNull();
  }, 60_000);
});

describe('URLClassLoader', () => {
  const io = { out: '', err: '' };
  let jvm: Jvm;
  let urlLoad: Uint8Array;

  function put(path: string, bytes: Uint8Array): void {
    const vfs = jvm.opts.vfs!;
    const h = vfs.open(path, 'w')!;
    expect(vfs.write(h, bytes, 0, bytes.length)).toBe(true);
    vfs.close(h);
  }

  beforeAll(async () => {
    jvm = bootedJvm((s) => (io.out += s), (s) => (io.err += s), [RT]);
    await jvm.boot();
    const LDC_W = 0x13, ANEWARRAY = 0xbd, AASTORE = 0x53, POP = 0x57, IF_ACMPNE = 0xa6, IRETURN = 0xac;
    const ALOAD_1 = 0x2b, ASTORE_2 = 0x4d, ALOAD_2 = 0x2c, ASTORE_3 = 0x4e, ALOAD_3 = 0x2d;
    const m = (c: string, n: string, d: string): { c: ['method', string, string, string] } => ({ c: ['method', c, n, d] });
    urlLoad = assembleClass('UrlLoad', [
        {
          name: 'go',
          desc: '(Ljava/lang/String;Ljava/lang/String;)Z',
          maxStack: 10,
          // URLClassLoader l = new URLClassLoader(new URL[] { new URL(url) });
          // Class c = l.loadClass(name); c.getMethod("main", String[].class).invoke(null, new Object[] { new String[0] });
          // return c.getClassLoader() == l;
          code: [
            NEW, { c: ['class', 'java/net/URLClassLoader'] }, DUP, ICONST_1, ANEWARRAY, { c: ['class', 'java/net/URL'] }, DUP, ICONST_0,
            NEW, { c: ['class', 'java/net/URL'] }, DUP, ALOAD_0, INVOKESPECIAL, m('java/net/URL', '<init>', '(Ljava/lang/String;)V'),
            AASTORE, INVOKESPECIAL, m('java/net/URLClassLoader', '<init>', '([Ljava/net/URL;)V'), ASTORE_2,
            ALOAD_2, ALOAD_1, INVOKEVIRTUAL, m('java/lang/ClassLoader', 'loadClass', '(Ljava/lang/String;)Ljava/lang/Class;'), ASTORE_3,
            ALOAD_3, LDC_W, { c: ['string', 'main'] }, ICONST_1, ANEWARRAY, { c: ['class', 'java/lang/Class'] }, DUP, ICONST_0,
            LDC_W, { c: ['class', '[Ljava/lang/String;'] }, AASTORE,
            INVOKEVIRTUAL, m('java/lang/Class', 'getMethod', '(Ljava/lang/String;[Ljava/lang/Class;)Ljava/lang/reflect/Method;'),
            ACONST_NULL, ICONST_1, ANEWARRAY, { c: ['class', 'java/lang/Object'] }, DUP, ICONST_0, ICONST_0, ANEWARRAY, { c: ['class', 'java/lang/String'] }, AASTORE,
            INVOKEVIRTUAL, m('java/lang/reflect/Method', 'invoke', '(Ljava/lang/Object;[Ljava/lang/Object;)Ljava/lang/Object;'), POP,
            ALOAD_3, INVOKEVIRTUAL, m('java/lang/Class', 'getClassLoader', '()Ljava/lang/ClassLoader;'), ALOAD_2, IF_ACMPNE, 0, 5, ICONST_1, IRETURN, ICONST_0, IRETURN,
          ],
        },
      ]);
    jvm.loader.define('UrlLoad', urlLoad, null, null);
  }, 60_000);

  const go = (url: string, name: string): Promise<JValue | undefined> =>
    runCapturing(jvm, io, 'UrlLoad', 'go', '(Ljava/lang/String;Ljava/lang/String;)Z', [jvm.heap.newString(url), jvm.heap.newString(name)]);

  it('loads classes from a jar in /tmp/, defines them itself and runs them as HotSpot does', async () => {
    put('/tmp/loaded.jar', file('./conformance.jar'));
    for (const name of ['Init', 'Exceptions']) {
      expect(await go('file:/tmp/loaded.jar', `conformance.${name}`)).toBe(1);
      expect(io.out).toBe(new TextDecoder().decode(file(`./conformance/${name}.out`)));
    }
  }, 120_000);

  it('throws ClassCircularityError for a class that is its own superclass through the loader', async () => {
    put('/tmp/circular.jar', storedZip([
      ['circ/A.class', assembleClass('circ/A', [], [], 'circ/B')],
      ['circ/B.class', assembleClass('circ/B', [], [], 'circ/A')],
    ]));
    await expect(go('file:/tmp/circular.jar', 'circ.A')).rejects.toThrow(/^java\.lang\.ClassCircularityError: circ\/A$/m);
  }, 60_000);

  it('reads a jar on the disc, whose reads suspend the thread', async () => {
    const disc = bootedJvm((s) => (io.out += s), (s) => (io.err += s), [RT], new Map([['BDMV/JAR/00000.JAR', new Uint8Array(file('./conformance.jar'))]]));
    await disc.boot();
    disc.loader.define('UrlLoad', urlLoad, null, null);
    const same = await runCapturing(disc, io, 'UrlLoad', 'go', '(Ljava/lang/String;Ljava/lang/String;)Z', [
      disc.heap.newString('file:/disc/BDMV/JAR/00000.jar'),
      disc.heap.newString('conformance.Arith'),
    ]);
    expect(same).toBe(1);
    expect(io.out).toBe(new TextDecoder().decode(file('./conformance/Arith.out')));
  }, 60_000);
});

describe('java.util.zip streams', () => {
  it('inflate zlib and gzip data fed seven bytes at a time, as zlib produced it', async () => {
    const jvm = bootedJvm(() => {}, () => {}, [RT]);
    await jvm.boot();
    const BIPUSH = 0x10, NEWARRAY = 0xbc, T_BYTE = 8, ASTORE_1 = 0x4c, ALOAD_1 = 0x2b, ASTORE_2 = 0x4d, ALOAD_2 = 0x2c;
    const ISTORE_3 = 0x3e, ILOAD_3 = 0x1d, IFLE = 0x9e, GOTO = 0xa7, ARETURN = 0xb0;
    const m = (c: string, n: string, d: string): { c: ['method', string, string, string] } => ({ c: ['method', c, n, d] });
    const k = (c: string): { c: ['class', string] } => ({ c: ['class', c] });
    const bais = [NEW, k('java/io/ByteArrayInputStream'), DUP, ALOAD_0, INVOKESPECIAL, m('java/io/ByteArrayInputStream', '<init>', '([B)V')];
    jvm.loader.define(
      'Streams',
      assembleClass('Streams', [
        {
          // new InflaterInputStream(new ByteArrayInputStream(b), new Inflater(), 7)
          name: 'zlib',
          desc: '([B)Ljava/io/InputStream;',
          code: [NEW, k('java/util/zip/InflaterInputStream'), DUP, ...bais, NEW, k('java/util/zip/Inflater'), DUP, INVOKESPECIAL, m('java/util/zip/Inflater', '<init>', '()V'),
            BIPUSH, 7, INVOKESPECIAL, m('java/util/zip/InflaterInputStream', '<init>', '(Ljava/io/InputStream;Ljava/util/zip/Inflater;I)V'), ARETURN],
        },
        {
          // new GZIPInputStream(new ByteArrayInputStream(b), 7)
          name: 'gzip',
          desc: '([B)Ljava/io/InputStream;',
          code: [NEW, k('java/util/zip/GZIPInputStream'), DUP, ...bais, BIPUSH, 7, INVOKESPECIAL, m('java/util/zip/GZIPInputStream', '<init>', '(Ljava/io/InputStream;I)V'), ARETURN],
        },
        {
          // ByteArrayOutputStream out = new ...; byte[] buf = new byte[13]; int n; while ((n = in.read(buf)) > 0) out.write(buf, 0, n);
          name: 'drain',
          desc: '(Ljava/io/InputStream;)[B',
          code: [NEW, k('java/io/ByteArrayOutputStream'), DUP, INVOKESPECIAL, m('java/io/ByteArrayOutputStream', '<init>', '()V'), ASTORE_1,
            BIPUSH, 13, NEWARRAY, T_BYTE, ASTORE_2,
            ALOAD_0, ALOAD_2, INVOKEVIRTUAL, m('java/io/InputStream', 'read', '([B)I'), DUP, ISTORE_3, IFLE, 0, 13,
            ALOAD_1, ALOAD_2, ICONST_0, ILOAD_3, INVOKEVIRTUAL, m('java/io/ByteArrayOutputStream', 'write', '([BII)V'), GOTO, 0xff, 0xef,
            ALOAD_1, INVOKEVIRTUAL, m('java/io/ByteArrayOutputStream', 'toByteArray', '()[B'), ARETURN],
        },
      ]),
      null,
      null,
    );
    const data = new Uint8Array(40_000);
    for (let i = 0, x = 1; i < data.length; i++) data[i] = i % 3000 < 1500 ? (x = (x * 1103515245 + 12345) >>> 0) >>> 24 : 65 + (i % 7);
    for (const [name, packed] of [['zlib', deflateSync(data)], ['gzip', gzipSync(data)]] as const) {
      const stream = await jvm.callStatic('Streams', name, '([B)Ljava/io/InputStream;', [byteArray(jvm, packed)]);
      const out = (await jvm.callStatic('Streams', 'drain', '(Ljava/io/InputStream;)[B', [stream!])) as JArray;
      expect(new Uint8Array((out.data as Int8Array).buffer)).toEqual(data);
    }
  }, 60_000);
});

describe('java.io paths and failures', () => {
  const ASTORE_1 = 0x4c, ALOAD_1 = 0x2b, POP = 0x57, ARETURN = 0xb0, LDC_W = 0x13, IRETURN = 0xac;
  const m = (c: string, n: string, d: string): { c: ['method', string, string, string] } => ({ c: ['method', c, n, d] });
  const caught = [ASTORE_1, ALOAD_1, INVOKEVIRTUAL, m('java/lang/Throwable', 'toString', '()Ljava/lang/String;'), ARETURN];
  const fileTest = (name: string): AsmMethod => ({
    name,
    desc: '(Ljava/lang/String;)Z',
    code: [NEW, { c: ['class', 'java/io/File'] }, DUP, ALOAD_0, INVOKESPECIAL, m('java/io/File', '<init>', '(Ljava/lang/String;)V'),
      INVOKEVIRTUAL, m('java/io/File', name, '()Z'), IRETURN],
  });
  const probe = assembleClass('FsProbe', [
    {
      // try { new FileInputStream(path); return "opened"; } catch (FileNotFoundException e) { return e.getMessage(); }
      name: 'open',
      desc: '(Ljava/lang/String;)Ljava/lang/String;',
      code: [
        NEW, { c: ['class', 'java/io/FileInputStream'] }, DUP, ALOAD_0, INVOKESPECIAL, m('java/io/FileInputStream', '<init>', '(Ljava/lang/String;)V'), POP,
        LDC_W, { c: ['string', 'opened'] }, ARETURN,
        ASTORE_1, ALOAD_1, INVOKEVIRTUAL, m('java/lang/Throwable', 'getMessage', '()Ljava/lang/String;'), ARETURN,
      ],
      handlers: [[0, 9, 13, 'java/io/FileNotFoundException']],
    },
    {
      // try { new FileInputStream(path).read(); return "read"; } catch (IOException e) { return e.toString(); }
      name: 'read',
      desc: '(Ljava/lang/String;)Ljava/lang/String;',
      code: [
        NEW, { c: ['class', 'java/io/FileInputStream'] }, DUP, ALOAD_0, INVOKESPECIAL, m('java/io/FileInputStream', '<init>', '(Ljava/lang/String;)V'),
        INVOKEVIRTUAL, m('java/io/FileInputStream', 'read', '()I'), POP, LDC_W, { c: ['string', 'read'] }, ARETURN, ...caught,
      ],
      handlers: [[0, 12, 16, 'java/io/IOException']],
    },
    {
      // try { new ZipFile(path); return "opened"; } catch (IOException e) { return e.toString(); }
      name: 'zip',
      desc: '(Ljava/lang/String;)Ljava/lang/String;',
      code: [
        NEW, { c: ['class', 'java/util/zip/ZipFile'] }, DUP, ALOAD_0, INVOKESPECIAL, m('java/util/zip/ZipFile', '<init>', '(Ljava/lang/String;)V'), POP,
        LDC_W, { c: ['string', 'opened'] }, ARETURN, ...caught,
      ],
      handlers: [[0, 9, 13, 'java/io/IOException']],
    },
    fileTest('isDirectory'),
    fileTest('exists'),
  ]);

  let lastProbe: Jvm | null = null;
  async function probing(discFiles?: ReadonlyMap<string, Uint8Array<ArrayBuffer>>, failRead?: (path: string) => boolean) {
    const jvm = bootedJvm(() => {}, () => {}, [RT], discFiles, failRead);
    lastProbe = jvm;
    await jvm.boot();
    jvm.loader.define('FsProbe', probe, null, null);
    const call = async (fn: string, p: string): Promise<JValue | string | null | undefined> => {
      const desc = fn === 'isDirectory' || fn === 'exists' ? '(Ljava/lang/String;)Z' : '(Ljava/lang/String;)Ljava/lang/String;';
      const r = await jvm.callStatic('FsProbe', fn, desc, [jvm.heap.newString(p)]);
      return desc.endsWith('Z') ? r : jvm.heap.jsString(r as JObject | null);
    };
    return call;
  }

  it('resolves relative paths against user.dir and reports directories and the empty path as the JDK does', async () => {
    const call = await probing();
    expect(await call('open', '/tmp')).toBe('/tmp (Is a directory)');
    expect(await call('open', '/tmp/none')).toBe('/tmp/none (No such file or directory)');
    expect(await call('open', '')).toBe(' (No such file or directory)');
    expect(await call('open', 'jdk/lib/currency.data')).toBe('opened');
    expect(await call('isDirectory', 'tmp')).toBe(1);
    expect(await call('isDirectory', 'jdk/lib')).toBe(1);
    expect(await call('isDirectory', 'nope')).toBe(0);
    expect(await call('exists', '')).toBe(0);
    expect(await call('isDirectory', '')).toBe(0);
  }, 60_000);

  it('turns a failed disc read into an IOException in the reading thread', async () => {
    const files = new Map([
      ['BDMV/JAR/00000.JAR', new Uint8Array(file('./conformance.jar'))],
      ['BDMV/JAR/00001.JAR', new Uint8Array(file('./conformance.jar'))],
    ]);
    const call = await probing(files, (p) => p.endsWith('00001.JAR'));
    expect(await call('read', '/disc/BDMV/JAR/00001.jar')).toBe('java.io.IOException: file was removed');
    // As in the JDK: a read error during ZipFile.open sets no zip_util message, so open throws its generic ZipException.
    expect(await call('zip', '/disc/BDMV/JAR/00001.jar')).toBe('java.util.zip.ZipException: error in opening zip file');
    expect(await call('read', '/disc/BDMV/JAR/00000.jar')).toBe('read');
    expect(await call('zip', '/disc/BDMV/JAR/00000.jar')).toBe('opened');
  }, 60_000);
  it('shares one archive among ZipFiles of an unchanged file, as zip_util does, read from the Vfs without a copy', async () => {
    const jar = new Uint8Array(file('./conformance.jar'));
    const call = await probing(new Map([['BDMV/JAR/00000.JAR', jar]]));
    const jvm = lastProbe!;
    const vfs = jvm.opts.vfs!;
    const put = (path: string, bytes: Uint8Array): void => {
      const h = vfs.open(path, 'w')!;
      vfs.write(h, bytes, 0, bytes.length);
      vfs.close(h);
    };
    // a disc file is read once, into a copy of the zips' own
    expect(await call('zip', '/disc/BDMV/JAR/00000.jar')).toBe('opened');
    expect(await call('zip', '/disc/BDMV/JAR/00000.jar')).toBe('opened');
    expect(jvm.memoryStats()).toMatchObject({ zipHandles: 1, zipBytes: jar.length });
    // a memory file is read in place
    put('/tmp/a.jar', jar);
    expect(await call('zip', '/tmp/a.jar')).toBe('opened');
    expect(await call('zip', '/tmp/a.jar')).toBe('opened');
    expect(jvm.memoryStats()).toMatchObject({ zipHandles: 2, zipBytes: jar.length, vfsBytes: jar.length }); // the shared bytes count once
    // rewritten, it is a new file: the open archive keeps the old bytes, which are now its own
    put('/tmp/a.jar', jar);
    expect(await call('zip', '/tmp/a.jar')).toBe('opened');
    expect(jvm.memoryStats()).toMatchObject({ zipHandles: 3, zipBytes: 2 * jar.length, vfsBytes: jar.length, vfsUsedBytes: jar.length });
  }, 60_000);
});

describe('Runtime.halt', () => {
  it('ends every thread at once and exposes the exit status', async () => {
    const jvm = bootedJvm();
    await jvm.boot();
    const start = performance.now();
    await jvm.callStatic('java/lang/Shutdown', 'halt', '(I)V', [3]);
    expect(performance.now() - start).toBeLessThan(1000);
    expect(jvm.exitStatus).toBe(3);
    expect(jvm.threads.live).toEqual([]);
    expect(await jvm.threads.run()).toBe('idle');
  }, 30_000);
});
