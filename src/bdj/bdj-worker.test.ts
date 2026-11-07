import { readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import { createDiscHandler, discApiBase, findDiscs } from '../../tools/disc-server/server';
import { BDJ_REMOTE_CHUNK_BYTES, BDJ_REMOTE_IN_FLIGHT } from '@seikou/engine/disc/disc-spec';
import type { DiscManifest } from '@seikou/nas/nas-api';
import { IDBFactory } from 'fake-indexeddb';
import { listTar } from '../../server/src/tar';
import { FAKE_NAS_BASE, fakeNas } from '../../tests/helpers/fake-nas';
import { startStoreNas } from '../../tests/helpers/store-nas';
import { IdbBdjStore } from './store/idb-store';
import { personSource } from './store/nas-store';
import { fixtureDiscFiles } from '../../tests/helpers/fixture-disc';
import { discEntries, syntheticSource } from '../../tests/helpers/synthetic-disc';
import { ScopeQuotaError, type BdjStore, type LoadedSnapshot, type SaveResult, type Snapshot } from './store/bdj-store';
import { discScopes } from './store/scopes';
import { IoWatch, StartupWatch, runBdjWorker, type BdjPort } from './bdj-worker';
import { createGraphicsPlane } from './graphics-plane';
import { createRegisterBuffer } from './shared-registers';
import { createStatusBlock } from './status-block';
import type { FromBdj, ToBdj } from './worker-protocol';

const jar = (name: string): Uint8Array => new Uint8Array(readFileSync(fileURLToPath(new URL(`../bdj-classlib/${name}`, import.meta.url))));

describe('StartupWatch (the start-up deadlock dump)', () => {
  it('dumps the first deadlock only while Java has shown nothing: no playlist, visible plane or still (ruling R7)', () => {
    const idle = new StartupWatch();
    idle.call('selectPlaylist', [-1, -1, -1, '-1']); // a close selects nothing
    idle.still(null); // nor does a cleared still
    idle.plane(false);
    expect(idle.deadlock()).toBe(true);
    expect(idle.deadlock()).toBe(false); // once

    for (const show of [
      (w: StartupWatch) => w.call('selectPlaylist', [5, -1, -1, '-1']),
      (w: StartupWatch) => w.plane(true), // a still menu waiting for keys
      (w: StartupWatch) => w.still(new Uint8Array([1])),
    ]) {
      const w = new StartupWatch();
      show(w);
      w.plane(false); // a menu taken down later still showed Java runs
      expect(w.deadlock()).toBe(false);
    }
  });
});

describe('IoWatch (the worker waiting on its own I/O, Task 7g)', () => {
  const turn = (): Promise<void> => new Promise((r) => setTimeout(r, 5));
  const deferred = (): { promise: Promise<number>; resolve: () => void; reject: () => void } => {
    let resolve!: () => void;
    let reject!: () => void;
    const promise = new Promise<number>((res, rej) => {
      resolve = () => res(1);
      reject = () => rej(new Error('read failed'));
    });
    return { promise, resolve, reject };
  };
  const watch = (): { io: IoWatch; told: boolean[] } => {
    const told: boolean[] = [];
    return { io: new IoWatch((p) => void told.push(p)), told };
  };

  it('stays pending while any of two overlapping reads is pending', async () => {
    const { io, told } = watch();
    const a = deferred();
    const b = deferred();
    void io.track(a.promise);
    void io.track(b.promise);
    await turn();
    expect(told).toEqual([true]);
    a.resolve();
    await turn();
    expect(told).toEqual([true]);
    b.resolve();
    await turn();
    expect(told).toEqual([true, false]);
  });

  it('a rejected read clears, and the rejection reaches the reader', async () => {
    const { io, told } = watch();
    const a = deferred();
    const read = io.track(a.promise);
    await turn();
    a.reject();
    await expect(read).rejects.toThrow('read failed');
    await turn();
    expect(told).toEqual([true, false]);
  });

  it('reads answered from memory (settled within the turn) send nothing', async () => {
    const { io, told } = watch();
    const source = io.source({ exists: () => true, size: () => 4, list: () => [], paths: () => [], read: async () => new Uint8Array(4) });
    for (let i = 0; i < 10; i++) await source.read('BDMV/JAR/00000.JAR', 0, 4);
    await turn();
    expect(told).toEqual([]);
  });

  it('changes within one turn are told once, as the state at the end of the turn', async () => {
    const { io, told } = watch();
    const a = deferred();
    const b = deferred();
    void io.track(a.promise);
    a.resolve();
    await Promise.resolve();
    void io.track(b.promise);
    await turn();
    expect(told).toEqual([true]);
    b.resolve();
    const c = deferred();
    await Promise.resolve();
    void io.track(c.promise); // pending again before the turn ends: nothing changed
    await turn();
    expect(told).toEqual([true]);
  });

  it('tells nothing once stopped (the start-up timeout disarmed or fired)', async () => {
    const { io, told } = watch();
    const a = deferred();
    void io.track(a.promise);
    await turn();
    io.stop();
    a.resolve();
    void io.track(deferred().promise);
    await turn();
    expect(told).toEqual([true]);
  });

  it('StartupWatch stops it when Java first shows it runs, once', () => {
    let stops = 0;
    const w = new StartupWatch(() => void stops++);
    w.call('selectPlaylist', [-1, -1, -1, '-1']);
    w.plane(false);
    expect(stops).toBe(0);
    w.call('selectPlaylist', [5, -1, -1, '-1']);
    w.plane(true);
    w.still(new Uint8Array([1]));
    expect(stops).toBe(1);
  });
});

describe('runBdjWorker', () => {
  it("gives Java the wall clock: System.currentTimeMillis is the epoch time, as libbluray's JVM has it", async () => {
    const received: FromBdj[] = [];
    const port: BdjPort = { onmessage: null, postMessage: (m) => void received.push(m) };
    const handle = runBdjWorker(port);
    const boot: ToBdj = {
      type: 'boot',
      registers: createRegisterBuffer(),
      status: createStatusBlock(),
      plane: createGraphicsPlane(),
      disc: { kind: 'files', entries: discEntries(fixtureDiscFiles('disc-bdj')) },
      readAheadBytes: 0,
      discId: null,
      classLibrary: { rt: jar('rt-bdj.jar'), libbluray: jar('libbluray-j2se.jar'), libblurayAwt: jar('libbluray-awt-j2se.jar') },
    };
    port.onmessage!({ data: boot });
    await vi.waitFor(() => expect(received.map((m) => m.type)).toContain('booted'), { timeout: 60_000 });
    // a signed disc jar's certificates are checked against this clock (JarVerifier); 1970 sends them down another path
    const now = handle.runtime!.jvm.opts.nowMs();
    expect(Math.abs(now - Date.now())).toBeLessThan(5_000);
  }, 90_000);

  it('logs a thread dump when the engine asks (its start-up timeout), then answers dumped', async () => {
    const received: FromBdj[] = [];
    const port: BdjPort = { onmessage: null, postMessage: (m) => void received.push(m) };
    const handle = runBdjWorker(port);
    port.onmessage!({
      data: {
        type: 'boot',
        registers: createRegisterBuffer(),
        status: createStatusBlock(),
        plane: createGraphicsPlane(),
        disc: { kind: 'files', entries: discEntries(fixtureDiscFiles('disc-bdj')) },
        readAheadBytes: 0,
        discId: null,
        classLibrary: { rt: jar('rt-bdj.jar'), libbluray: jar('libbluray-j2se.jar'), libblurayAwt: jar('libbluray-awt-j2se.jar') },
      },
    });
    await vi.waitFor(() => expect(received.map((m) => m.type)).toContain('booted'), { timeout: 60_000 });
    port.onmessage!({ data: { type: 'dump', reason: 'start-up timeout' } });
    const [log, done] = received.slice(-2);
    expect(done).toEqual({ type: 'dumped' });
    const lines = log?.type === 'log' ? log.line.split('\n') : [];
    expect(lines[0]).toBe("BD-J thread dump (start-up timeout): booted, idle, 0 messages waiting for the boot, no call waiting for the engine, 0 deadlock outcomes");
    expect(lines[1]).toMatch(/^threads: \d+ live, /);
    expect(lines).toContainEqual(expect.stringMatching(/^#\d+ "Reference Handler" waiting on java\.lang\.ref\.Reference\$Lock@[0-9a-f]+$/));
    expect(lines).toContain('    at java.lang.ref.Reference.tryHandlePending(Reference.java:191)');
    expect(lines.at(-1)).toBe('events: 0 queued');
    handle.runtime!.jvm.threads.halt();
  }, 90_000);

  it('reports its memory after boot when asked (memoryStatsMs, telemetry runs), until the JVM halts', async () => {
    const received: FromBdj[] = [];
    const port: BdjPort = { onmessage: null, postMessage: (m) => void received.push(m) };
    const handle = runBdjWorker(port);
    port.onmessage!({
      data: {
        type: 'boot',
        registers: createRegisterBuffer(),
        status: createStatusBlock(),
        plane: createGraphicsPlane(),
        disc: { kind: 'files', entries: discEntries(fixtureDiscFiles('disc-bdj')) },
        readAheadBytes: 0,
        discId: null,
        classLibrary: { rt: jar('rt-bdj.jar'), libbluray: jar('libbluray-j2se.jar'), libblurayAwt: jar('libbluray-awt-j2se.jar') },
        memory: { classBytes: Infinity, vfsBytes: 64 * 1024 * 1024 },
        memoryStatsMs: 5000,
      },
    });
    await vi.waitFor(() => expect(received.map((m) => m.type)).toContain('memory'), { timeout: 60_000 });
    const m = received.find((r) => r.type === 'memory');
    expect(received.map((r) => r.type).indexOf('booted')).toBeLessThan(received.indexOf(m!));
    expect(m).toMatchObject({ type: 'memory', freeType: null, jvm: { classes: expect.any(Number), classFileBytes: expect.any(Number) } });
    expect(m!.type === 'memory' && m!.jvm.classes).toBeGreaterThan(500);
    handle.runtime!.jvm.threads.halt(); // ends the reports
  }, 90_000);

  it('reads a disc on the dev disc server itself (a remote DiscSpec, as for a NAS disc), as the engine worker does', async () => {
    const root = fileURLToPath(new URL('../../fixtures/synthetic/', import.meta.url));
    const paths: string[] = [];
    const handler = createDiscHandler({ roots: [root], token: 't' });
    const server = createServer((req, res) => {
      paths.push(req.url ?? '');
      handler(req, res);
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    try {
      const id = findDiscs([root]).find((d) => d.name === 'disc-bdj')!.id;
      const base = discApiBase(`http://127.0.0.1:${(server.address() as AddressInfo).port}`, id);
      const manifest = (await (await fetch(`${base}manifest`, { headers: { Authorization: 'Bearer t' } })).json()) as DiscManifest;
      const received: FromBdj[] = [];
      // the engine's part: every call Java makes is answered (0, success), so First Play goes on to select its playlist
      const port: BdjPort = {
        onmessage: null,
        postMessage: (m) => {
          received.push(m);
          if (m.type === 'call') setTimeout(() => port.onmessage!({ data: { type: 'reply', id: m.id, value: 0 } }), 0);
        },
      };
      runBdjWorker(port);
      port.onmessage!({
        data: {
          type: 'boot',
          registers: createRegisterBuffer(),
          status: createStatusBlock(),
          plane: createGraphicsPlane(),
          disc: { kind: 'remote', base, token: 't', manifest },
          readAheadBytes: 16 * 1024 * 1024,
          discId: null,
          classLibrary: { rt: jar('rt-bdj.jar'), libbluray: jar('libbluray-j2se.jar'), libblurayAwt: jar('libbluray-awt-j2se.jar') },
        },
      });
      await vi.waitFor(() => expect(received.map((m) => m.type)).toContain('booted'), { timeout: 60_000 });
      // First Play: the xlet's JAR is read and its Java calls the engine (selectPlaylist)
      port.onmessage!({ data: { type: 'start', title: 0xffff } });
      await vi.waitFor(() => expect(received.some((m) => m.type === 'call' && m.name === 'selectPlaylist')).toBe(true), { timeout: 60_000 });
      expect(received.some((m) => m.type === 'failed')).toBe(false);
      // the metadata came inlined in the manifest; the worker read the disc's JAR through the files route
      expect(paths).toContain(`/api/discs/${id}/manifest`);
      expect(paths.some((p) => p.startsWith(`/api/discs/${id}/files/BDMV/JAR/00000.JAR?t=t`))).toBe(true);
      expect(paths.some((p) => /INDEX\.BDMV/i.test(p) && p.includes('/files/'))).toBe(false);
    } finally {
      server.closeAllConnections();
      server.close();
    }
  }, 90_000);

  it("reads a NAS disc with the BD-J worker's own read-ahead: 512 KiB requests, at most 2 at once (ruling R20)", async () => {
    const nas = fakeNas(fixtureDiscFiles('disc-bdj'));
    const ranges: number[] = [];
    let inFlight = 0;
    let maxInFlight = 0;
    const fetch = (async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
      const m = /^bytes=(\d+)-(\d+)$/.exec(new Headers(init?.headers).get('Range') ?? '');
      if (m) ranges.push(Number(m[2]) - Number(m[1]) + 1);
      maxInFlight = Math.max(maxInFlight, ++inFlight);
      try {
        return await nas.fetch(input, init);
      } finally {
        inFlight--;
      }
    }) as typeof globalThis.fetch;
    const received: FromBdj[] = [];
    const port: BdjPort = {
      onmessage: null,
      postMessage: (m) => {
        received.push(m);
        if (m.type === 'call') setTimeout(() => port.onmessage!({ data: { type: 'reply', id: m.id, value: 0 } }), 0);
      },
    };
    runBdjWorker(port, { fetch });
    port.onmessage!({
      data: {
        type: 'boot',
        registers: createRegisterBuffer(),
        status: createStatusBlock(),
        plane: createGraphicsPlane(),
        disc: nas.spec,
        readAheadBytes: 1024 * 1024,
        discId: null,
        classLibrary: { rt: jar('rt-bdj.jar'), libbluray: jar('libbluray-j2se.jar'), libblurayAwt: jar('libbluray-awt-j2se.jar') },
      },
    });
    await vi.waitFor(() => expect(received.map((m) => m.type)).toContain('booted'), { timeout: 60_000 });
    port.onmessage!({ data: { type: 'start', title: 0xffff } });
    await vi.waitFor(() => expect(received.some((m) => m.type === 'call' && m.name === 'selectPlaylist')).toBe(true), { timeout: 60_000 });
    expect(received.some((m) => m.type === 'failed')).toBe(false);
    expect(nas.requested).toContain('BDMV/JAR/00000.JAR');
    expect(ranges.length).toBeGreaterThan(0);
    expect(Math.max(...ranges)).toBeLessThanOrEqual(BDJ_REMOTE_CHUNK_BYTES);
    expect(maxInFlight).toBeLessThanOrEqual(BDJ_REMOTE_IN_FLIGHT);
  }, 90_000);

  it("tells the engine while Java waits on a disc read (io), so a slow NAS is not taken for a hang (Task 7g)", async () => {
    const nas = fakeNas(fixtureDiscFiles('disc-bdj'));
    // a slow link for the xlet's JAR: its reads are held until the test lets them go
    let release!: () => void;
    const slow = new Promise<void>((resolve) => (release = resolve));
    let held = 0;
    const fetch = (async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
      if (String(input).includes('/files/BDMV/JAR/')) {
        held++;
        await slow;
      }
      return nas.fetch(input, init);
    }) as typeof globalThis.fetch;
    const received: FromBdj[] = [];
    const port: BdjPort = {
      onmessage: null,
      postMessage: (m) => {
        received.push(m);
        if (m.type === 'call') setTimeout(() => port.onmessage!({ data: { type: 'reply', id: m.id, value: 0 } }), 0);
      },
    };
    runBdjWorker(port, { fetch });
    port.onmessage!({
      data: {
        type: 'boot',
        registers: createRegisterBuffer(),
        status: createStatusBlock(),
        plane: createGraphicsPlane(),
        disc: nas.spec,
        readAheadBytes: 1024 * 1024,
        discId: null,
        classLibrary: { rt: jar('rt-bdj.jar'), libbluray: jar('libbluray-j2se.jar'), libblurayAwt: jar('libbluray-awt-j2se.jar') },
      },
    });
    await vi.waitFor(() => expect(received.map((m) => m.type)).toContain('booted'), { timeout: 60_000 });
    const io = (): boolean[] => received.flatMap((m) => (m.type === 'io' ? [m.pending] : []));
    // whatever the boot read has landed: nothing is pending now
    expect(io().at(-1) ?? false).toBe(false);
    port.onmessage!({ data: { type: 'start', title: 0xffff } });
    await vi.waitFor(() => expect(held).toBeGreaterThan(0), { timeout: 60_000 });
    await vi.waitFor(() => expect(io().at(-1)).toBe(true), { timeout: 10_000 });
    await new Promise((r) => setTimeout(r, 200));
    expect(io().at(-1)).toBe(true); // still waiting, and said once
    expect(received.some((m) => m.type === 'call' && m.name === 'selectPlaylist')).toBe(false);
    release();
    await vi.waitFor(() => expect(received.some((m) => m.type === 'call' && m.name === 'selectPlaylist')).toBe(true), { timeout: 60_000 });
    // the selected playlist disarms the session's start-up timeout: no io is sent after it, whatever Java reads next
    await new Promise((r) => setTimeout(r, 500));
    const selected = received.findIndex((m) => m.type === 'call' && m.name === 'selectPlaylist');
    expect(received.slice(selected).some((m) => m.type === 'io')).toBe(false);
    // only changes are sent: never two of the same in a row
    expect(io().every((p, i, all) => i === 0 || all[i - 1] !== p)).toBe(true);
    expect(received.some((m) => m.type === 'failed')).toBe(false);
  }, 90_000);
});

describe('runBdjWorker and the storage scopes', () => {
  class GatedStore implements BdjStore {
    readonly loads: string[] = [];
    readonly saved = new Map<string, Snapshot>();
    private release!: () => void;
    readonly gate = new Promise<void>((resolve) => (this.release = resolve));
    open(): void {
      this.release();
    }
    async load(scope: string): Promise<LoadedSnapshot> {
      this.loads.push(scope);
      await this.gate;
      return scope.startsWith('persistent/') ? { files: [{ path: '1/count', mtime: 1000, bytes: new Uint8Array([7]) }], etag: 'e1' } : { files: [], etag: null };
    }
    async save(scope: string, snapshot: Snapshot): Promise<SaveResult> {
      this.saved.set(scope, snapshot);
      return { etag: `e${this.saved.size + 1}` };
    }
  }

  it('boots Libbluray only once its scopes are loaded, and saves what Java wrote before it answers a stop', async () => {
    const received: FromBdj[] = [];
    const port: BdjPort = { onmessage: null, postMessage: (m) => void received.push(m) };
    const store = new GatedStore();
    const sources: string[] = [];
    const handle = runBdjWorker(port, { createStore: (source) => (sources.push(source), store) });
    const files = fixtureDiscFiles('disc-bdj');
    port.onmessage!({
      data: {
        type: 'boot',
        registers: createRegisterBuffer(),
        status: createStatusBlock(),
        plane: createGraphicsPlane(),
        disc: { kind: 'files', entries: discEntries(files) },
        readAheadBytes: 0,
        discId: null,
        classLibrary: { rt: jar('rt-bdj.jar'), libbluray: jar('libbluray-j2se.jar'), libblurayAwt: jar('libbluray-awt-j2se.jar') },
      },
    });
    const scopes = await discScopes(syntheticSource(files), null);
    expect(scopes.map((s) => s.key)).toEqual([expect.stringMatching(/^persistent\/[0-9a-f]{8}$/), expect.stringMatching(/^buda\/[0-9a-f]{8}\/[0-9a-f]{32}$/), expect.stringMatching(/^buda\/[0-9a-f]{8}$/)]);
    await vi.waitFor(() => expect(store.loads).toEqual(scopes.map((s) => s.key)));
    expect(sources).toEqual(['local']);
    await vi.waitFor(() => expect(handle.runtime).not.toBeNull());
    await handle.runtime!.bootJdk(); // the JDK starts meanwhile
    await new Promise((r) => setTimeout(r, 50));
    expect(received.map((m) => m.type)).not.toContain('booted');
    store.open();
    await vi.waitFor(() => expect(received.map((m) => m.type)).toContain('booted'), { timeout: 60_000 });
    const vfs = handle.runtime!.jvm.opts.vfs!;
    const persistent = scopes[0]!.dir;
    expect(vfs.stat(`${persistent}/1/count`)?.size).toBe(1);

    // a write through the VFS (as Java's FileOutputStream makes it) is unsaved until the stop saves it
    const h = vfs.open(`${persistent}/1/count`, 'w')!;
    vfs.write(h, new Uint8Array([8]), 0, 1);
    vfs.close(h);
    // false once the scopes are loaded (the engine then always waits for a stop's save), then true at the write
    expect(received.filter((m) => m.type === 'unsaved')).toEqual([
      { type: 'unsaved', unsaved: false },
      { type: 'unsaved', unsaved: true },
    ]);
    port.onmessage!({ data: { type: 'stop' } });
    await vi.waitFor(() => expect(received.at(-1)).toEqual({ type: 'stopped' }));
    expect([...store.saved.get(scopes[0]!.key)!.files[0]!.bytes]).toEqual([8]);
    expect(store.saved.has(scopes[1]!.key)).toBe(false);
    expect(received.filter((m) => m.type === 'unsaved').at(-1)).toEqual({ type: 'unsaved', unsaved: false });
    expect(handle.runtime!.jvm.threads.isHalted).toBe(true);
  }, 90_000);

  it('a stop whose save outlasts STOP_SAVE_WAIT_MS loses only the writes since the last save (review minor 10)', async () => {
    const received: FromBdj[] = [];
    const port: BdjPort = { onmessage: null, postMessage: (m) => void received.push(m) };
    // the browser's store: saves 100 ms after a write; from `stall` on, a save hangs (a strict commit that never ends)
    const saved: number[][] = [];
    let stall = false;
    const store: BdjStore = {
      saveDebounceMs: 100,
      load: async () => ({ files: [], etag: null }),
      save: async (_scope, snapshot) => {
        if (stall) await new Promise<never>(() => undefined);
        saved.push([...snapshot.files[0]!.bytes]);
        return { etag: `e${saved.length}` };
      },
    };
    const handle = runBdjWorker(port, { createStore: () => store });
    const files = fixtureDiscFiles('disc-bdj');
    port.onmessage!({
      data: {
        type: 'boot',
        registers: createRegisterBuffer(),
        status: createStatusBlock(),
        plane: createGraphicsPlane(),
        disc: { kind: 'files', entries: discEntries(files) },
        readAheadBytes: 0,
        discId: null,
        classLibrary: { rt: jar('rt-bdj.jar'), libbluray: jar('libbluray-j2se.jar'), libblurayAwt: jar('libbluray-awt-j2se.jar') },
      },
    });
    await vi.waitFor(() => expect(received.map((m) => m.type)).toContain('booted'), { timeout: 60_000 });
    const [persistent] = await discScopes(syntheticSource(files), null);
    const vfs = handle.runtime!.jvm.opts.vfs!;
    vfs.mkdir(persistent!.dir);
    const put = (b: number): void => {
      const h = vfs.open(`${persistent!.dir}/save`, 'w')!;
      vfs.write(h, new Uint8Array([b]), 0, 1);
      vfs.close(h);
    };
    put(1);
    await vi.waitFor(() => expect(saved).toEqual([[1]])); // the debounced save, long before any stop
    stall = true;
    put(2);
    port.onmessage!({ data: { type: 'stop' } });
    await new Promise((r) => setTimeout(r, 300));
    // no `stopped` while the save runs: the engine terminates the worker at STOP_SAVE_WAIT_MS (session.test.ts), and
    // what the store keeps is the save before the stop
    expect(received.map((m) => m.type)).not.toContain('stopped');
    expect(saved).toEqual([[1]]);
    handle.runtime!.jvm.threads.halt();
  }, 90_000);

  it("logs a save that fails at the stop, though the session has ended", async () => {
    const received: FromBdj[] = [];
    const port: BdjPort = { onmessage: null, postMessage: (m) => void received.push(m) };
    const store: BdjStore = {
      load: async () => ({ files: [], etag: null }),
      save: async () => {
        throw new Error('the disk is gone');
      },
    };
    const handle = runBdjWorker(port, { createStore: () => store });
    const files = fixtureDiscFiles('disc-bdj');
    port.onmessage!({
      data: {
        type: 'boot',
        registers: createRegisterBuffer(),
        status: createStatusBlock(),
        plane: createGraphicsPlane(),
        disc: { kind: 'files', entries: discEntries(files) },
        readAheadBytes: 0,
        discId: null,
        classLibrary: { rt: jar('rt-bdj.jar'), libbluray: jar('libbluray-j2se.jar'), libblurayAwt: jar('libbluray-awt-j2se.jar') },
      },
    });
    await vi.waitFor(() => expect(received.map((m) => m.type)).toContain('booted'), { timeout: 60_000 });
    const [persistent] = await discScopes(syntheticSource(files), null);
    const vfs = handle.runtime!.jvm.opts.vfs!;
    vfs.mkdir(persistent!.dir);
    const h = vfs.open(`${persistent!.dir}/save`, 'w')!;
    vfs.write(h, new Uint8Array([1]), 0, 1);
    port.onmessage!({ data: { type: 'stop' } });
    await vi.waitFor(() => expect(received.at(-1)).toEqual({ type: 'stopped' }));
    expect(received).toContainEqual({ type: 'log', line: `BD-J storage: ${persistent!.key} could not be saved (the disk is gone); tried again later`, error: true });
  }, 90_000);

  describe("telling the engine once that saved data won't last (the bdj-storage notice, ruling R32)", () => {
    const boot = (port: BdjPort, files: ReturnType<typeof fixtureDiscFiles>): void =>
      port.onmessage!({
        data: {
          type: 'boot',
          registers: createRegisterBuffer(),
          status: createStatusBlock(),
          plane: createGraphicsPlane(),
          disc: { kind: 'files', entries: discEntries(files) },
          readAheadBytes: 0,
          discId: null,
          classLibrary: { rt: jar('rt-bdj.jar'), libbluray: jar('libbluray-j2se.jar'), libblurayAwt: jar('libbluray-awt-j2se.jar') },
        },
      });

    it("sends storageLost once at Java's first write into scopes kept in memory only, never for a disc that does not write (R32a)", async () => {
      const files = fixtureDiscFiles('disc-bdj');
      const received: FromBdj[] = [];
      const port: BdjPort = { onmessage: null, postMessage: (m) => void received.push(m) };
      const store: BdjStore = {
        load: async () => {
          throw new Error('IndexedDB refused');
        },
        save: async () => ({ etag: 'e' }),
      };
      const handle = runBdjWorker(port, { createStore: () => store });
      boot(port, files);
      await vi.waitFor(() => expect(received.map((m) => m.type)).toContain('booted'), { timeout: 60_000 });
      expect(received.filter((m) => m.type === 'storageLost')).toEqual([]);
      const scopes = await discScopes(syntheticSource(files), null);
      const put = (vfs: NonNullable<typeof handle.runtime>['jvm']['opts']['vfs'] & object, path: string): void => {
        const parts = path.split('/');
        for (let i = 2; i < parts.length; i++) vfs.mkdir(parts.slice(0, i).join('/'));
        const h = vfs.open(path, 'w')!;
        vfs.write(h, new Uint8Array([1]), 0, 1);
        vfs.close(h);
      };
      put(handle.runtime!.jvm.opts.vfs!, `${scopes[0]!.dir}/a`);
      put(handle.runtime!.jvm.opts.vfs!, `${scopes[1]!.dir}/b`);
      expect(received.filter((m) => m.type === 'storageLost')).toEqual([{ type: 'storageLost', reason: 'memory-only' }]);
      port.onmessage!({ data: { type: 'stop' } });
      await vi.waitFor(() => expect(received.at(-1)).toEqual({ type: 'stopped' }));

      // no IndexedDB (the entry's createStore answers null): nothing lasts past the session
      const none: FromBdj[] = [];
      const port2: BdjPort = { onmessage: null, postMessage: (m) => void none.push(m) };
      const handle2 = runBdjWorker(port2, { createStore: () => null });
      boot(port2, files);
      await vi.waitFor(() => expect(none.map((m) => m.type)).toContain('booted'), { timeout: 60_000 });
      expect(none.filter((m) => m.type === 'storageLost')).toEqual([]);
      put(handle2.runtime!.jvm.opts.vfs!, '/tmp/scratch'); // not saved data anyway
      expect(none.filter((m) => m.type === 'storageLost')).toEqual([]);
      put(handle2.runtime!.jvm.opts.vfs!, `${scopes[0]!.dir}/a`);
      put(handle2.runtime!.jvm.opts.vfs!, `${scopes[0]!.dir}/b`);
      expect(none.filter((m) => m.type === 'storageLost')).toEqual([{ type: 'storageLost', reason: 'memory-only' }]);
      port2.onmessage!({ data: { type: 'stop' } });
      await vi.waitFor(() => expect(none.at(-1)).toEqual({ type: 'stopped' }));
    }, 120_000);

    it('sends one for writes refused for room, and none for a loss found only by the stop', async () => {
      const files = fixtureDiscFiles('disc-bdj');
      const received: FromBdj[] = [];
      const port: BdjPort = { onmessage: null, postMessage: (m) => void received.push(m) };
      let quota = Infinity;
      const store: BdjStore = {
        load: async () => ({ files: [], etag: null }),
        save: async (scope, snapshot) => {
          const bytes = snapshot.files.reduce((n, f) => n + f.bytes.length, 0);
          if (bytes > quota) throw new ScopeQuotaError(scope, bytes, quota);
          return { etag: 'e' };
        },
      };
      const handle = runBdjWorker(port, { createStore: () => store });
      boot(port, files);
      await vi.waitFor(() => expect(received.map((m) => m.type)).toContain('booted'), { timeout: 60_000 });
      expect(received.filter((m) => m.type === 'storageLost')).toEqual([]);
      const [persistent] = await discScopes(syntheticSource(files), null);
      const vfs = handle.runtime!.jvm.opts.vfs!;
      vfs.mkdir(persistent!.dir);
      // a write past the scope's 16 MB is refused twice: one message
      for (const name of ['a', 'b']) {
        const h = vfs.open(`${persistent!.dir}/${name}`, 'w')!;
        expect(vfs.write(h, new Uint8Array(17 * 1024 * 1024), 0, 17 * 1024 * 1024)).toBe(false);
        vfs.close(h);
      }
      expect(received.filter((m) => m.type === 'storageLost')).toEqual([{ type: 'storageLost', reason: 'full' }]);

      // another session: the store refuses only the stop's save, after the session has ended
      const late: FromBdj[] = [];
      const port2: BdjPort = { onmessage: null, postMessage: (m) => void late.push(m) };
      const handle2 = runBdjWorker(port2, { createStore: () => store });
      boot(port2, files);
      await vi.waitFor(() => expect(late.map((m) => m.type)).toContain('booted'), { timeout: 60_000 });
      const vfs2 = handle2.runtime!.jvm.opts.vfs!;
      vfs2.mkdir(persistent!.dir);
      const h = vfs2.open(`${persistent!.dir}/save`, 'w')!;
      vfs2.write(h, new Uint8Array([1, 2]), 0, 2);
      vfs2.close(h);
      quota = 1;
      port2.onmessage!({ data: { type: 'stop' } });
      await vi.waitFor(() => expect(late.at(-1)).toEqual({ type: 'stopped' }));
      expect(late).toContainEqual(expect.objectContaining({ type: 'log', line: expect.stringContaining('was not saved') }));
      expect(late.filter((m) => m.type === 'storageLost')).toEqual([]);
    }, 120_000);
  });

  it("keeps a NAS disc's saved data in the person's NAS store: their other device sees it, another person does not", async () => {
    const nas = await startStoreNas();
    try {
      const files = fixtureDiscFiles('disc-bdj-store');
      const storeApi = FAKE_NAS_BASE.replace(/discs\/[^/]+\/$/, '');
      /** One viewing on a device (its own IndexedDB): StoreXlet reads its count, writes it plus one, then plays. */
      const view = async (token: string, idb: IDBFactory): Promise<FromBdj[]> => {
        const disc = fakeNas(files, token);
        const fetch = ((input: string | URL | Request, init?: RequestInit) => {
          const url = String(input);
          return url.startsWith(storeApi) && !url.startsWith(FAKE_NAS_BASE) ? nas.fetch(nas.api + url.slice(storeApi.length), init) : disc.fetch(input, init);
        }) as typeof globalThis.fetch;
        const received: FromBdj[] = [];
        const port: BdjPort = {
          onmessage: null,
          postMessage: (m) => {
            received.push(m);
            if (m.type === 'call') setTimeout(() => port.onmessage!({ data: { type: 'reply', id: m.id, value: 0 } }), 0);
          },
        };
        runBdjWorker(port, { fetch, indexedDB: idb, createStore: () => null });
        port.onmessage!({
          data: {
            type: 'boot',
            registers: createRegisterBuffer(),
            status: createStatusBlock(),
            plane: createGraphicsPlane(),
            disc: disc.spec,
            readAheadBytes: 1024 * 1024,
            discId: null,
            classLibrary: { rt: jar('rt-bdj.jar'), libbluray: jar('libbluray-j2se.jar'), libblurayAwt: jar('libbluray-awt-j2se.jar') },
          },
        });
        await vi.waitFor(() => expect(received.map((m) => m.type)).toContain('booted'), { timeout: 60_000 });
        port.onmessage!({ data: { type: 'start', title: 0xffff } });
        await vi.waitFor(() => expect(received.some((m) => m.type === 'call' && m.name === 'selectPlaylist')).toBe(true), { timeout: 60_000 });
        port.onmessage!({ data: { type: 'stop' } });
        await vi.waitFor(() => expect(received.at(-1)).toEqual({ type: 'stopped' }), { timeout: 10_000 });
        return received;
      };
      const count = (personId: string): string | null => {
        const { body } = nas.stored(personId, 'persistent/7fff0002');
        const entries = listTar(body);
        let at = 0;
        for (const e of entries) {
          at += 512;
          if (e.path === '4001/count') return body.subarray(at, at + e.size).toString();
          at += Math.ceil(e.size / 512) * 512;
        }
        return null;
      };
      const mika = await nas.person('Mika');
      const mikasTablet = await nas.device(mika.personId, 'tablet');
      const sora = await nas.person('Sora');
      const logs = await view(mika.token, new IDBFactory());
      expect(count(mika.personId)).toBe('1');
      expect(logs).toContainEqual({ type: 'log', line: 'BD-J storage: persistent/7fff0002 is on the NAS (1 files, 1 bytes)', error: false });
      await view(mikasTablet, new IDBFactory()); // the same person's other device starts from 1
      expect(count(mika.personId)).toBe('2');
      await view(sora.token, new IDBFactory()); // another person starts from nothing
      expect(count(sora.personId)).toBe('1');
      expect(count(mika.personId)).toBe('2');
      // only the scope routes and `me` went to the store; each through the person's own token
      expect(nas.requests.filter((r) => !r.startsWith('GET /api/me') && !r.includes('/api/bdj-store/'))).toEqual([]);
    } finally {
      await nas.close();
    }
  }, 180_000);

  it("makes Java's scope full on a 507 from the boot's put", async () => {
    const nas = await startStoreNas({ scopeLimit: 64 * 1024 });
    try {
      const files = fixtureDiscFiles('disc-bdj-store');
      const storeApi = FAKE_NAS_BASE.replace(/discs\/[^/]+\/$/, '');
      const mika = await nas.person('Mika');
      const disc = fakeNas(files, mika.token);
      const fetch = ((input: string | URL | Request, init?: RequestInit) => {
        const url = String(input);
        return url.startsWith(storeApi) && !url.startsWith(FAKE_NAS_BASE) ? nas.fetch(nas.api + url.slice(storeApi.length), init) : disc.fetch(input, init);
      }) as typeof globalThis.fetch;
      // the last session left a pending copy too big for the NAS's scope: the boot merges it and puts it at once (507)
      const idb = new IDBFactory();
      await new IdbBdjStore(personSource(mika.personId), idb).save('persistent/7fff0002', { files: [{ path: '4001/big', mtime: 1_000, bytes: new Uint8Array(70 * 1024) }] }, null, { pending: true });
      const received: FromBdj[] = [];
      const port: BdjPort = { onmessage: null, postMessage: (m) => void received.push(m) };
      runBdjWorker(port, { fetch, indexedDB: idb, createStore: () => null });
      port.onmessage!({
        data: {
          type: 'boot',
          registers: createRegisterBuffer(),
          status: createStatusBlock(),
          plane: createGraphicsPlane(),
          disc: disc.spec,
          readAheadBytes: 1024 * 1024,
          discId: null,
          classLibrary: { rt: jar('rt-bdj.jar'), libbluray: jar('libbluray-j2se.jar'), libblurayAwt: jar('libbluray-awt-j2se.jar') },
        },
      });
      await vi.waitFor(() => expect(received.map((m) => m.type)).toContain('booted'), { timeout: 60_000 });
      const at = (pred: (m: FromBdj) => boolean): number => received.findIndex(pred);
      const refused = at((m) => m.type === 'log' && m.line.startsWith('BD-J storage: persistent/7fff0002 was not put on the NAS') && m.error);
      const attached = at((m) => m.type === 'unsaved');
      const full = at((m) => m.type === 'log' && m.line.startsWith('BD-J storage: persistent/7fff0002 is full') && m.error);
      // (whether the 507 came before the scopes were attached depends on how fast the JDK starts: FullRelay's own test
      // pins the early case)
      expect(refused).toBeGreaterThanOrEqual(0);
      expect(full).toBeGreaterThan(Math.max(attached, refused));
      // the viewer's notice (ruling R32): once
      expect(received.filter((m) => m.type === 'storageLost')).toEqual([{ type: 'storageLost', reason: 'full' }]);
      port.onmessage!({ data: { type: 'stop' } });
      await vi.waitFor(() => expect(received.at(-1)).toEqual({ type: 'stopped' }), { timeout: 10_000 });
    } finally {
      await nas.close();
    }
  }, 90_000);
});
