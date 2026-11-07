import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { fixtureDiscFiles } from '../../tests/helpers/fixture-disc';
import { VirtualClock, assembleClass, storedZip } from '../../tests/helpers/jvm-asm';
import { discEntries } from '../../tests/helpers/synthetic-disc';
import type { DiscSpec } from '@seikou/engine/disc/disc-spec';
import { runBdjWorker, type BdjWorkerHandle } from './bdj-worker';
import { ZipArchive } from './jvm/zip';
import { BdjEvent, type ClassLibrarySource } from './runtime';
import { BdjSession, DUMP_WAIT_MS, IO_PAUSE_CEILING_MS, STOP_SAVE_WAIT_MS, type BdjFailureCode, type WorkerLike } from './session';
import { createGraphicsPlane } from './graphics-plane';
import { createRegisterBuffer } from './shared-registers';
import { StatusBlockReader, StatusBlockWriter, createStatusBlock } from './status-block';
import type { StorageLoss } from './store/bdj-store';
import type { BdjCallName, BdjWireValue, FromBdj, ToBdj } from './worker-protocol';

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
const GOLDEN_RETURNS: Partial<Record<BdjCallName, number>> = { writeReg: 0, selectPlaylist: 1 };
const FIRST_PLAY = 0xffff;
const DISC: DiscSpec = { kind: 'files', entries: discEntries(fixtureDiscFiles('disc-bdj')) };
const INVOKESTATIC = 0xb8, ICONST_3 = 0x06, RETURN = 0xb1;

type Call = { readonly name: BdjCallName; readonly args: readonly BdjWireValue[] };

/** The engine end of an in-process BD-J worker over a MessageChannel. */
function inProcessWorker(): { readonly worker: WorkerLike; readonly handle: BdjWorkerHandle; readonly terminated: () => boolean } {
  const { port1, port2 } = new MessageChannel();
  const handle = runBdjWorker(port2 as unknown as Parameters<typeof runBdjWorker>[0]);
  let terminated = false;
  const worker: WorkerLike = {
    postMessage: (m: ToBdj) => port1.postMessage(m),
    set onmessage(fn: ((e: MessageEvent<FromBdj>) => void) | null) {
      port1.onmessage = fn as ((e: MessageEvent) => void) | null;
    },
    get onmessage() {
      return port1.onmessage as ((e: MessageEvent<FromBdj>) => void) | null;
    },
    terminate: () => {
      terminated = true;
      port1.close();
      port2.close();
    },
  };
  return { worker, handle, terminated: () => terminated };
}

/** A worker the test drives by hand. */
function fakeWorker(): { readonly worker: WorkerLike; readonly sent: ToBdj[]; emit(m: FromBdj): void; readonly terminated: () => boolean } {
  const sent: ToBdj[] = [];
  let terminated = false;
  const worker: WorkerLike = {
    postMessage: (m) => void sent.push(m),
    onmessage: null,
    terminate: () => void (terminated = true),
  };
  return { worker, sent, emit: (m) => worker.onmessage?.({ data: m } as MessageEvent<FromBdj>), terminated: () => terminated };
}

interface Harness {
  readonly session: BdjSession;
  readonly calls: Call[];
  readonly failures: [BdjFailureCode, string][];
  readonly logs: string[];
  readonly clock: VirtualClock;
  readonly status: StatusBlockReader;
}

const sessions: BdjSession[] = [];
afterEach(() => {
  for (const s of sessions.splice(0)) s.stop();
});

function session(worker: WorkerLike, answer: (c: Call) => number | string = (c) => GOLDEN_RETURNS[c.name] ?? 0, time45 = 0n, extra: { readonly hidden?: boolean; readonly onStorageLost?: (reason: StorageLoss) => void } = {}): Harness {
  const calls: Call[] = [];
  const failures: [BdjFailureCode, string][] = [];
  const logs: string[] = [];
  const clock = new VirtualClock();
  const statusBuf = createStatusBlock();
  const s = new BdjSession({
    worker,
    host: {
      handle: (name, args) => {
        calls.push({ name, args });
        return Promise.resolve(answer({ name, args }));
      },
    },
    regs: createRegisterBuffer(),
    status: new StatusBlockWriter(statusBuf),
    plane: createGraphicsPlane(),
    time45: () => time45,
    onFailed: (code, message) => void failures.push([code, message]),
    onLog: (line) => void logs.push(line),
    nowMs: clock.nowMs,
    wallMs: clock.nowMs,
    setTimer: clock.setTimer,
    ...extra,
  });
  sessions.push(s);
  return { session: s, calls, failures, logs, clock, status: new StatusBlockReader(statusBuf) };
}

async function until(cond: () => boolean, ms = 60_000): Promise<void> {
  const end = performance.now() + ms;
  while (!cond()) {
    if (performance.now() > end) throw new Error('timed out waiting');
    await new Promise((r) => setTimeout(r, 5));
  }
}

const asGolden = (c: Call): string => JSON.stringify({ call: `${c.name}N`, args: c.args, ret: c.name in GOLDEN_RETURNS ? GOLDEN_RETURNS[c.name] : null });

describe('BdjSession with the in-process BD-J worker on disc-bdj', () => {
  it("boots, starts First Play and answers the golden's control calls in order through the host", async () => {
    const w = inProcessWorker();
    const h = session(w.worker, undefined, 4500n);
    await h.session.boot(DISC, 0, null, CLASSES);
    expect(h.logs.some((l) => l.includes("Using Java 1.8 (5b) from '/jdk'"))).toBe(true);
    h.session.start(FIRST_PLAY);
    await until(() => h.calls.some((c) => c.name === 'selectPlaylist'));
    // the golden ends at the first selectPlaylistN; Java goes on past it
    const first = h.calls.findIndex((c) => c.name === 'selectPlaylist');
    expect(h.calls.slice(0, first + 1).map(asGolden)).toEqual(GOLDEN);
    expect(h.status.time45()).toBe(4500n);
    expect(h.logs.some((l) => l.endsWith(': FirstPlayXlet: start'))).toBe(true);
    expect(h.logs.filter((l) => l.endsWith(': TitleXlet: start'))).toHaveLength(1);
    expect(h.clock.pending).toBe(0);
    expect(h.failures).toEqual([]);
  }, 60_000);

  it('reports class-not-found when the class library lacks org/videolan/Libbluray', async () => {
    const z = ZipArchive.open(CLASSES.libbluray);
    const entries = z.names.filter((n) => n !== 'org/videolan/Libbluray.class').map((n) => [n, z.read(n)!] as const);
    const w = inProcessWorker();
    const h = session(w.worker);
    await h.session.boot(DISC, 0, null, { ...CLASSES, libbluray: storedZip(entries) });
    expect(h.failures).toHaveLength(1);
    expect(h.failures[0]![0]).toBe('class-not-found');
    expect(h.failures[0]![1]).toContain('org/videolan/Libbluray');
    expect(w.terminated()).toBe(true);
  }, 60_000);

  it('reports halted when the JVM halts mid-title, and later engine events do not throw', async () => {
    const w = inProcessWorker();
    const h = session(w.worker);
    await h.session.boot(DISC, 0, null, CLASSES);
    h.session.start(FIRST_PLAY);
    await until(() => h.calls.some((c) => c.name === 'selectPlaylist'));
    const rt = w.handle.runtime!;
    const cls = rt.jvm.loader.define('bdjweb/Halt', assembleClass('bdjweb/Halt', [{
      name: 'go',
      desc: '()V',
      code: [
        // Shutdown.halt, below Runtime.halt's security check (BDJSecurityManager denies exit to xlets)
        ICONST_3, INVOKESTATIC, { c: ['method', 'java/lang/Shutdown', 'halt', '(I)V'] }, RETURN,
      ],
    }]), null, null);
    rt.jvm.threads.spawn(rt.jvm.mainThread, cls.methods.get('go()V')!, []);
    h.session.event(BdjEvent.PSR102, 1);
    await until(() => h.failures.length > 0);
    expect(h.failures).toEqual([['halted', 'the JVM halted with status 3']]);
    expect(rt.exitStatus).toBe(3);
    expect(w.terminated()).toBe(true);
    expect(() => {
      h.session.event(BdjEvent.PTS, 100);
      h.session.start(1);
    }).not.toThrow();
    expect(h.failures).toHaveLength(1);
  }, 60_000);
});

describe('BdjSession rules', () => {
  it('fails with timeout when no playlist is selected within 20,000 ms of start', () => {
    const f = fakeWorker();
    const h = session(f.worker);
    void h.session.boot(DISC, 0, null, CLASSES);
    f.emit({ type: 'booted', bootMs: 10 });
    h.session.start(FIRST_PLAY);
    f.emit({ type: 'call', id: 1, name: 'selectPlaylist', args: [-1, -1, -1, '-1'] }); // a close is no selection
    h.clock.advance(19_999);
    expect(h.failures).toEqual([]);
    h.clock.advance(1);
    // the engine's side goes to the log and the worker is asked for a thread dump; its answer ends the session
    expect(h.logs.at(-1)).toBe('BD-J start-up timeout: booted, the engine is answering selectPlaylist#1, 0 messages held');
    expect(f.sent.at(-1)).toEqual({ type: 'dump', reason: 'start-up timeout' });
    expect(h.failures).toEqual([]);
    f.emit({ type: 'dumped' });
    expect(h.failures).toEqual([['timeout', 'no playlist was selected and nothing was shown within 20 s']]);
    expect(f.terminated()).toBe(true);
  });

  it('counts only visible time: hidden for 60 s mid-boot, no fallback; then 20 s of visible time in all (ruling R22)', () => {
    const f = fakeWorker();
    const h = session(f.worker);
    void h.session.boot(DISC, 0, null, CLASSES);
    h.clock.advance(5_000);
    h.session.setHidden(true);
    h.clock.advance(60_000);
    expect(f.sent.some((m) => m.type === 'dump')).toBe(false);
    h.session.setHidden(false);
    h.clock.advance(14_999);
    expect(f.sent.some((m) => m.type === 'dump')).toBe(false);
    h.clock.advance(1);
    expect(f.sent.at(-1)).toEqual({ type: 'dump', reason: 'start-up timeout' });
    f.emit({ type: 'dumped' });
    expect(h.failures).toEqual([['timeout', 'no playlist was selected and nothing was shown within 20 s']]);
  });

  it("does not count time Java waits on its own reads: 60 s of slow disc reads, no fallback; a hang with none pending still falls back at 20 s (Task 7g)", () => {
    const f = fakeWorker();
    const h = session(f.worker);
    void h.session.boot(DISC, 0, null, CLASSES);
    f.emit({ type: 'booted', bootMs: 10 });
    h.session.start(FIRST_PLAY);
    h.clock.advance(5_000);
    // a JAR read over a slow link: pending for 60 s in all, with Java running for 4 s between two of its reads
    f.emit({ type: 'io', pending: true });
    h.clock.advance(30_000);
    f.emit({ type: 'io', pending: false });
    h.clock.advance(4_000);
    f.emit({ type: 'io', pending: true });
    h.clock.advance(30_000);
    expect(f.sent.some((m) => m.type === 'dump')).toBe(false);
    f.emit({ type: 'io', pending: false });
    // 9 s were counted: 11 s more without a read pending is the hang
    h.clock.advance(10_999);
    expect(f.sent.some((m) => m.type === 'dump')).toBe(false);
    h.clock.advance(1);
    expect(f.sent.at(-1)).toEqual({ type: 'dump', reason: 'start-up timeout' });
    f.emit({ type: 'dumped' });
    expect(h.failures).toEqual([['timeout', 'no playlist was selected and nothing was shown within 20 s']]);
  });

  it('a read that never lands pauses the budget for 120 s at most; the fallback follows 20 s of counted time later (R26)', () => {
    const f = fakeWorker();
    const h = session(f.worker);
    void h.session.boot(DISC, 0, null, CLASSES);
    f.emit({ type: 'booted', bootMs: 10 });
    h.session.start(FIRST_PLAY);
    f.emit({ type: 'io', pending: true }); // and never false
    h.clock.advance(IO_PAUSE_CEILING_MS - 1);
    expect(h.logs.some((l) => l.includes('waited on its reads'))).toBe(false);
    h.clock.advance(1);
    expect(h.logs.filter((l) => l.includes('waited on its reads'))).toEqual(['BD-J start-up timeout: the worker has waited on its reads for 120 s in all; waiting counts from now on']);
    expect(f.sent.some((m) => m.type === 'dump')).toBe(false);
    h.clock.advance(19_999);
    expect(f.sent.some((m) => m.type === 'dump')).toBe(false);
    h.clock.advance(1);
    expect(f.sent.at(-1)).toEqual({ type: 'dump', reason: 'start-up timeout' });
    f.emit({ type: 'dumped' });
    expect(h.failures).toEqual([['timeout', 'no playlist was selected and nothing was shown within 20 s']]);
    expect(h.logs.filter((l) => l.includes('waited on its reads'))).toHaveLength(1); // logged once
  });

  it('the 120 s ceiling is the total of all waits in a boot, not of each one (R26)', () => {
    const f = fakeWorker();
    const h = session(f.worker);
    void h.session.boot(DISC, 0, null, CLASSES);
    for (let i = 0; i < 4; i++) {
      f.emit({ type: 'io', pending: true });
      h.clock.advance(30_000);
      f.emit({ type: 'io', pending: false });
      h.clock.advance(1_000); // 4 s counted in all
    }
    // the ceiling is reached: a fifth wait counts, 16 s of the budget left
    f.emit({ type: 'io', pending: true });
    h.clock.advance(15_999);
    expect(f.sent.some((m) => m.type === 'dump')).toBe(false);
    h.clock.advance(1);
    expect(f.sent.at(-1)).toEqual({ type: 'dump', reason: 'start-up timeout' });
  });

  it('io after the timeout has fired, or after stop(), changes nothing (Task 7g)', async () => {
    const f = fakeWorker();
    const h = session(f.worker);
    void h.session.boot(DISC, 0, null, CLASSES);
    h.clock.advance(20_000);
    expect(f.sent.at(-1)).toEqual({ type: 'dump', reason: 'start-up timeout' });
    f.emit({ type: 'io', pending: true }); // ignored: only the dump is waited for
    h.clock.advance(DUMP_WAIT_MS);
    expect(h.failures).toEqual([['timeout', 'no playlist was selected and nothing was shown within 20 s']]);

    const g = fakeWorker();
    const k = session(g.worker);
    void k.session.boot(DISC, 0, null, CLASSES);
    await k.session.stop();
    const sent = g.sent.length;
    g.emit({ type: 'io', pending: true });
    g.emit({ type: 'io', pending: false });
    k.clock.advance(60_000);
    expect(g.sent.length).toBe(sent);
    expect(k.failures).toEqual([]);
  });

  it('a read pending across a hide and a show still pauses the budget once shown (Task 7g, ruling R22)', () => {
    const f = fakeWorker();
    const h = session(f.worker);
    void h.session.boot(DISC, 0, null, CLASSES);
    h.clock.advance(2_000);
    f.emit({ type: 'io', pending: true });
    h.session.setHidden(true);
    h.clock.advance(10_000);
    h.session.setHidden(false);
    h.clock.advance(40_000);
    expect(f.sent.some((m) => m.type === 'dump')).toBe(false);
    f.emit({ type: 'io', pending: false });
    h.clock.advance(17_999);
    expect(f.sent.some((m) => m.type === 'dump')).toBe(false);
    h.clock.advance(1);
    expect(f.sent.at(-1)).toEqual({ type: 'dump', reason: 'start-up timeout' });
  });

  it('the first playlist is logged with the budget it used (Task 7g)', () => {
    const f = fakeWorker();
    const h = session(f.worker);
    void h.session.boot(DISC, 0, null, CLASSES);
    f.emit({ type: 'booted', bootMs: 10 });
    h.session.start(FIRST_PLAY);
    h.clock.advance(3_000);
    f.emit({ type: 'io', pending: true });
    h.clock.advance(5_000);
    f.emit({ type: 'io', pending: false });
    h.clock.advance(1_500);
    f.emit({ type: 'call', id: 1, name: 'selectPlaylist', args: [0, -1, -1, '-1'] });
    expect(h.logs).toContain('BD-J selected its first playlist 9500 ms after boot (4500 ms of the start-up timeout counted; 5000 ms waiting on reads)');
  });

  it('a session made while the page is hidden waits for it to be shown', () => {
    const f = fakeWorker();
    const h = session(f.worker, undefined, 0n, { hidden: true });
    void h.session.boot(DISC, 0, null, CLASSES);
    h.clock.advance(120_000);
    expect(f.sent.some((m) => m.type === 'dump')).toBe(false);
    h.session.setHidden(false);
    h.clock.advance(20_000);
    expect(f.sent.at(-1)).toEqual({ type: 'dump', reason: 'start-up timeout' });
  });

  it('a host sleep (a wall-clock gap of 5 s beyond a tick) restarts the budget instead of firing (ruling R22)', () => {
    const f = fakeWorker();
    const h = session(f.worker);
    void h.session.boot(DISC, 0, null, CLASSES);
    h.clock.advance(15_000);
    h.clock.sleep(1_000_000); // the clock moves on, no timer fires until the host wakes
    h.clock.advance(0);
    expect(f.sent.some((m) => m.type === 'dump')).toBe(false);
    expect(h.logs).toContain('BD-J start-up timeout restarted: the host did not run for 1000 s');
    h.clock.advance(19_999);
    expect(f.sent.some((m) => m.type === 'dump')).toBe(false);
    h.clock.advance(1);
    expect(f.sent.at(-1)).toEqual({ type: 'dump', reason: 'start-up timeout' });
    // a gap under 5 s beyond the tick is ordinary lateness and counts
    const g = fakeWorker();
    const k = session(g.worker);
    void k.session.boot(DISC, 0, null, CLASSES);
    k.clock.advance(15_000);
    k.clock.sleep(4_000); // 3 s late beyond its 1 s tick
    k.clock.advance(0);
    expect(g.sent.some((m) => m.type === 'dump')).toBe(false);
    k.clock.advance(1_000);
    expect(g.sent.at(-1)).toEqual({ type: 'dump', reason: 'start-up timeout' });
  });

  it('fails with timeout 20,000 ms after a boot that never completes', async () => {
    const f = fakeWorker();
    const h = session(f.worker);
    const booted = h.session.boot(DISC, 0, null, CLASSES);
    h.clock.advance(19_999);
    expect(h.failures).toEqual([]);
    h.clock.advance(1);
    expect(h.logs.at(-1)).toBe('BD-J start-up timeout: not booted, no call in the engine, 0 messages held');
    // a worker whose event loop is blocked never answers: the session fails DUMP_WAIT_MS later all the same
    h.clock.advance(DUMP_WAIT_MS - 1);
    expect(h.failures).toEqual([]);
    h.clock.advance(1);
    expect(h.logs.at(-1)).toBe(`BD-J worker sent no thread dump within ${DUMP_WAIT_MS} ms (its event loop is blocked)`);
    expect(h.failures.map(([c]) => c)).toEqual(['timeout']);
    expect(f.terminated()).toBe(true);
    await booted; // settles at the stop
  });

  it('once the timeout has fired, Java is no longer answered while its dump comes: the fallback starts nothing', async () => {
    const f = fakeWorker();
    const h = session(f.worker);
    void h.session.boot(DISC, 0, null, CLASSES);
    f.emit({ type: 'booted', bootMs: 10 });
    h.session.start(FIRST_PLAY);
    h.clock.advance(20_000);
    expect(f.sent.at(-1)).toEqual({ type: 'dump', reason: 'start-up timeout' });
    f.emit({ type: 'call', id: 1, name: 'selectPlaylist', args: [5, -1, -1, '-1'] });
    f.emit({ type: 'background', image: new Uint8Array([1]), rect: { x: 0, y: 0, width: 1, height: 1 } });
    f.emit({ type: 'dumped' });
    await new Promise((r) => setTimeout(r, 10));
    expect(h.calls).toEqual([]);
    expect(f.sent.some((m) => m.type === 'reply')).toBe(false);
    expect(h.failures).toEqual([['timeout', 'no playlist was selected and nothing was shown within 20 s']]);
    expect(h.logs.some((l) => l.includes('selected its first playlist'))).toBe(false);
  });

  it('a selected playlist cancels the timeout', async () => {
    const f = fakeWorker();
    const h = session(f.worker);
    h.session.start(FIRST_PLAY);
    f.emit({ type: 'call', id: 1, name: 'selectPlaylist', args: [0, -1, -1, '-1'] });
    h.clock.advance(60_000);
    expect(h.failures).toEqual([]);
    await until(() => f.sent.some((m) => m.type === 'reply'));
    expect(f.sent.at(-1)).toEqual({ type: 'reply', id: 1, value: 1 });
  });

  it('a menu shown or a background still shown cancels the timeout; a cleared still does not (ruling R7)', () => {
    for (const show of ['menu', 'still'] as const) {
      const f = fakeWorker();
      const h = session(f.worker);
      h.session.start(FIRST_PLAY);
      f.emit({ type: 'background', image: null, rect: { x: 0, y: 0, width: 1, height: 1 } });
      h.clock.advance(10_000);
      if (show === 'menu') h.session.menuShown();
      else f.emit({ type: 'background', image: new Uint8Array([1]), rect: { x: 0, y: 0, width: 1, height: 1 } });
      h.clock.advance(60_000);
      expect(h.failures).toEqual([]);
      const counted = '(10000 ms of the start-up timeout counted; 0 ms waiting on reads)';
      expect(h.logs).toContain(show === 'menu' ? `BD-J showed a menu 10000 ms after boot ${counted}` : `BD-J showed a background still 10000 ms after boot ${counted}`);
    }
  });

  it('ignores messages after stop() and terminates the worker', async () => {
    const f = fakeWorker();
    const h = session(f.worker);
    const booted = h.session.boot(DISC, 0, null, CLASSES);
    h.session.start(FIRST_PLAY);
    const sent = f.sent.length;
    h.session.stop();
    expect(f.terminated()).toBe(true);
    await booted; // a pending boot settles at stop
    f.emit({ type: 'call', id: 1, name: 'writeReg', args: [1, 4, 1, -1] });
    f.emit({ type: 'failed', code: 'internal', message: 'late' });
    f.emit({ type: 'log', line: 'late', error: false });
    h.session.event(BdjEvent.PTS, 1);
    h.session.start(1);
    h.clock.advance(30_000);
    await new Promise((r) => setTimeout(r, 0));
    expect(h.calls).toEqual([]);
    expect(h.failures).toEqual([]);
    expect(h.logs).not.toContain('late');
    expect(f.sent.length).toBe(sent);
  });

  it('asks a worker with storage scopes to flush when the page is shown again (a NAS disc\'s write-ahead copy, ruling R17)', () => {
    const f = fakeWorker();
    const h = session(f.worker);
    void h.session.boot(DISC, 0, null, CLASSES);
    f.emit({ type: 'booted', bootMs: 1 });
    h.session.setHidden(true);
    h.session.setHidden(false);
    expect(f.sent.map((m) => m.type)).toEqual(['boot']); // no scopes: nothing to flush
    f.emit({ type: 'unsaved', unsaved: false });
    h.session.setHidden(true);
    h.session.setHidden(false);
    h.session.setHidden(false); // no change: nothing more
    expect(f.sent.map((m) => m.type)).toEqual(['boot', 'flush']);
  });

  it("passes the worker's storageLost on (the bdj-storage notice, ruling R32), and nothing of it once stopped", async () => {
    const f = fakeWorker();
    const lost: StorageLoss[] = [];
    const h = session(f.worker, undefined, 0n, { onStorageLost: (reason) => void lost.push(reason) });
    void h.session.boot(DISC, 0, null, CLASSES);
    f.emit({ type: 'unsaved', unsaved: false });
    f.emit({ type: 'storageLost', reason: 'memory-only' }); // before the boot is through: the scopes load during it
    f.emit({ type: 'booted', bootMs: 1 });
    expect(lost).toEqual(['memory-only']);
    const stopped = h.session.stop();
    f.emit({ type: 'storageLost', reason: 'full' }); // the stop's save, while the engine waits for it
    f.emit({ type: 'stopped' });
    await stopped;
    f.emit({ type: 'storageLost', reason: 'put-failed' });
    expect(lost).toEqual(['memory-only']);
  });

  it('with unsaved storage changes, a stop lets the worker save them (stop, stopped) before it is terminated', async () => {
    const f = fakeWorker();
    const h = session(f.worker);
    void h.session.boot(DISC, 0, null, CLASSES);
    f.emit({ type: 'booted', bootMs: 1 });
    h.session.flush();
    expect(f.sent.map((m) => m.type)).toEqual(['boot']); // nothing to save yet
    f.emit({ type: 'unsaved', unsaved: true });
    h.session.flush(); // pagehide
    expect(f.sent.map((m) => m.type)).toEqual(['boot', 'flush']);
    let done = false;
    const stopped = h.session.stop().then(() => void (done = true));
    expect(f.sent.at(-1)).toEqual({ type: 'stop' });
    expect(f.terminated()).toBe(false);
    f.emit({ type: 'call', id: 1, name: 'writeReg', args: [1, 4, 1, -1] }); // Java is not answered after the stop
    f.emit({ type: 'log', line: 'BD-J storage: saved', error: false });
    expect(h.calls).toEqual([]);
    expect(h.logs).toContain('BD-J storage: saved');
    await Promise.resolve();
    expect(done).toBe(false);
    f.emit({ type: 'stopped' });
    await stopped;
    expect(f.terminated()).toBe(true);
    expect(h.session.stop()).toBe(h.session.stop()); // once
  });

  it('terminates a worker that does not answer the stop within STOP_SAVE_WAIT_MS; one without scopes stops at once', async () => {
    const f = fakeWorker();
    const h = session(f.worker);
    void h.session.boot(DISC, 0, null, CLASSES);
    f.emit({ type: 'unsaved', unsaved: true });
    const stopped = h.session.stop();
    h.clock.advance(STOP_SAVE_WAIT_MS - 1);
    expect(f.terminated()).toBe(false);
    h.clock.advance(1);
    await stopped;
    expect(f.terminated()).toBe(true);
    expect(h.logs).toContain(`BD-J worker did not save its storage within ${STOP_SAVE_WAIT_MS} ms of the stop`);

    const g = fakeWorker();
    const k = session(g.worker);
    void k.session.boot(DISC, 0, null, CLASSES);
    g.emit({ type: 'booted', bootMs: 1 }); // no `unsaved`: the worker has no scopes
    k.session.flush();
    void k.session.stop();
    expect(g.terminated()).toBe(true);
    expect(g.sent.map((m) => m.type)).toEqual(['boot']);
  });

  it('with scopes, a stop always waits for the save, even before an unsaved change is heard of (one may be on its way)', async () => {
    const f = fakeWorker();
    const h = session(f.worker);
    void h.session.boot(DISC, 0, null, CLASSES);
    f.emit({ type: 'unsaved', unsaved: false }); // the scopes are loaded
    f.emit({ type: 'booted', bootMs: 1 });
    const stopped = h.session.stop();
    expect(f.sent.at(-1)).toEqual({ type: 'stop' });
    expect(f.terminated()).toBe(false);
    f.emit({ type: 'stopped' });
    await stopped;
    expect(f.terminated()).toBe(true);
  });

  it('sends a title start the host asks for during selectTitle only after that call is answered', async () => {
    const f = fakeWorker();
    let s: BdjSession | null = null;
    const h = session(f.worker, (c) => {
      if (c.name === 'selectTitle') {
        s!.start(2);
        s!.event(BdjEvent.PSR102, 5);
      }
      return 1;
    });
    s = h.session;
    f.emit({ type: 'call', id: 7, name: 'selectTitle', args: [2] });
    expect(f.sent).toEqual([]);
    await until(() => f.sent.length === 3);
    expect(f.sent).toEqual([
      { type: 'reply', id: 7, value: 1 },
      { type: 'start', title: 2 },
      { type: 'event', ev: BdjEvent.PSR102, param: 5 },
    ]);
  });

  it('still answers the call whose handling stopped the session (selectTitle of an HDMV title), and nothing else', async () => {
    const f = fakeWorker();
    let s: BdjSession | null = null;
    const h = session(f.worker, (c) => {
      if (c.name === 'selectTitle') {
        s!.stop(); // _play_hdmv → _stop_bdj; libbluray's selectTitleN still returns 1 to Java
        s!.event(BdjEvent.PSR102, 5);
      }
      return 1;
    });
    s = h.session;
    f.emit({ type: 'call', id: 7, name: 'selectTitle', args: [1] });
    await until(() => f.sent.length > 0);
    f.emit({ type: 'call', id: 8, name: 'writeReg', args: [0, 1, 2, -1] });
    await new Promise((r) => setTimeout(r, 10));
    expect(f.terminated()).toBe(true);
    expect(f.sent).toEqual([{ type: 'reply', id: 7, value: 1 }]);
    expect(h.calls.map((c) => c.name)).toEqual(['selectTitle']);
  });

  it('publishes the time before replying to seek', async () => {
    const f = fakeWorker();
    const h = session(f.worker, () => '1', 9000n);
    f.emit({ type: 'call', id: 3, name: 'seek', args: [-1, -1, '18000'] });
    await until(() => f.sent.length === 1);
    expect(h.status.time45()).toBe(9000n);
    expect(f.sent).toEqual([{ type: 'reply', id: 3, value: '1' }]);
  });

  it("reports a worker's failure once and stops", () => {
    const f = fakeWorker();
    const h = session(f.worker);
    f.emit({ type: 'failed', code: 'unsatisfied-link', message: 'x' });
    f.emit({ type: 'failed', code: 'internal', message: 'y' });
    expect(h.failures).toEqual([['unsatisfied-link', 'x']]);
    expect(f.terminated()).toBe(true);
  });
});
