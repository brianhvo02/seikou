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
