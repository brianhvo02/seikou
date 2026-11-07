import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { Jvm } from '../../src/bdj/jvm/jvm';
import type { JObject } from '../../src/bdj/jvm/values';
import { byteArray } from '../../src/bdj/jvm/natives/util';
import { Vfs } from '../../src/bdj/jvm/vfs';
import { ZipArchive } from '../../src/bdj/jvm/zip';
import { assembleClass } from '../../tests/helpers/jvm-asm';
import { gapExempt } from './classify';
import { trackGaps, type GapTracker } from './gaps';

const file = (rel: string): Uint8Array => new Uint8Array(readFileSync(fileURLToPath(new URL(rel, import.meta.url))));
const RT = file('../../src/bdj-classlib/rt-bdj.jar');
const BOOT = [file('../../src/bdj-classlib/libbluray-j2se.jar'), file('../../src/bdj-classlib/libbluray-awt-j2se.jar'), RT];

const NEW = 0xbb, DUP = 0x59, LDC_W = 0x13, INVOKESPECIAL = 0xb7, INVOKESTATIC = 0xb8, INVOKEVIRTUAL = 0xb6;
const POP = 0x57, RETURN = 0xb1, ALOAD_0 = 0x2a, ALOAD_1 = 0x2b, ACONST_NULL = 0x01, ICONST_0 = 0x03, ANEWARRAY = 0xbd;
const ARRAYLENGTH = 0xbe, ARETURN = 0xb0;

/** Platform code (the boot loader): asks java.net.URL for an https handler, which the class library lacks. */
const PROBE = assembleClass('Probe', [
  {
    name: 'url',
    desc: '()V',
    code: [
      NEW, { c: ['class', 'java/net/URL'] }, DUP, LDC_W, { c: ['string', 'https://example.invalid/'] },
      INVOKESPECIAL, { c: ['method', 'java/net/URL', '<init>', '(Ljava/lang/String;)V'] }, POP, RETURN,
      POP, RETURN,
    ],
    handlers: [[0, 11, 12, 'java/net/MalformedURLException']],
  },
  {
    // runs a disc class's static find() through reflection, as the platform calls an xlet
    name: 'call',
    desc: '(Ljava/lang/Class;)V',
    code: [
      ALOAD_0, LDC_W, { c: ['string', 'find'] }, ICONST_0, ANEWARRAY, { c: ['class', 'java/lang/Class'] },
      INVOKEVIRTUAL, { c: ['method', 'java/lang/Class', 'getMethod', '(Ljava/lang/String;[Ljava/lang/Class;)Ljava/lang/reflect/Method;'] },
      ACONST_NULL, ICONST_0, ANEWARRAY, { c: ['class', 'java/lang/Object'] },
      INVOKEVIRTUAL, { c: ['method', 'java/lang/reflect/Method', 'invoke', '(Ljava/lang/Object;[Ljava/lang/Object;)Ljava/lang/Object;'] },
      POP, RETURN,
    ],
  },
  {
    // defines a class in a disc's class loader, as libbluray's BDJClassLoader does
    name: 'define',
    desc: '(Ljava/lang/ClassLoader;[B)Ljava/lang/Class;',
    code: [
      INVOKESTATIC, { c: ['method', 'sun/misc/Unsafe', 'getUnsafe', '()Lsun/misc/Unsafe;'] },
      LDC_W, { c: ['string', 'Disc'] }, ALOAD_1, ICONST_0, ALOAD_1, ARRAYLENGTH, ALOAD_0, ACONST_NULL,
      INVOKEVIRTUAL, { c: ['method', 'sun/misc/Unsafe', 'defineClass', '(Ljava/lang/String;[BIILjava/lang/ClassLoader;Ljava/security/ProtectionDomain;)Ljava/lang/Class;'] },
      ARETURN,
    ],
  },
]);

/** The disc's code (a class loader of its own): looks up a platform class that does not exist and catches the miss. */
const DISC = assembleClass('Disc', [
  {
    name: 'find',
    desc: '()V',
    code: [
      LDC_W, { c: ['string', 'javax.nope.Missing'] },
      INVOKESTATIC, { c: ['method', 'java/lang/Class', 'forName', '(Ljava/lang/String;)Ljava/lang/Class;'] }, POP, RETURN,
      POP, RETURN,
    ],
    handlers: [[0, 7, 8, 'java/lang/ClassNotFoundException']],
  },
]);

describe('gap throwables followed as they unwind (Ruling R13)', () => {
  let jvm: Jvm;
  let tracker: GapTracker | null = null;

  beforeAll(async () => {
    jvm = new Jvm({
      bootJars: BOOT,
      nowMs: () => Date.now(),
      setTimer: (ms, fn) => {
        const id = setTimeout(fn, ms);
        return () => clearTimeout(id);
      },
      stdout: () => {},
      stderr: () => {},
      vfs: new Vfs({ disc: null, jdkLib: ZipArchive.open(RT), nowMs: () => Date.now() }),
      systemProperties: new Map([['awt.toolkit', 'java.awt.BDToolkit']]),
    });
    await jvm.boot();
    jvm.loader.define('Probe', PROBE, null, null);
  }, 60_000);

  afterEach(() => {
    tracker?.stop();
    tracker = null;
  });

  it("the https handler lookup that java.net.URL drops is exempt: it dies in platform code", async () => {
    tracker = trackGaps();
    await jvm.callStatic('Probe', 'url', '()V');
    const { all, counted } = tracker.gaps();
    expect(all).toContain('sun.net.www.protocol.https.Handler');
    expect(counted).not.toContain('sun.net.www.protocol.https.Handler');
  });

  it('a ClassNotFoundException that platform code catches and rethrows into the disc still counts', async () => {
    const loader = (await jvm.callStatic('java/lang/ClassLoader', 'getSystemClassLoader', '()Ljava/lang/ClassLoader;')) as JObject;
    const disc = (await jvm.callStatic('Probe', 'define', '(Ljava/lang/ClassLoader;[B)Ljava/lang/Class;', [loader, byteArray(jvm, DISC)])) as JObject;
    tracker = trackGaps();
    // ClassLoader.loadClass catches the parent's miss (a catch-all for its synchronized block, and a typed catch), then
    // findClass throws the CNFE that reaches Disc.find, which catches it
    await jvm.callStatic('Probe', 'call', '(Ljava/lang/Class;)V', [disc]);
    const { all, counted } = tracker.gaps();
    expect(all).toContain('javax.nope.Missing');
    expect(counted).toContain('javax.nope.Missing');
  });
});

describe('gapExempt', () => {
  const P = { platform: true } as const;
  const D = { platform: false } as const;
  const CNFE = 'java/lang/ClassNotFoundException';
  it('exempts a ClassNotFoundException only when every method it unwound into is the platform', () => {
    expect(gapExempt(CNFE, [P, P, P])).toBe(true);
    // caught, rethrown, caught again, all in platform code (a finally, a catch-and-rethrow)
    expect(gapExempt(CNFE, [P, P, P, P])).toBe(true);
    // it reached the disc, caught there or not
    expect(gapExempt(CNFE, [P, P, D])).toBe(false);
    expect(gapExempt(CNFE, [P, D, P])).toBe(false);
    // it ended its thread
    expect(gapExempt(CNFE, [P, P, 'uncaught'])).toBe(false);
    // a linkage error is never exempt
    expect(gapExempt('java/lang/NoClassDefFoundError', [P])).toBe(false);
  });
});
