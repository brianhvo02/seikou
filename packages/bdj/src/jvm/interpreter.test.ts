import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { execute } from './interpreter';
import { Jvm } from './jvm';
import { VirtualClock, assembleClass } from '../../../../tests/helpers/jvm-asm';
import type { AsmMethod } from '../../../../tests/helpers/jvm-asm';

const jar = (rel: string): Uint8Array => readFileSync(fileURLToPath(new URL(rel, import.meta.url)));
const BOOT = [
  jar('../../../bdj-classlib/libbluray-j2se.jar'),
  jar('../../../bdj-classlib/libbluray-awt-j2se.jar'),
  jar('../../../bdj-classlib/rt-bdj.jar'),
];

const newJvm = (): Jvm => {
  const clock = new VirtualClock();
  return new Jvm({ bootJars: BOOT, nowMs: clock.nowMs, setTimer: clock.setTimer, stdout: () => {}, stderr: () => {} });
};

/** Defines a class `T` with one static method `m` and calls it. */
async function run1(desc: string, code: AsmMethod['code'], maxLocals?: number): Promise<unknown> {
  const jvm = newJvm();
  jvm.loader.define('T', assembleClass('T', [{ name: 'm', desc, code, maxLocals }]), null, null);
  return jvm.callStatic('T', 'm', desc);
}

const ICONST_M1 = 0x02, ICONST_0 = 0x03, ICONST_1 = 0x04, FCONST_1 = 0x0c, BIPUSH = 0x10, LDC_W = 0x13, LDC2_W = 0x14;
const IDIV = 0x6c, LDIV = 0x6d, ISHL = 0x78, LUSHR = 0x7d, F2I = 0x8b, D2L = 0x8f, FCMPL = 0x95, FCMPG = 0x96;
const IADD = 0x60, POP = 0x57, DUP = 0x59, IRETURN = 0xac, LRETURN = 0xad, RETURN = 0xb1, ATHROW = 0xbf;
const GETSTATIC = 0xb2, PUTSTATIC = 0xb3, INVOKESPECIAL = 0xb7, INVOKESTATIC = 0xb8, NEW = 0xbb;

describe('interpreter arithmetic (Review Focus 5)', () => {
  it('idiv by zero throws ArithmeticException', async () => {
    await expect(run1('()I', [ICONST_1, ICONST_0, IDIV, IRETURN])).rejects.toThrow('java.lang.ArithmeticException: / by zero');
  });
  it('Integer.MIN_VALUE / -1 wraps', async () => {
    expect(await run1('()I', [LDC_W, { c: ['int', -2147483648] }, ICONST_M1, IDIV, IRETURN])).toBe(-2147483648);
  });
  it('Long.MIN_VALUE / -1L wraps', async () => {
    expect(await run1('()J', [LDC2_W, { c: ['long', -(2n ** 63n)] }, LDC2_W, { c: ['long', -1n] }, LDIV, LRETURN])).toBe(-(2n ** 63n));
  });
  it('f2i saturates and maps NaN to 0', async () => {
    expect(await run1('()I', [LDC_W, { c: ['float', NaN] }, F2I, IRETURN])).toBe(0);
    expect(await run1('()I', [LDC_W, { c: ['float', 1e20] }, F2I, IRETURN])).toBe(2147483647);
  });
  it('d2l of -1e30 is Long.MIN_VALUE', async () => {
    expect(await run1('()J', [LDC2_W, { c: ['double', -1e30] }, D2L, LRETURN])).toBe(-(2n ** 63n));
  });
  it('shifts mask the distance', async () => {
    expect(await run1('()I', [ICONST_1, BIPUSH, 33, ISHL, IRETURN])).toBe(2);
    expect(await run1('()J', [LDC2_W, { c: ['long', -1n] }, BIPUSH, 60, LUSHR, LRETURN])).toBe(15n);
  });
  it('fcmpl and fcmpg differ on NaN', async () => {
    expect(await run1('()I', [LDC_W, { c: ['float', NaN] }, FCONST_1, FCMPL, IRETURN])).toBe(-1);
    expect(await run1('()I', [LDC_W, { c: ['float', NaN] }, FCONST_1, FCMPG, IRETURN])).toBe(1);
  });
});

describe('stack overflow (Review Focus 2)', () => {
  const depth = { c: ['field', 'R', 'depth', 'I'] } as const;
  const self = { c: ['method', 'R', 'r', '()V'] } as const;
  const cls = (): Uint8Array => assembleClass('R', [
    { name: 'r', desc: '()V', code: [GETSTATIC, depth, ICONST_1, IADD, PUTSTATIC, depth, INVOKESTATIC, self, RETURN] },
    { name: 'depth', desc: '()I', code: [GETSTATIC, depth, IRETURN] },
    { name: 'caught', desc: '()I', code: [INVOKESTATIC, self, ICONST_0, IRETURN, POP, ICONST_1, IRETURN], handlers: [[0, 3, 5, 'java/lang/StackOverflowError']] },
  ], [['depth', 'I']]);

  it('ends the thread with StackOverflowError at depth 4,000', async () => {
    const jvm = newJvm();
    jvm.loader.define('R', cls(), null, null);
    await expect(jvm.callStatic('R', 'r', '()V')).rejects.toThrow(/^java\.lang\.StackOverflowError$/);
    expect(await jvm.callStatic('R', 'depth', '()I')).toBe(4000);
  });
  it('is catchable in Java', async () => {
    const jvm = newJvm();
    jvm.loader.define('R', cls(), null, null);
    expect(await jvm.callStatic('R', 'caught', '()I')).toBe(1);
  });
});

describe('failing class initialiser (Review Focus 4)', () => {
  it('throws ExceptionInInitializerError once, then NoClassDefFoundError, and the class is erroneous', async () => {
    const jvm = newJvm();
    const rte = 'java/lang/RuntimeException';
    jvm.loader.define('Bad', assembleClass('Bad', [
      { name: '<clinit>', desc: '()V', code: [NEW, { c: ['class', rte] }, DUP, INVOKESPECIAL, { c: ['method', rte, '<init>', '()V'] }, ATHROW] },
    ], [['x', 'I']]), null, null);
    jvm.loader.define('U', assembleClass('U', [{ name: 'get', desc: '()I', code: [GETSTATIC, { c: ['field', 'Bad', 'x', 'I'] }, IRETURN] }]), null, null);
    await expect(jvm.callStatic('U', 'get', '()I')).rejects.toThrow(/^java\.lang\.ExceptionInInitializerError$/);
    await expect(jvm.callStatic('U', 'get', '()I')).rejects.toThrow('java.lang.NoClassDefFoundError: Could not initialize class Bad');
    expect(jvm.loader.loadBoot('Bad')?.state).toBe('erroneous');
  });
});

describe('class initialisation order (JVM §5.5)', () => {
  it('marks the class initialising before its superclass, so the superclass sees its default statics', async () => {
    const jvm = newJvm();
    const px = { c: ['field', 'P', 'x', 'I'] } as const;
    const cy = { c: ['field', 'C', 'y', 'I'] } as const;
    jvm.loader.define('P', assembleClass('P', [
      { name: '<clinit>', desc: '()V', code: [GETSTATIC, cy, PUTSTATIC, px, RETURN] },
      { name: 'x', desc: '()I', code: [GETSTATIC, px, IRETURN] },
    ], [['x', 'I']]), null, null);
    jvm.loader.define('C', assembleClass('C', [
      { name: '<clinit>', desc: '()V', code: [BIPUSH, 5, PUTSTATIC, cy, RETURN] },
      { name: 'y', desc: '()I', code: [GETSTATIC, cy, IRETURN] },
    ], [['y', 'I']], 'P'), null, null);
    expect(await jvm.callStatic('C', 'y', '()I')).toBe(5);
    expect(await jvm.callStatic('P', 'x', '()I')).toBe(0);
  });
});

describe('conversions', () => {
  it('l2f rounds once, not through double', async () => {
    const L2F = 0x89, FRETURN = 0xae;
    expect(await run1('()F', [LDC2_W, { c: ['long', 2n ** 60n + 2n ** 36n + 1n] }, L2F, FRETURN])).toBe(2 ** 60 + 2 ** 37);
  });
});

describe('time slice', () => {
  it('execute returns budget on a spinning thread and keeps its place', () => {
    const jvm = newJvm();
    jvm.loader.define('S', assembleClass('S', [{ name: 'spin', desc: '()V', code: [0xa7, 0, 0] }]), null, null);
    const t = jvm.threads.spawn(null, jvm.loader.loadBoot('S')!.methods.get('spin()V')!, []);
    expect(execute(jvm, t, 1000)).toBe('budget');
    expect(t.frames.length).toBe(1);
    expect(t.frames[0]!.pc).toBe(0);
  });
});
