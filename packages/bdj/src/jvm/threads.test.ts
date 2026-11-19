import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { Invoke, Suspend, ThrowResult } from './interpreter';
import { Jvm } from './jvm';
import { withMonitor } from './natives/util';
import type { JMethod } from './loader';
import type { JThread } from './threads';
import { JavaThrowable } from './values';
import type { JObject, JValue } from './values';
import { ACC_PUBLIC_STATIC, ACC_SYNCHRONIZED, VirtualClock, assembleClass, runWithClock } from '../../../../tests/helpers/jvm-asm';
import type { AsmMethod, Const } from '../../../../tests/helpers/jvm-asm';

const jar = (rel: string): Uint8Array => readFileSync(fileURLToPath(new URL(rel, import.meta.url)));
const BOOT = [
  jar('../../../bdj-classlib/libbluray-j2se.jar'),
  jar('../../../bdj-classlib/libbluray-awt-j2se.jar'),
  jar('../../../bdj-classlib/rt-bdj.jar'),
];

const ICONST_0 = 0x03, ICONST_1 = 0x04, ICONST_2 = 0x05, BIPUSH = 0x10, SIPUSH = 0x11, LDC_W = 0x13, LDC2_W = 0x14;
const ILOAD_0 = 0x1a, ALOAD_0 = 0x2a, ALOAD_1 = 0x2b, ISTORE_0 = 0x3b, ASTORE_0 = 0x4b, ASTORE_1 = 0x4c;
const POP = 0x57, DUP = 0x59, IADD = 0x60, IMUL = 0x68, IINC = 0x84, IFNE = 0x9a, IF_ICMPGE = 0xa2, GOTO = 0xa7;
const IRETURN = 0xac, RETURN = 0xb1, GETSTATIC = 0xb2, PUTSTATIC = 0xb3, INVOKEVIRTUAL = 0xb6, INVOKESTATIC = 0xb8;
const MONITORENTER = 0xc2, MONITOREXIT = 0xc3;

const cls = (name: string): { c: Const } => ({ c: ['class', name] });
const field = (name: string): { c: Const } => ({ c: ['field', 'T', name, 'I'] });
const method = (owner: string, name: string, desc: string): { c: Const } => ({ c: ['method', owner, name, desc] });
const long = (v: bigint): { c: Const } => ({ c: ['long', v] });
const TCLASS = cls('T');
const n = field('n'), done = field('done'), flag = field('flag'), caught = field('caught');

/** `for (int i = 0; i < count; i++) body` with `i` in local 0; the body must not branch. */
function loop(count: number, body: AsmMethod['code'] & object, tail: AsmMethod['code'] & object = [RETURN]): AsmMethod['code'] & object {
  const size = body.reduce<number>((s, op) => s + (typeof op === 'number' ? 1 : 2), 0);
  const exit = 9 + size; // from the if_icmpge at 6 to the first byte after the goto
  const back = -(10 + size); // from the goto back to the iload_0 at 2
  return [
    ICONST_0, ISTORE_0, // 0
    ILOAD_0, SIPUSH, (count >> 8) & 0xff, count & 0xff, // 2
    IF_ICMPGE, (exit >> 8) & 0xff, exit & 0xff, // 6
    ...body,
    IINC, 0, 1,
    GOTO, (back >> 8) & 0xff, back & 0xff,
    ...tail,
  ];
}

const INC_N = [GETSTATIC, n, ICONST_1, IADD, PUTSTATIC, n];

const T_METHODS: AsmMethod[] = [
  { name: 'blockLoop', desc: '()V', code: loop(10000, [LDC_W, TCLASS, DUP, ASTORE_1, MONITORENTER, ...INC_N, ALOAD_1, MONITOREXIT]) },
  { name: 'incSync', desc: '()V', access: ACC_PUBLIC_STATIC | ACC_SYNCHRONIZED, code: [...INC_N, RETURN] },
  { name: 'methodLoop', desc: '()V', code: loop(10000, [INVOKESTATIC, method('T', 'incSync', '()V')]) },
  { name: 'count', desc: '()V', code: loop(1000, INC_N) },
  { name: 'burn', desc: '()V', code: loop(5000, []) },
  { name: 'spin', desc: '()V', code: [GOTO, 0, 0] },
  {
    name: 'waiter', desc: '()V', code: [
      LDC_W, TCLASS, DUP, ASTORE_0, MONITORENTER, // 0
      GETSTATIC, flag, IFNE, 0, 10, // 6
      ALOAD_0, INVOKEVIRTUAL, method('java/lang/Object', 'wait', '()V'), GOTO, 0xff, 0xf6, // 12
      ICONST_1, PUTSTATIC, done, ALOAD_0, MONITOREXIT, RETURN, // 19
    ],
  },
  {
    // waits until flag is set, then records n as it finds it (a MediaTracker waiter reading an image's status)
    name: 'observer', desc: '()V', code: [
      LDC_W, TCLASS, DUP, ASTORE_0, MONITORENTER, // 0
      GETSTATIC, flag, IFNE, 0, 10, // 6
      ALOAD_0, INVOKEVIRTUAL, method('java/lang/Object', 'wait', '()V'), GOTO, 0xff, 0xf6, // 12
      GETSTATIC, n, PUTSTATIC, done, ALOAD_0, MONITOREXIT, RETURN, // 19
    ],
  },
  {
    // sets n to 1 and notifies under the monitor, then, released, goes on and sets n to 2 (an image fetcher reporting
    // complete, then its late error)
    name: 'producer', desc: '()V', code: [
      LDC_W, TCLASS, DUP, ASTORE_0, MONITORENTER,
      ICONST_1, PUTSTATIC, n, ICONST_1, PUTSTATIC, flag, ALOAD_0, INVOKEVIRTUAL, method('java/lang/Object', 'notifyAll', '()V'),
      ALOAD_0, MONITOREXIT,
      ICONST_2, PUTSTATIC, n, RETURN,
    ],
  },
  {
    // holds the monitor long enough for another thread to block entering, sets n to 1, exits (no notify), then sets 2
    name: 'holder', desc: '()V', code: [
      LDC_W, TCLASS, DUP, ASTORE_0, MONITORENTER, INVOKESTATIC, method('T', 'burn', '()V'),
      ICONST_1, PUTSTATIC, n, ALOAD_0, MONITOREXIT, ICONST_2, PUTSTATIC, n, RETURN,
    ],
  },
  {
    // enters the monitor (blocking while the holder has it) and records n as it finds it
    name: 'entrant', desc: '()V', code: [LDC_W, TCLASS, DUP, ASTORE_0, MONITORENTER, GETSTATIC, n, PUTSTATIC, done, ALOAD_0, MONITOREXIT, RETURN],
  },
  {
    // the same through a synchronized method: the monitor passes on at its return
    name: 'producerSync', desc: '()V', code: [INVOKESTATIC, method('T', 'markSync', '()V'), ICONST_2, PUTSTATIC, n, RETURN],
  },
  {
    name: 'markSync', desc: '()V', access: ACC_PUBLIC_STATIC | ACC_SYNCHRONIZED, code: [
      ICONST_1, PUTSTATIC, n, ICONST_1, PUTSTATIC, flag, LDC_W, TCLASS, INVOKEVIRTUAL, method('java/lang/Object', 'notifyAll', '()V'), RETURN,
    ],
  },
  {
    name: 'notifier', desc: '()V', code: [
      LDC_W, TCLASS, DUP, ASTORE_0, MONITORENTER,
      ICONST_1, PUTSTATIC, flag, ALOAD_0, INVOKEVIRTUAL, method('java/lang/Object', 'notify', '()V'), ALOAD_0, MONITOREXIT, RETURN,
    ],
  },
  {
    name: 'timedWait', desc: '()V', code: [
      LDC_W, TCLASS, DUP, ASTORE_0, MONITORENTER,
      ALOAD_0, LDC2_W, long(100n), INVOKEVIRTUAL, method('java/lang/Object', 'wait', '(J)V'),
      ICONST_1, PUTSTATIC, done, ALOAD_0, MONITOREXIT, RETURN,
    ],
  },
  {
    name: 'waitCatch', desc: '()V', code: [
      LDC_W, TCLASS, DUP, ASTORE_0, MONITORENTER, // 0
      ALOAD_0, LDC2_W, long(0n), INVOKEVIRTUAL, method('java/lang/Object', 'wait', '(J)V'), // 6
      ICONST_1, PUTSTATIC, done, ALOAD_0, MONITOREXIT, RETURN, // 13
      POP, ICONST_1, PUTSTATIC, caught, ALOAD_0, MONITOREXIT, RETURN, // 20
    ],
    handlers: [[6, 20, 20, 'java/lang/InterruptedException']],
  },
  { name: 'sleeper', desc: '()V', code: [LDC2_W, long(50n), INVOKESTATIC, method('java/lang/Thread', 'sleep', '(J)V'), ICONST_1, PUTSTATIC, done, RETURN] },
  {
    name: 'sleepCatch', desc: '()V', code: [
      LDC2_W, long(1000n), INVOKESTATIC, method('java/lang/Thread', 'sleep', '(J)V'), ICONST_1, PUTSTATIC, done, RETURN, // 0
      POP, ICONST_1, PUTSTATIC, caught, RETURN, // 11
    ],
    handlers: [[0, 11, 11, 'java/lang/InterruptedException']],
  },
  {
    name: 'ab', desc: '()V', code: [
      LDC_W, cls('java/lang/String'), DUP, ASTORE_0, MONITORENTER, INVOKESTATIC, method('T', 'burn', '()V'),
      LDC_W, cls('java/lang/Integer'), DUP, ASTORE_1, MONITORENTER, ALOAD_1, MONITOREXIT, ALOAD_0, MONITOREXIT, RETURN,
    ],
  },
  {
    name: 'ba', desc: '()V', code: [
      LDC_W, cls('java/lang/Integer'), DUP, ASTORE_0, MONITORENTER, INVOKESTATIC, method('T', 'burn', '()V'),
      LDC_W, cls('java/lang/String'), DUP, ASTORE_1, MONITORENTER, ALOAD_1, MONITOREXIT, ALOAD_0, MONITOREXIT, RETURN,
    ],
  },
  { name: 'yielder', desc: '()V', code: [INVOKESTATIC, method('java/lang/Thread', 'yield', '()V'), GETSTATIC, n, PUTSTATIC, done, RETURN] },
  { name: 'badExit', desc: '()V', code: [LDC_W, TCLASS, MONITOREXIT, RETURN] },
  { name: 'badNotify', desc: '()V', code: [LDC_W, TCLASS, INVOKEVIRTUAL, method('java/lang/Object', 'notify', '()V'), RETURN] },
  {
    name: 'holdAndScale', desc: '()V', code: [
      ICONST_1, PUTSTATIC, n, LDC_W, TCLASS, DUP, ASTORE_0, MONITORENTER, INVOKESTATIC, method('T', 'burn', '()V'),
      GETSTATIC, n, BIPUSH, 10, IMUL, PUTSTATIC, n, ALOAD_0, MONITOREXIT, RETURN,
    ],
  },
  { name: 'getX', desc: '()I', code: [GETSTATIC, { c: ['field', 'C', 'x', 'I'] }, IRETURN] },
  { name: 'setFlagLocked', desc: '()V', code: [LDC_W, TCLASS, DUP, ASTORE_0, MONITORENTER, ICONST_1, PUTSTATIC, flag, ALOAD_0, MONITOREXIT, RETURN] },
  { name: 'slow', desc: '()V', access: ACC_PUBLIC_STATIC | ACC_SYNCHRONIZED },
  { name: 'callSlow', desc: '()V', code: [INVOKESTATIC, method('T', 'slow', '()V'), RETURN] },
  { name: 'viaInvoke', desc: '()V' },
  { name: 'outer', desc: '()I' },
  { name: 'inner', desc: '()I' },
  { name: 'callOuter', desc: '()V', code: [INVOKESTATIC, method('T', 'outer', '()I'), PUTSTATIC, done, RETURN] },
];

function setup(): { jvm: Jvm; clock: VirtualClock; spawn: (name: string, desc?: string) => JThread; get: (f: string) => JValue } {
  const clock = new VirtualClock();
  const jvm = new Jvm({ bootJars: BOOT, nowMs: clock.nowMs, setTimer: clock.setTimer, stdout: () => {}, stderr: () => {} });
  jvm.loader.define('T', assembleClass('T', T_METHODS, [['n', 'I'], ['done', 'I'], ['flag', 'I'], ['caught', 'I']]), null, null);
  jvm.loader.define('C', assembleClass('C', [
    { name: '<clinit>', desc: '()V', code: [INVOKESTATIC, method('T', 'burn', '()V'), BIPUSH, 5, PUTSTATIC, { c: ['field', 'C', 'x', 'I'] }, RETURN] },
  ], [['x', 'I']]), null, null);
  const t = jvm.loader.loadBoot('T')!;
  const m = (name: string, desc = '()V'): JMethod => t.methods.get(name + desc)!;
  return {
    jvm,
    clock,
    spawn: (name, desc) => jvm.threads.spawn(null, m(name, desc), []),
    get: (f) => t.staticValues[t.findField(f, 'I')!.slot]!,
  };
}

const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

describe('yielding to the event loop', () => {
  it('takes its periodic turn through yieldTask when one is given, instead of a zero-delay timer', async () => {
    const clock = new VirtualClock();
    let turns = 0;
    let zeroTimers = 0;
    const jvm = new Jvm({
      bootJars: BOOT,
      nowMs: clock.nowMs,
      setTimer: (ms, fn) => {
        if (ms === 0) zeroTimers++;
        return clock.setTimer(ms, fn);
      },
      yieldTask: () => {
        turns++;
        return new Promise((r) => setImmediate(r));
      },
      stdout: () => {},
      stderr: () => {},
    });
    jvm.loader.define('T', assembleClass('T', T_METHODS, [['n', 'I'], ['done', 'I'], ['flag', 'I'], ['caught', 'I']]), null, null);
    jvm.threads.slice = 10;
    const t = jvm.threads.spawn(null, jvm.loader.loadBoot('T')!.methods.get('count()V')!, []);
    expect(await jvm.threads.run()).toBe('idle');
    expect(t.state).toBe('terminated');
    expect(turns).toBeGreaterThan(5);
    expect(zeroTimers).toBe(0);
  });
});

describe('monitors', () => {
  it('a monitor hand-off lets the woken waiter run before the thread that released it goes on (Ruling R19)', async () => {
    for (const producer of ['producer', 'producerSync']) {
      const { jvm, clock, spawn, get } = setup();
      const w = spawn('observer');
      const p = spawn(producer);
      expect(await runWithClock(jvm, clock)).toBe('idle');
      expect([w.uncaught, p.uncaught]).toEqual([null, null]);
      // the waiter sees the state the producer notified, as HotSpot's waiter, running in parallel, does
      expect(get('done')).toBe(1);
      expect(get('n')).toBe(2);
    }
  });

  it('a monitor passed to a thread blocked entering lets it run before the releaser goes on (Ruling R19)', async () => {
    const { jvm, clock, spawn, get } = setup();
    jvm.threads.slice = 1000; // the holder's slice ends inside the monitor, so the entrant runs and blocks
    const h = spawn('holder');
    const e = spawn('entrant');
    expect(await runWithClock(jvm, clock)).toBe('idle');
    expect([h.uncaught, e.uncaught]).toEqual([null, null]);
    expect(get('done')).toBe(1);
    expect(get('n')).toBe(2);
  });

  it('two threads incrementing under the same monitor reach 20,000', async () => {
    const { jvm, clock, spawn, get } = setup();
    const a = spawn('blockLoop');
    const b = spawn('methodLoop');
    expect(await runWithClock(jvm, clock)).toBe('idle');
    expect([a.uncaught, b.uncaught]).toEqual([null, null]);
    expect(get('n')).toBe(20000);
  });

  it('monitorexit by a non-owner throws IllegalMonitorStateException', async () => {
    const { jvm } = setup();
    await expect(jvm.callStatic('T', 'badExit', '()V')).rejects.toThrow(/^java\.lang\.IllegalMonitorStateException/);
    await expect(jvm.callStatic('T', 'badNotify', '()V')).rejects.toThrow(/^java\.lang\.IllegalMonitorStateException/);
  });

  it('two monitors taken in opposite order resolve deadlock', async () => {
    const { jvm, clock, spawn } = setup();
    const a = spawn('ab');
    const b = spawn('ba');
    expect(await runWithClock(jvm, clock)).toBe('deadlock');
    expect([a.state, b.state]).toEqual(['blocked-monitor', 'blocked-monitor']);
    // the thread dump names each blocked thread, the monitor it waits for, that monitor's owner and the frames
    const dump = jvm.threads.dump((m) => `${m.cls.name}.${m.name}`);
    expect(dump[0]).toBe('threads: 2 live, 0 queued, 0 yielded, 0 on I/O, 0 timed, 0 timer waiters');
    expect(dump.slice(1)).toEqual([
      `#${a.id} "(attached)" blocked-monitor on class java.lang.Integer, owned by #${b.id}`,
      '    at T.ab',
      `#${b.id} "(attached)" blocked-monitor on class java.lang.String, owned by #${a.id}`,
      '    at T.ba',
    ]);
  });

  it('a synchronized method reached through an Invoke waits for the monitor', async () => {
    const { jvm, clock, spawn, get } = setup();
    jvm.natives.register({
      'T.viaInvoke()V': (ctx) => new Invoke(ctx.method.cls.methods.get('incSync()V')!, [], () => undefined),
    });
    spawn('holdAndScale');
    spawn('viaInvoke');
    expect(await runWithClock(jvm, clock)).toBe('idle');
    expect(get('n')).toBe(11);
  });

  it('a synchronized native holds the monitor until its suspension settles', async () => {
    const { jvm, clock, spawn, get } = setup();
    let release!: () => void;
    jvm.natives.register({ 'T.slow()V': () => new Suspend(new Promise((r) => (release = () => r(undefined)))) });
    const a = spawn('callSlow');
    const b = spawn('setFlagLocked');
    const run = runWithClock(jvm, clock);
    await tick();
    expect(a.state).toBe('suspended-native');
    expect(b.state).toBe('blocked-monitor');
    expect(get('flag')).toBe(0);
    release();
    expect(await run).toBe('idle');
    expect(get('flag')).toBe(1);
    expect(jvm.mirror(jvm.loader.loadBoot('T')!).monitor?.owner).toBeNull();
  });
});

describe('suspension', () => {
  it('a native reached through an Invoke may suspend, and its continuation runs on the result', async () => {
    const { jvm } = setup();
    jvm.natives.register({
      'T.inner()I': () => new Suspend(Promise.resolve(41)),
      'T.outer()I': (ctx) => new Invoke(ctx.method.cls.methods.get('inner()I')!, [], (v) => (v as number) + 1),
    });
    expect(await jvm.callStatic('T', 'outer', '()I')).toBe(42);
  });
  it("a contended monitor reached through an Invoke chain still runs the caller's continuation", async () => {
    const { jvm, clock, spawn, get } = setup();
    const t = jvm.loader.loadBoot('T')!;
    const lock = jvm.mirror(t);
    jvm.natives.register({
      'T.inner()I': (ctx) =>
        withMonitor(ctx.jvm, ctx.thread, lock, () =>
          new Invoke(t.methods.get('getX()I')!, [], (v) => {
            ctx.jvm.threads.monitorExit(ctx.thread, lock);
            return v;
          })),
      'T.outer()I': (ctx) => new Invoke(ctx.method.cls.methods.get('inner()I')!, [], (v) => (v as number) + 1),
    });
    spawn('holdAndScale');
    const b = spawn('callOuter');
    expect(await runWithClock(jvm, clock)).toBe('idle');
    expect(b.uncaught).toBeNull();
    expect(get('done')).toBe(6);
  });
  it('step() runs a stored continuation when the resumed result throws', async () => {
    const { jvm, clock, spawn } = setup();
    const t = jvm.loader.loadBoot('T')!;
    const lock = jvm.mirror(t);
    const guard = jvm.mirror(jvm.loader.loadBoot('java/lang/String')!);
    const seen: JObject[] = [];
    jvm.natives.register({
      'T.inner()I': (ctx) =>
        withMonitor(ctx.jvm, ctx.thread, lock, () => {
          ctx.jvm.threads.monitorExit(ctx.thread, lock);
          throw new JavaThrowable(ctx.jvm.throwNew('java/lang/RuntimeException', 'boom').exception);
        }),
      'T.outer()I': (ctx) => {
        ctx.jvm.threads.monitorEnter(ctx.thread, guard);
        return new Invoke(
          ctx.method.cls.methods.get('inner()I')!,
          [],
          (v) => {
            ctx.jvm.threads.monitorExit(ctx.thread, guard);
            return v;
          },
          (e) => {
            seen.push(e);
            ctx.jvm.threads.monitorExit(ctx.thread, guard);
            return new ThrowResult(e);
          },
        );
      },
    });
    spawn('holdAndScale');
    const b = spawn('callOuter');
    await runWithClock(jvm, clock);
    expect(b.uncaught).not.toBeNull();
    expect(seen).toHaveLength(1);
    expect(seen[0]).toBe(b.uncaught);
    expect(jvm.threads.monitorEnter(spawn('burn'), guard)).toBe(true);
  });
  it('an onThrow that throws ends as the thread\'s uncaught exception and run() resolves', async () => {
    const { jvm, clock, spawn } = setup();
    const t = jvm.loader.loadBoot('T')!;
    const lock = jvm.mirror(t);
    jvm.natives.register({
      'T.inner()I': (ctx) =>
        withMonitor(ctx.jvm, ctx.thread, lock, () => {
          ctx.jvm.threads.monitorExit(ctx.thread, lock);
          throw new JavaThrowable(ctx.jvm.throwNew('java/lang/RuntimeException', 'boom').exception);
        }),
      'T.outer()I': (ctx) =>
        new Invoke(ctx.method.cls.methods.get('inner()I')!, [], (v) => v, () => {
          throw new JavaThrowable(ctx.jvm.throwNew('java/lang/IllegalStateException', 'again').exception);
        }),
    });
    spawn('holdAndScale');
    const b = spawn('callOuter');
    expect(await runWithClock(jvm, clock)).toBe('idle');
    expect(b.uncaught?.cls.name).toBe('java/lang/IllegalStateException');
  });
  it('a success-path continuation that throws runs exactly once', async () => {
    const { jvm, clock, spawn } = setup();
    const t = jvm.loader.loadBoot('T')!;
    const lock = jvm.mirror(t);
    let runs = 0;
    jvm.natives.register({
      'T.inner()I': (ctx) => withMonitor(ctx.jvm, ctx.thread, lock, () => {
        ctx.jvm.threads.monitorExit(ctx.thread, lock);
        return 1;
      }),
      'T.outer()I': (ctx) =>
        new Invoke(ctx.method.cls.methods.get('inner()I')!, [], () => {
          runs++;
          throw new JavaThrowable(ctx.jvm.throwNew('java/lang/RuntimeException', 'k').exception);
        }),
    });
    spawn('holdAndScale');
    const b = spawn('callOuter');
    expect(await runWithClock(jvm, clock)).toBe('idle');
    expect(runs).toBe(1);
    expect(b.uncaught?.cls.name).toBe('java/lang/RuntimeException');
  });
});

describe('wait and notify', () => {
  it('a wait/notify handshake completes', async () => {
    const { jvm, clock, spawn, get } = setup();
    const w = spawn('waiter');
    const s = spawn('notifier');
    expect(await runWithClock(jvm, clock)).toBe('idle');
    expect([w.state, s.state, w.uncaught, s.uncaught]).toEqual(['terminated', 'terminated', null, null]);
    expect(get('done')).toBe(1);
    expect(w.blocker).toBeNull(); // it waited on the monitor, then took it back
  });

  it('wait(100) returns once the clock has advanced 100 ms', async () => {
    const { jvm, clock, spawn, get } = setup();
    const t = spawn('timedWait');
    expect(await jvm.threads.run()).toBe('idle');
    expect(t.state).toBe('timed-waiting');
    clock.advance(99);
    expect(await jvm.threads.run()).toBe('idle');
    expect(get('done')).toBe(0);
    clock.advance(1);
    expect(await jvm.threads.run()).toBe('idle');
    expect(get('done')).toBe(1);
    expect(t.state).toBe('terminated');
  });

  it('interrupting a waiting thread throws InterruptedException and clears the flag', async () => {
    const { jvm, spawn, get } = setup();
    const t = spawn('waitCatch');
    expect(await jvm.threads.run()).toBe('deadlock');
    jvm.threads.interrupt(t);
    expect(await jvm.threads.run()).toBe('idle');
    expect([get('caught'), get('done'), t.interrupted, t.uncaught]).toEqual([1, 0, false, null]);
  });

  it('a thread waiting on another thread\'s class initialisation sees the initialised class', async () => {
    const { jvm, clock, spawn } = setup();
    const a = spawn('getX', '()I');
    const b = spawn('getX', '()I');
    expect(await runWithClock(jvm, clock)).toBe('idle');
    expect([a.uncaught, b.uncaught, a.result, b.result]).toEqual([null, null, 5, 5]);
  });
});

describe('sleep and interrupt', () => {
  it('Thread.sleep(50) in one thread does not hold up another', async () => {
    const { jvm, clock, spawn, get } = setup();
    const s = spawn('sleeper');
    spawn('count');
    expect(await jvm.threads.run()).toBe('idle');
    expect(s.uncaught && jvm.describe(s.uncaught)).toBe(null);
    expect([get('n'), get('done'), clock.now, s.state]).toEqual([1000, 0, 0, 'sleeping']);
    expect(await runWithClock(jvm, clock)).toBe('idle');
    expect([get('done'), clock.now, s.uncaught]).toEqual([1, 50, null]);
  });

  it('interrupting a sleeping thread throws InterruptedException', async () => {
    const { jvm, clock, spawn, get } = setup();
    const t = spawn('sleepCatch');
    expect(await jvm.threads.run()).toBe('idle');
    expect(t.state).toBe('sleeping');
    jvm.threads.interrupt(t);
    expect(await jvm.threads.run()).toBe('idle');
    expect([get('caught'), get('done'), t.interrupted, clock.pending]).toEqual([1, 0, false, 0]);
  });

  it('sleep with the interrupted flag already set throws at once', async () => {
    const { jvm, spawn, get } = setup();
    const t = spawn('sleepCatch');
    jvm.threads.interrupt(t);
    expect(await jvm.threads.run()).toBe('idle');
    expect([get('caught'), t.interrupted]).toEqual([1, false]);
  });
});

describe('time slicing', () => {
  it('Thread.yield lets the next runnable thread go first', async () => {
    const { jvm, spawn, get } = setup();
    const y = spawn('yielder');
    spawn('count');
    expect(await jvm.threads.run()).toBe('idle');
    expect([y.uncaught, get('done')]).toEqual([null, 1000]);
  });

  it('a spinning thread does not starve a counting thread', async () => {
    const { jvm, clock, spawn, get } = setup();
    spawn('spin');
    const c = spawn('count');
    const abort = new AbortController();
    const run = runWithClock(jvm, clock, abort.signal);
    for (let i = 0; i < 200 && c.state !== 'terminated'; i++) await tick();
    abort.abort();
    expect(await run).toBe('aborted');
    expect(get('n')).toBe(1000);
  });

  it('run with an aborted signal resolves aborted even with a spinning thread', async () => {
    const { jvm, spawn } = setup();
    spawn('spin');
    expect(await jvm.threads.run(AbortSignal.abort())).toBe('aborted');
  });

  it('preempt() also stops a native Invoke chain before its next native', async () => {
    const { jvm } = setup();
    jvm.loader.define('Q', assembleClass('Q', [
      { name: 'a', desc: '()V' },
      { name: 'b', desc: '()V' },
      { name: 'go', desc: '()V', code: [INVOKESTATIC, method('Q', 'a', '()V'), RETURN] },
    ]), null, null);
    const q = jvm.loader.loadBoot('Q')!;
    let bRan = 0;
    const abort = new AbortController();
    jvm.natives.register({
      'Q.a()V': () => {
        jvm.threads.preempt();
        abort.abort();
        return new Invoke(q.methods.get('b()V')!, [], () => undefined);
      },
      'Q.b()V': () => void bRan++,
    });
    const t = jvm.threads.spawn(null, q.methods.get('go()V')!, []);
    expect(await jvm.threads.run(abort.signal)).toBe('aborted');
    expect(bRan).toBe(0);
    expect(await jvm.threads.run()).toBe('idle');
    expect([bRan, t.state]).toEqual([1, 'terminated']);
  });

  it('callStatic returns once its own thread ends while another thread spins (R20)', async () => {
    const { jvm, spawn, get } = setup();
    const spinner = spawn('spin');
    await jvm.callStatic('T', 'count', '()V');
    expect(get('n')).toBe(1000);
    expect(spinner.state).toBe('runnable');
  });

  it('preempt() ends the running thread\'s slice at its next call', async () => {
    const { jvm, get } = setup();
    jvm.loader.define('P', assembleClass('P', [
      { name: 'mark', desc: '()V' },
      { name: 'go', desc: '()V', code: [INVOKESTATIC, method('P', 'mark', '()V'), INVOKESTATIC, method('T', 'count', '()V'), RETURN] },
    ]), null, null);
    const t = jvm.threads.spawn(null, jvm.loader.loadBoot('P')!.methods.get('go()V')!, []);
    const abort = new AbortController();
    jvm.natives.register({ 'P.mark()V': () => {
      jvm.threads.preempt();
      abort.abort();
    } });
    expect(await jvm.threads.run(abort.signal)).toBe('aborted');
    expect(get('n')).toBe(0);
    expect(t.state).toBe('runnable');
  });
});
