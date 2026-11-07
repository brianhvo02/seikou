import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { fixtureDiscFiles } from '../../tests/helpers/fixture-disc';
import { VirtualClock, assembleClass, storedZip } from '../../tests/helpers/jvm-asm';
import type { AsmMethod } from '../../tests/helpers/jvm-asm';
import { syntheticSource } from '../../tests/helpers/synthetic-disc';
import type { Clpi } from '@seikou/bdmv/clpi-parser';
import type { FileSource } from '@seikou/engine/disc/file-source';
import { loadClips, openDisc } from '@seikou/engine/disc/open-disc';
import type { DiscModel } from '@seikou/engine/disc/open-disc';
import { BdjError } from './errors';
import { RecordingHost } from './host';
import type { BdjHost, TraceEntry } from './host';
import type { JThread } from './jvm/threads';
import type { JObject } from './jvm/values';
import { ZipArchive } from './jvm/zip';
import { BdjEvent, BdjRuntime } from './runtime';
import type { BdjRuntimeDeps, ClassLibrarySource } from './runtime';

const file = (rel: string): Uint8Array => new Uint8Array(readFileSync(fileURLToPath(new URL(rel, import.meta.url))));
const CLASSES: ClassLibrarySource = {
  rt: file('../bdj-classlib/rt-bdj.jar'),
  libbluray: file('../bdj-classlib/libbluray-j2se.jar'),
  libblurayAwt: file('../bdj-classlib/libbluray-awt-j2se.jar'),
};
/** libbluray's control calls on disc-bdj through the first selectPlaylistN (the golden goes on to the second). */
const GOLDEN = ((lines: string[]) => lines.slice(0, lines.findIndex((l) => l.includes('"call":"selectPlaylistN"')) + 1))(
  new TextDecoder()
    .decode(file('../../tests/bdj/golden/disc-bdj.jsonl'))
    .split('\n')
    .filter((l) => l !== ''),
);
const CONTROL_CALLS = new Set(['selectTitleN', 'selectPlaylistN', 'seekN', 'selectAngleN', 'selectRateN', 'writeRegN', 'setUOMaskN', 'setKeyInterestN', 'soundEffectN', 'setVirtualPackageN']);
const FIRST_PLAY = 0xffff;
const isSelectPlaylist = (e: TraceEntry): boolean => e.call === 'selectPlaylistN';

const NEW = 0xbb, DUP = 0x59, INVOKESPECIAL = 0xb7, INVOKEVIRTUAL = 0xb6, RETURN = 0xb1, ATHROW = 0xbf, ALOAD_0 = 0x2a, ALOAD_1 = 0x2b, LDC_W = 0x13, GOTO = 0xa7;
const ACC_PUBLIC = 0x0001;

/** A java.lang.Thread subclass `name` whose run() is `run`, and a static go(ThreadGroup) that starts one in that group. */
function threadClass(name: string, run: AsmMethod['code']): Uint8Array {
  const init = '(Ljava/lang/ThreadGroup;)V';
  return assembleClass(
    name,
    [
      {
        name: '<init>',
        desc: init,
        access: ACC_PUBLIC,
        code: [ALOAD_0, ALOAD_1, LDC_W, { c: ['string', name] }, INVOKESPECIAL, { c: ['method', 'java/lang/Thread', '<init>', '(Ljava/lang/ThreadGroup;Ljava/lang/String;)V'] }, RETURN],
      },
      { name: 'run', desc: '()V', access: ACC_PUBLIC, code: run },
      {
        name: 'go',
        desc: '(Ljava/lang/ThreadGroup;)V',
        code: [NEW, { c: ['class', name] }, DUP, ALOAD_0, INVOKESPECIAL, { c: ['method', name, '<init>', init] }, INVOKEVIRTUAL, { c: ['method', 'java/lang/Thread', 'start', '()V'] }, RETURN],
      },
    ],
    [],
    'java/lang/Thread',
  );
}

/** A virtual clock that moves to the next timer whenever every live Java thread is blocked, as spec §3.2's tests do. */
function autoClock(): { readonly nowMs: () => number; readonly setTimer: (ms: number, fn: () => void) => () => void; attach(rt: BdjRuntime): void } {
  const clock = new VirtualClock();
  let rt: BdjRuntime | null = null;
  let checking = false;
  const tick = (): void => {
    if (clock.pending === 0) {
      checking = false;
      return;
    }
    const live = rt?.jvm.threads.live ?? [];
    if (live.every((t) => t.state !== 'runnable' && t.state !== 'suspended-native' && !t.yielding)) clock.advanceToNext();
    setTimeout(tick, 0);
  };
  return {
    nowMs: clock.nowMs,
    setTimer: (ms, fn) => {
      const cancel = clock.setTimer(ms, fn);
      if (ms > 0 && !checking) {
        checking = true;
        setTimeout(tick, 0);
      }
      return cancel;
    },
    attach: (r) => void (rt = r),
  };
}

describe('BdjRuntime on disc-bdj', () => {
  let source: FileSource;
  let disc: DiscModel;
  let clips: Map<string, Clpi>;

  const created: BdjRuntime[] = [];
  afterEach(() => {
    for (const rt of created.splice(0)) rt.jvm.threads.halt();
  });

  beforeAll(async () => {
    source = syntheticSource(fixtureDiscFiles('disc-bdj'));
    disc = await openDisc(source);
    clips = await loadClips(source, ['00000']);
  });

  interface Harness {
    readonly rt: BdjRuntime;
    readonly lines: string[];
    readonly trace: () => readonly TraceEntry[];
  }

  function runtime(over: Partial<BdjRuntimeDeps> & { readonly wrap?: (h: RecordingHost) => BdjHost; readonly realClock?: boolean } = {}): Harness {
    const lines: string[] = [];
    let recording: RecordingHost | null = null;
    const clock = autoClock();
    const real = {
      nowMs: () => Date.now(),
      setTimer: (ms: number, fn: () => void) => {
        const id = setTimeout(fn, ms);
        return () => clearTimeout(id);
      },
    };
    const rt = new BdjRuntime({
      disc: source,
      classLibrary: CLASSES,
      host: (startTitle, onTrace) => {
        recording = new RecordingHost(disc, clips, { startTitle, onTrace });
        return over.wrap ? over.wrap(recording) : recording;
      },
      nowMs: over.realClock ? real.nowMs : clock.nowMs,
      setTimer: over.realClock ? real.setTimer : clock.setTimer,
      log: (l) => lines.push(l),
      ...over,
    });
    clock.attach(rt);
    created.push(rt);
    return { rt, lines, trace: () => recording!.trace };
  }

  it('boots libbluray\'s Java stack as bdj_open does', async () => {
    const { rt, lines } = runtime();
    await rt.boot();
    expect(lines).toContain("Libbluray:0: INFO: Using Java 1.8 (5b) from '/jdk'");
  }, 60_000);

  it('logs the first write the memory budget refuses, naming the path and the budget, and only that one', () => {
    const { rt, lines } = runtime({ memory: { classBytes: Infinity, vfsBytes: 4 } });
    const vfs = rt.jvm.opts.vfs!;
    const h = vfs.open('/tmp/x', 'w')!;
    expect(vfs.write(h, new Uint8Array(4), 0, 4)).toBe(true);
    expect(vfs.write(h, new Uint8Array(1), 0, 1)).toBe(false);
    expect(vfs.write(h, new Uint8Array(1), 0, 1)).toBe(false);
    expect(lines.filter((l) => l.includes('No space'))).toEqual(['BD-J: no room to write /tmp/x: the BD-J files in memory are at the budget of 0.0 MB (No space left on device)']);
  });

  it("passes the disc's id.bdmv disc ID to Libbluray.init, or 32 zeros without one, as _bdj_init does", async () => {
    const currentDisc = async (rt: BdjRuntime): Promise<string | null> => {
      const dm = (await rt.jvm.callStatic('org/bluray/ti/DiscManager', 'getDiscManager', '()Lorg/bluray/ti/DiscManager;')) as JObject;
      const field = dm.cls.findField('discId', 'Ljava/lang/String;')!;
      return rt.jvm.heap.jsString(dm.fields[field.slot] as JObject | null);
    };
    const withId = runtime({ discId: '88000000000000000000000000139561' }).rt;
    await withId.boot();
    expect(await currentDisc(withId)).toBe('88000000000000000000000000139561');
    const without = runtime().rt;
    await without.boot();
    expect(await currentDisc(without)).toBe('00000000000000000000000000000000');
  }, 60_000);

  it('starts First Play and makes the control calls libbluray makes, up to the first selectPlaylistN', async () => {
    const { rt, lines, trace } = runtime();
    const t0 = performance.now();
    await rt.boot();
    rt.start(FIRST_PLAY);
    expect(await rt.run({ until: isSelectPlaylist })).toBe('until');
    console.log(`disc-bdj: boot() to the first selectPlaylistN in ${(performance.now() - t0).toFixed(0)} ms`);
    expect(trace().filter((e) => CONTROL_CALLS.has(e.call)).map((e) => JSON.stringify(e))).toEqual(GOLDEN);
    expect(trace().at(-1)?.call).toBe('selectPlaylistN');
    expect(lines.some((l) => l.endsWith(': FirstPlayXlet: start'))).toBe(true);
    expect(lines.some((l) => l.endsWith(': TitleXlet: start'))).toBe(true);
    expect(lines).toContain(`bdj_process_event(START,${FIRST_PLAY})`);
  }, 60_000);

  it('runs events one at a time: an event starts only after the previous one has returned', async () => {
    const { rt, trace } = runtime();
    await rt.boot();
    const threads = rt.jvm.threads;
    const events: JThread[] = [];
    let overlapped = false;
    const spawn = threads.spawn.bind(threads);
    threads.spawn = (javaThread, m, args) => {
      const isEvent = m.name === 'processEvent';
      if (isEvent && events.some((t) => t.state !== 'terminated')) overlapped = true;
      const t = spawn(javaThread, m, args);
      if (isEvent) events.push(t);
      return t;
    };
    rt.start(FIRST_PLAY);
    rt.processEvent(BdjEvent.PSR102, 7);
    rt.processEvent(BdjEvent.VK_KEY, 0x80000010);
    expect(events).toHaveLength(1);
    expect(await rt.run({ until: isSelectPlaylist })).toBe('until');
    expect(events).toHaveLength(3);
    expect(overlapped).toBe(false);
    expect(trace().filter((e) => CONTROL_CALLS.has(e.call)).map((e) => JSON.stringify(e))).toEqual(GOLDEN);
  }, 60_000);

  it("bounds a held key's repeats waiting behind a running event, in order (input.ts)", async () => {
    const { rt } = runtime();
    await rt.boot();
    const threads = rt.jvm.threads;
    const params: number[] = [];
    const spawn = threads.spawn.bind(threads);
    threads.spawn = (javaThread, m, args) => {
      if (m.name === 'processEvent') params.push(Number(args[1]) >>> 0);
      return spawn(javaThread, m, args);
    };
    rt.start(FIRST_PLAY); // its event runs while the keys wait
    rt.processEvent(BdjEvent.VK_KEY, 0xe000000d); // DOWN
    for (let i = 0; i < 40; i++) rt.processEvent(BdjEvent.VK_KEY, 0xe000000d, 'repeat');
    rt.processEvent(BdjEvent.VK_KEY, 0xe0000010); // ENTER: never dropped
    expect(rt.pendingEvents).toBe(9);
    expect(await rt.run({ until: isSelectPlaylist })).toBe('until');
    await rt.run();
    expect(params).toEqual([FIRST_PLAY, ...Array(8).fill(0xe000000d), 0xe0000010]);
  }, 60_000);

  it('rejects run() with an internal error when the host throws, with the Java stack at fault', async () => {
    const wrap = (h: RecordingHost): BdjHost =>
      new Proxy(h, {
        get: (target, key) => {
          if (key === 'selectPlaylist') {
            return () => {
              throw new Error('player failed');
            };
          }
          const v: unknown = Reflect.get(target, key);
          return typeof v === 'function' ? (v as () => unknown).bind(target) : v;
        },
      });
    const { rt } = runtime({ wrap });
    await rt.boot();
    rt.start(FIRST_PLAY);
    const err: unknown = await rt.run().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(BdjError);
    expect((err as BdjError).code).toBe('internal');
    expect((err as BdjError).message).toContain('player failed');
    expect((err as BdjError).javaStack[0]).toMatch(/^org\.videolan\.Libbluray\.selectPlaylistN\(Native Method\)$/);
    expect(() => rt.start(1)).toThrow(BdjError);
  }, 60_000);

  it('surfaces Runtime.halt: run() resolves idle and later events are refused', async () => {
    const { rt } = runtime();
    await rt.boot();
    await rt.jvm.callStatic('java/lang/Shutdown', 'halt', '(I)V', [3]);
    expect(rt.exitStatus).toBe(3);
    expect(await rt.run()).toBe('idle');
    expect(() => rt.start(FIRST_PLAY)).toThrow(/halted with status 3/);
    await rt.stop();
  }, 60_000);

  it('fails boot with class-not-found when libbluray-j2se.jar lacks org/videolan/Libbluray', async () => {
    const z = ZipArchive.open(CLASSES.libbluray);
    const entries = z.names.filter((n) => n !== 'org/videolan/Libbluray.class').map((n) => [n, z.read(n)!] as const);
    const { rt } = runtime({ classLibrary: { ...CLASSES, libbluray: storedZip(entries) } });
    const err: unknown = await rt.boot().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(BdjError);
    expect((err as BdjError).code).toBe('class-not-found');
    expect((err as BdjError).message).toContain('org/videolan/Libbluray');
    expect(rt.jvm.threads.live).toEqual([]);
    expect(rt.jvm.threads.isHalted).toBe(true);
  }, 60_000);

  it('logs an uncaught exception in another Java thread and keeps running', async () => {
    const { rt, lines, trace } = runtime();
    await rt.boot();
    rt.jvm.loader.define('bdjweb/Boom', threadClass('bdjweb/Boom', [
      NEW, { c: ['class', 'java/lang/RuntimeException'] }, DUP, LDC_W, { c: ['string', 'xlet failure'] },
      INVOKESPECIAL, { c: ['method', 'java/lang/RuntimeException', '<init>', '(Ljava/lang/String;)V'] }, ATHROW,
    ]), null, null);
    await rt.jvm.callStatic('bdjweb/Boom', 'go', '(Ljava/lang/ThreadGroup;)V', [null]);
    rt.start(FIRST_PLAY);
    expect(await rt.run({ until: isSelectPlaylist })).toBe('until');
    expect(lines.some((l) => l.includes('java.lang.RuntimeException: xlet failure'))).toBe(true);
    expect(trace().filter((e) => CONTROL_CALLS.has(e.call)).map((e) => JSON.stringify(e))).toEqual(GOLDEN);
  }, 60_000);

  it('stop() returns within its timeout while a thread of the running xlet spins', async () => {
    const { rt, lines } = runtime({ realClock: true });
    await rt.boot();
    rt.start(FIRST_PLAY);
    expect(await rt.run({ until: isSelectPlaylist })).toBe('until');
    const jvm = rt.jvm;
    const str = (o: unknown, f: string): string | null => jvm.heap.jsString(jvm.getField(o as JObject, f, 'Ljava/lang/String;') as JObject | null);
    const group = (t: JThread): JObject => jvm.getField(t.javaThread!, 'group', 'Ljava/lang/ThreadGroup;') as JObject;
    const xlet = jvm.threads.live.find((t) => t.javaThread && str(group(t), 'name')?.endsWith('bdjweb.test.TitleXlet'));
    expect(xlet).toBeDefined();
    jvm.loader.define('bdjweb/Spin', threadClass('bdjweb/Spin', [GOTO, 0, 0]), null, null);
    await jvm.callStatic('bdjweb/Spin', 'go', '(Ljava/lang/ThreadGroup;)V', [group(xlet!)]);
    const t0 = performance.now();
    await rt.stop(1000);
    const ms = performance.now() - t0;
    expect(ms).toBeGreaterThanOrEqual(900);
    expect(ms).toBeLessThan(3000);
    expect(lines).toContain('bdj_process_event(STOP,0)');
    expect(jvm.threads.live).toEqual([]);
    expect(await rt.run()).toBe('idle');
    expect(() => rt.processEvent(BdjEvent.VK_KEY, 0)).toThrow(BdjError);
  }, 60_000);
});
