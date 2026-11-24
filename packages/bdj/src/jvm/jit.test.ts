import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { execute } from './interpreter';
import type { Frame } from './interpreter';
import { analyse } from './jit';
import { Jvm } from './jvm';
import type { JitMode, StackTrace } from './jvm';
import { VirtualClock, assembleClass } from '../../../../tests/helpers/jvm-asm';
import type { AsmMethod } from '../../../../tests/helpers/jvm-asm';

const jar = (rel: string): Uint8Array => readFileSync(fileURLToPath(new URL(rel, import.meta.url)));
const BOOT = [jar('../../../bdj-classlib/rt-bdj.jar')];

const newJvm = (jit: JitMode, warn?: (line: string) => void): Jvm => {
  const clock = new VirtualClock();
  return new Jvm({ bootJars: BOOT, nowMs: clock.nowMs, setTimer: clock.setTimer, stdout: () => {}, stderr: () => {}, jit, ...(warn ? { warn } : {}) });
};

// static int loop(int n) { int s = 0; for (int i = 0; i < n; i++) s += i ^ (s >>> 3); return s; }
const LOOP: AsmMethod = {
  name: 'loop',
  desc: '(I)I',
  code: [0x03, 0x3c, 0x03, 0x3d, 0x1c, 0x1a, 0xa2, 0, 17, 0x1b, 0x1c, 0x1b, 0x06, 0x7c, 0x82, 0x60, 0x3c, 0x84, 2, 1, 0xa7, 0xff, 0xf0, 0x1b, 0xac],
  maxStack: 4,
  maxLocals: 3,
};
// static int safeDiv(int a, int b) { try { return a / b; } catch (ArithmeticException e) { return -7; } }
const SAFE_DIV: AsmMethod = {
  name: 'safeDiv',
  desc: '(II)I',
  code: [0x1a, 0x1b, 0x6c, 0xac, 0x4c, 0x10, 0xf9, 0xac],
  maxStack: 2,
  maxLocals: 2,
  handlers: [[0, 4, 4, 'java/lang/ArithmeticException']],
};
// static int callsDiv(int a) { return safeDiv(a, 0) + safeDiv(a, 2) + quot(a, 0); } with quot throwing to its caller
const QUOT: AsmMethod = { name: 'quot', desc: '(II)I', code: [0x1a, 0x1b, 0x6c, 0xac], maxStack: 2, maxLocals: 2 };
const CALLER: AsmMethod = {
  name: 'caller',
  desc: '(I)I',
  // try { return safeDiv(a, 0) + safeDiv(a, 2) + quot(a, 0); } catch (ArithmeticException e) { return 99; }
  code: [
    0x1a, 0x03, 0xb8, { c: ['method', 'T', 'safeDiv', '(II)I'] },
    0x1a, 0x05, 0xb8, { c: ['method', 'T', 'safeDiv', '(II)I'] }, 0x60,
    0x1a, 0x03, 0xb8, { c: ['method', 'T', 'quot', '(II)I'] }, 0x60, 0xac,
    0x4c, 0x10, 99, 0xac,
  ],
  maxStack: 3,
  maxLocals: 2,
  handlers: [[0, 18, 18, 'java/lang/ArithmeticException']],
};
// static int jsr() { jsr L; iconst_1; ireturn; L: astore_0; ret 0 } : a method with a subroutine stays interpreted
const JSR: AsmMethod = { name: 'jsr', desc: '()I', code: [0xa8, 0, 5, 0x04, 0xac, 0x4b, 0xa9, 0], maxStack: 1, maxLocals: 1 };

function define(jvm: Jvm): void {
  jvm.loader.define('T', assembleClass('T', [LOOP, SAFE_DIV, QUOT, CALLER, JSR]), null, null);
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('the JIT', () => {
  it('finds the stack depth before each instruction and the blocks', () => {
    const jvm = newJvm('off');
    define(jvm);
    const a = analyse(jvm.loader.loadBoot('T')!.methods.get('loop(I)I')!);
    expect(a.starts).toEqual([0, 1, 2, 3, 4, 5, 6, 9, 10, 11, 12, 13, 14, 15, 16, 17, 20, 23, 24]);
    expect(a.depth).toEqual([0, 1, 0, 1, 0, 1, 2, 0, 1, 2, 3, 4, 3, 2, 1, 0, 0, 0, 1]);
    expect([...a.leaders].sort((x, y) => x - y)).toEqual([0, 4, 9, 23]);
  });

  it('leaves a method with a subroutine (jsr) to the interpreter', async () => {
    const jvm = newJvm('force');
    define(jvm);
    expect(await jvm.callStatic('T', 'jsr', '()I')).toBe(1);
    expect(jvm.jitStats()).toMatchObject({ mode: 'force', refused: { jsr: 1 }, failed: 0 });
  });

  it('computes what the interpreter computes, and catches exceptions in the frame and in its caller', async () => {
    for (const mode of ['off', 'force'] as const) {
      const jvm = newJvm(mode);
      define(jvm);
      expect(await jvm.callStatic('T', 'loop', '(I)I', [100_000])).toBe(-584230013);
      expect(await jvm.callStatic('T', 'safeDiv', '(II)I', [9, 0])).toBe(-7);
      expect(await jvm.callStatic('T', 'caller', '(I)I', [9])).toBe(99);
      if (mode === 'force') expect(jvm.jitStats().compiled).toBeGreaterThanOrEqual(4);
    }
  });

  it('gives an exception the pc of the instruction that threw, as the interpreter does', () => {
    for (const mode of ['off', 'force'] as const) {
      const jvm = newJvm(mode);
      define(jvm);
      const m = jvm.loader.loadBoot('T')!.methods.get('quot(II)I')!;
      const t = jvm.threads.spawn(null, m, [1, 0]);
      expect(execute(jvm, t, 10)).toBe('finished');
      expect(t.uncaught?.cls.name).toBe('java/lang/ArithmeticException');
      expect((t.uncaught!.nativeData as StackTrace).pcs).toEqual([2]);
    }
  });

  it('ends a slice on the same instruction as the interpreter, with the same frame', () => {
    const states = new Map<string, string[]>();
    for (const mode of ['off', 'force'] as const) {
      const out: string[] = [];
      for (const budget of [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 31, 97, 1000, 4321]) {
        const jvm = newJvm(mode);
        define(jvm);
        const m = jvm.loader.loadBoot('T')!.methods.get('loop(I)I')!;
        const t = jvm.threads.spawn(null, m, [1_000]);
        const f = t.frames[0] as Frame;
        execute(jvm, t, budget);
        out.push(`${budget}: pc ${f.pc} sp ${f.sp} locals ${f.locals.join(',')} stack ${f.stack.slice(0, f.sp).join(',')}`);
        // and a second slice from wherever the first stopped
        execute(jvm, t, 25);
        out.push(`  then pc ${f.pc} sp ${f.sp} locals ${f.locals.join(',')}`);
      }
      states.set(mode, out);
    }
    expect(states.get('force')).toEqual(states.get('off'));
  });

  it('runs interpreted where code generation is unavailable, and says so once', async () => {
    const warned: string[] = [];
    vi.spyOn(globalThis, 'Function').mockImplementation(() => {
      throw new EvalError('Refused to evaluate a string as JavaScript');
    });
    const jvm = newJvm('force', (line) => warned.push(line));
    vi.restoreAllMocks();
    define(jvm);
    expect(await jvm.callStatic('T', 'loop', '(I)I', [10])).toBe(50);
    expect(jvm.jitStats()).toMatchObject({ mode: 'off', compiled: 0 });
    expect(warned).toEqual(['BD-J: code generation is unavailable here (Content Security Policy); Java runs interpreted']);
  });
});

// (a + a) + i++ + i: a pending (a + a), read from the slot variables after dup, outlives a store into one of them
const PENDING_SLOT: AsmMethod = { name: 'pendingSlot', desc: '(II)I', code: [0x1a, 0x59, 0x60, 0x1b, 0x84, 1, 1, 0x60, 0x1b, 0x60, 0xac], maxStack: 3, maxLocals: 2 };
// (a + a) * (b * b * … * b) grown past the length at which a pending expression is stored, while (a + a) is pending
const LONG_PENDING: AsmMethod = {
  name: 'longPending',
  desc: '(II)I',
  code: [0x1a, 0x59, 0x60, 0x1b, ...Array.from({ length: 14 }, () => [0x1b, 0x68]).flat(), 0x68, 0xac],
  maxStack: 3,
  maxLocals: 2,
};

/** A small seeded random generator (mulberry32). */
function random(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

type Kind = 'I' | 'J' | 'F';
const width = (k: Kind): number => (k === 'J' ? 2 : 1);

/**
 * A random straight-line method f(II)I: loads, stores, iinc, stack shuffles and int, long and float arithmetic and
 * conversions, then everything left folded into an int. Locals: 0-3 int, 4-5 long, 6 float.
 */
function randomMethod(seed: number): AsmMethod {
  const r = random(seed);
  const pick = <T>(xs: readonly T[]): T => xs[Math.floor(r() * xs.length)]!;
  const code: number[] = [0x03, 0x3d, 0x04, 0x3e, 0x0a, 0x37, 4, 0x0c, 0x38, 6];
  const st: Kind[] = [];
  let maxSlots = 0;
  const slots = (): number => st.reduce((n, k) => n + width(k), 0);
  const emit = (bytes: number[], pop: Kind[], push: Kind[]): void => {
    for (let i = 0; i < pop.length; i++) st.pop();
    st.push(...push);
    code.push(...bytes);
    maxSlots = Math.max(maxSlots, slots());
  };
  const top = (n: number): Kind[] => st.slice(-n);
  const is = (...ks: Kind[]): boolean => st.length >= ks.length && top(ks.length).every((k, i) => k === ks[i]);
  const ops = r() * 40 + 5;
  for (let n = 0; n < ops; n++) {
    const room = slots() < 8;
    const c: (() => void)[] = [];
    if (room) {
      c.push(() => emit([0x15, Math.floor(r() * 4)], [], ['I']));
      c.push(() => emit([0x1a + Math.floor(r() * 2)], [], ['I']));
      c.push(() => emit([0x10, Math.floor(r() * 256)], [], ['I']));
      c.push(() => emit([0x16, 4], [], ['J']));
      c.push(() => emit([0x17, 6], [], ['F']));
    }
    if (is('I')) {
      c.push(() => emit([0x36, 1 + Math.floor(r() * 3)], ['I'], []));
      c.push(() => emit([pick([0x74, 0x91, 0x92, 0x93])], ['I'], ['I']));
      c.push(() => emit([0x85], ['I'], ['J']));
      c.push(() => emit([0x86], ['I'], ['F']));
      c.push(() => emit([0x57], ['I'], []));
    }
    c.push(() => emit([0x84, Math.floor(r() * 4), Math.floor(r() * 256)], [], []));
    c.push(() => emit([0x84, Math.floor(r() * 2), 1], [], []));
    if (is('J')) {
      c.push(() => emit([0x37, 4], ['J'], []));
      c.push(() => emit([0x88], ['J'], ['I']));
      c.push(() => emit([0x89], ['J'], ['F']));
      c.push(() => emit([0x75], ['J'], ['J']));
      c.push(() => emit([0x58], ['J'], []));
      if (room) c.push(() => emit([0x5c], ['J'], ['J', 'J']));
    }
    if (is('F')) {
      c.push(() => emit([0x38, 6], ['F'], []));
      c.push(() => emit([0x8b], ['F'], ['I']));
      c.push(() => emit([0x8c], ['F'], ['J']));
      c.push(() => emit([0x76], ['F'], ['F']));
    }
    const cat1 = (n: number): boolean => st.length >= n && top(n).every((k) => k !== 'J');
    if (cat1(1) && room) c.push(() => { const k = st.at(-1)!; emit([0x59], [k], [k, k]); });
    if (cat1(2) && room) c.push(() => { const [a, b] = top(2) as [Kind, Kind]; emit([0x5a], [a, b], [b, a, b]); });
    if (cat1(3) && room) c.push(() => { const [a, b, d] = top(3) as [Kind, Kind, Kind]; emit([0x5b], [a, b, d], [d, a, b, d]); });
    if (cat1(2)) c.push(() => { const [a, b] = top(2) as [Kind, Kind]; emit([0x5f], [a, b], [b, a]); });
    if (cat1(2) && room) c.push(() => { const [a, b] = top(2) as [Kind, Kind]; emit([0x5c], [a, b], [a, b, a, b]); });
    if (is('I', 'I')) c.push(() => emit([pick([0x60, 0x64, 0x68, 0x7e, 0x80, 0x82, 0x78, 0x7a, 0x7c])], ['I', 'I'], ['I']));
    if (is('J', 'J')) {
      c.push(() => emit([pick([0x61, 0x65, 0x69, 0x7f, 0x81, 0x83])], ['J', 'J'], ['J']));
      c.push(() => emit([0x94], ['J', 'J'], ['I']));
    }
    if (is('J', 'I')) c.push(() => emit([pick([0x79, 0x7b, 0x7d])], ['J', 'I'], ['J']));
    if (is('F', 'F')) {
      c.push(() => emit([pick([0x62, 0x66, 0x6a, 0x6e])], ['F', 'F'], ['F']));
      c.push(() => emit([pick([0x95, 0x96])], ['F', 'F'], ['I']));
    }
    pick(c)();
  }
  // fold what is left into local 2, then add up the locals
  while (st.length > 0) {
    const k = st.at(-1)!;
    if (k === 'J') emit([0x88], ['J'], ['I']);
    if (k === 'F') emit([0x8b], ['F'], ['I']);
    code.push(0x1c, 0x60, 0x3d);
    st.pop();
    maxSlots = Math.max(maxSlots, slots() + 2);
  }
  code.push(0x1c, 0x1d, 0x60, 0x16, 4, 0x88, 0x60, 0x17, 6, 0x8b, 0x60, 0xac);
  return { name: `f${seed}`, desc: '(II)I', code, maxStack: Math.max(maxSlots, 3) + 2, maxLocals: 7 };
}

describe('the JIT against the interpreter', () => {
  it('keeps a pending expression that reads a slot variable when that variable is stored to', async () => {
    for (const method of [PENDING_SLOT, LONG_PENDING]) {
      const results: unknown[] = [];
      for (const mode of ['off', 'force'] as const) {
        const jvm = newJvm(mode);
        jvm.loader.define('P', assembleClass('P', [method]), null, null);
        results.push(await jvm.callStatic('P', method.name, method.desc, [100, 7]));
      }
      expect(results[1], method.name).toBe(results[0]);
    }
    const jvm = newJvm('force');
    jvm.loader.define('P', assembleClass('P', [PENDING_SLOT]), null, null);
    expect(await jvm.callStatic('P', 'pendingSlot', '(II)I', [100, 7])).toBe(215);
  });

  it('compiles a hot loop at its heat threshold and goes on in it compiled from the loop head', async () => {
    const clock = new VirtualClock();
    const jvm = new Jvm({ bootJars: BOOT, nowMs: clock.nowMs, setTimer: clock.setTimer, stdout: () => {}, stderr: () => {}, jit: 'on', jitThreshold: 50 });
    define(jvm);
    expect(await jvm.callStatic('T', 'loop', '(I)I', [100_000])).toBe(-584230013);
    expect(jvm.jitStats()).toMatchObject({ mode: 'on', compiled: 1, failed: 0 });
  });

  it('computes what the interpreter computes on 2,000 random straight-line methods', async () => {
    const methods = Array.from({ length: 2000 }, (_, i) => randomMethod(i + 1));
    const results: unknown[][] = [];
    for (const mode of ['off', 'force'] as const) {
      const jvm = newJvm(mode);
      jvm.loader.define('Fz', assembleClass('Fz', methods), null, null);
      const out: unknown[] = [];
      for (const [i, m] of methods.entries()) out.push(await jvm.callStatic('Fz', m.name, m.desc, [i * 7 + 3, 5 - i * 13]));
      results.push(out);
      if (mode === 'force') expect(jvm.jitStats()).toMatchObject({ refused: {}, failed: 0 });
    }
    const differ = methods.map((m, i) => [m.name, results[0]![i], results[1]![i]] as const).filter(([, a, b]) => !Object.is(a, b));
    expect(differ).toEqual([]);
  });
});
