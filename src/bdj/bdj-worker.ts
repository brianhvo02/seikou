/*
 * Original code for Seikou: the BD-J worker, which runs the JVM for the engine worker. Everything in this file runs
 * in the BD-J worker.
 *
 * Copyright (C) 2026  Seikou contributors
 *
 * SPDX-License-Identifier: LGPL-3.0-or-later
 */

import type { Clpi } from '@seikou/bdmv/clpi-parser';
import { BDJ_REMOTE_CHUNK_BYTES, BDJ_REMOTE_IN_FLIGHT, createByteSource } from '@seikou/engine/disc/disc-spec';
import { portFetch } from '@seikou/engine/disc/port-fetch';
import { TokenRelay } from '@seikou/engine/disc/http-transport';
import { clipInfoPath, loadClips, openDisc } from '@seikou/engine/disc/open-disc';
import type { DiscModel } from '@seikou/engine/disc/open-disc';
import type { ByteSource } from '@seikou/bdmv/byte-source';
import { RemoteSource } from '@seikou/engine/disc/remote-source';
import { BdjError } from './errors';
import type { FreeType } from './fonts/freetype';
import type { NativeTable } from './jvm/natives/index';
import { GraphicsPlaneReader, GraphicsPlaneWriter } from './graphics-plane';
import { BdjRuntime } from './runtime';
import { SharedRegisterView } from './shared-registers';
import { StatusBlockReader } from './status-block';
import type { BdjStore, StorageLoss } from './store/bdj-store';
import { NasBdjStore, NasDiscStore, storeApiBase } from './store/nas-store';
import { FullRelay, ScopeSync } from './store/scope-sync';
import { discScopes, storeSource } from './store/scopes';
import { WorkerBdjHost } from './worker-host';
import type { BdjCallName, BdjFailureCode, BdjWireValue, FromBdj, ToBdj } from './worker-protocol';

/** The BD-J worker's side of its channel to the engine worker (the worker's global scope in production). */
export interface BdjPort {
  postMessage(message: FromBdj): void;
  onmessage: ((event: { readonly data: ToBdj }) => void) | null;
}

/**
 * Whether Java has shown it runs, as the session's start-up timeout counts it (BdjSession.alive): a selected
 * playlist, a visible plane or a shown background still, since a still menu waiting for input is alive, not hung.
 * Only a deadlock before that is a boot stall.
 */
export class StartupWatch {
  private shown = false;
  private dumped = false;

  /** `onShown`: called once, when Java first shows it runs (the session's start-up timeout is then disarmed). */
  constructor(private readonly onShown?: () => void) {}

  /** A call Java sent the engine: selecting a playlist (not a stop, playlist -1) shows it runs. */
  call(name: BdjCallName, args: readonly BdjWireValue[]): void {
    if (name === 'selectPlaylist' && Number(args[0]) >= 0) this.show();
  }

  /** A background still was shown (null: one was cleared, which shows nothing). */
  still(image: Uint8Array | null): void {
    if (image) this.show();
  }

  /** The plane after a run of the Java threads: a visible one (a menu) shows it runs. */
  plane(visible: boolean): void {
    if (visible) this.show();
  }

  private show(): void {
    if (this.shown) return;
    this.shown = true;
    this.onShown?.();
  }

  /** A deadlock outcome: true for the first one while Java has shown nothing, which the worker dumps. */
  deadlock(): boolean {
    if (this.shown || this.dumped) return false;
    this.dumped = true;
    return true;
  }
}

/**
 * Whether the worker is waiting on its own I/O, for the engine's start-up timeout, which does not count that time
 * because a slow link is not a hang: a disc read over a slow link, the storage scopes or the fonts. A change is told at the next turn of the event loop and only if it still
 * holds then, so reads answered from memory (the read-ahead, the inlined files) send nothing.
 */
export class IoWatch {
  private pending = 0;
  private told = false;
  private scheduled = false;
  private stopped = false;

  constructor(private readonly tell: (pending: boolean) => void) {}

  /** Nothing more is told: the start-up timeout has been disarmed (Java showed it runs) or has fired. */
  stop(): void {
    this.stopped = true;
  }

  /** `p`, counted as pending I/O until it settles. */
  track<T>(p: Promise<T>): Promise<T> {
    this.pending++;
    this.schedule();
    const done = (): void => {
      this.pending--;
      this.schedule();
    };
    p.then(done, done);
    return p;
  }

  /** `source`, its reads tracked. */
  source<S extends ByteSource & { paths(): Iterable<string> }>(source: S): ByteSource & { paths(): Iterable<string> } {
    return {
      exists: (path) => source.exists(path),
      size: (path) => source.size(path),
      list: (dir) => source.list(dir),
      paths: () => source.paths(),
      read: (path, offset, length, signal) => this.track(source.read(path, offset, length, signal)),
      ...(source.peek ? { peek: (path: string, offset: number, length: number, signal?: AbortSignal) => this.track(source.peek!(path, offset, length, signal)) } : {}),
    };
  }

  private schedule(): void {
    if (this.scheduled) return;
    this.scheduled = true;
    setTimeout(() => {
      this.scheduled = false;
      if (this.stopped) return;
      const now = this.pending > 0;
      if (now === this.told) return;
      this.told = now;
      this.tell(now);
    }, 0);
  }
}

/** What runBdjWorker returns: a handle for tests. */
export interface BdjWorkerHandle {
  /** The runtime once booting has begun (tests reach into the JVM through it). */
  readonly runtime: BdjRuntime | null;
}

type BootMessage = Extract<ToBdj, { type: 'boot' }>;
type TitleMessage = Extract<ToBdj, { type: 'start' | 'event' }>;

/**
 * A macrotask turn without timer clamping, for the JVM scheduler's periodic yield: a MessageChannel message in a
 * browser (setTimeout(0) there waits 4 ms once timers nest), setImmediate where it exists.
 */
function eventLoopTurn(): () => Promise<void> {
  const immediate = (globalThis as { setImmediate?: (fn: () => void) => unknown }).setImmediate;
  if (immediate) return () => new Promise<void>((resolve) => void immediate(resolve));
  if (typeof MessageChannel !== 'function') return () => new Promise<void>((resolve) => void setTimeout(resolve, 0));
  const channel = new MessageChannel();
  const waiting: (() => void)[] = [];
  channel.port1.onmessage = () => waiting.shift()?.();
  return () =>
    new Promise<void>((resolve) => {
      waiting.push(resolve);
      channel.port2.postMessage(null);
    });
}

/** What the BD-J worker's entry gives runBdjWorker; tests pass their own. */
export interface BdjWorkerOptions {
  /** JvmOptions.extraIntrinsics: the class library's intrinsics (src/bdj-classlib/intrinsics), which the engine does not carry. */
  readonly extraIntrinsics?: (table: NativeTable) => void;
  /**
   * FreeType for the BD-J text natives (java_awt_BDFontMetrics.c, java_awt_BDGraphics.c), loaded when text is first
   * needed, not at boot: the entry fetches src/wasm/freetype/freetype.wasm. Calls share one load.
   */
  readonly loadFreeType?: () => Promise<FreeType>;
  /** The bundled fallback font (packages/ass/src/default-font.ttf), the JRE font files' bytes; fetched when first read. */
  readonly loadDefaultFont?: () => Promise<Uint8Array>;
  /** Reads a NAS disc's files; the worker's fetch by default. */
  readonly fetch?: typeof fetch;
  /**
   * Where the disc's saved data (/persistent/, /buda/) lasts between sessions, for the disc's source (scopes.ts
   * storeSource); without it (or with null) it lasts until BD-J stops.
   */
  readonly createStore?: (source: string) => BdjStore | null;
  /**
   * The browser's IndexedDB, for a disc opened from a server (the backend choice): its saved data goes to the person's
   * NAS store with a write-ahead copy here (nas-store.ts NasDiscStore: browsers drop work started during pagehide, so
   * the copy here is what keeps a page closed early from losing saves), or stays here on a server that keeps no people. Without it such a disc takes `createStore`, as a picked folder does.
   */
  readonly indexedDB?: IDBFactory;
}

/** Serves one BD-J session over `port`: boot, then title starts, events and call replies in arrival order. */
export function runBdjWorker(port: BdjPort, options: BdjWorkerOptions = {}): BdjWorkerHandle {
  let rt: BdjRuntime | null = null;
  let booted = false;
  let ended = false;
  const waiting: TitleMessage[] = [];
  const replies = new Map<number, { readonly name: BdjCallName; readonly resolve: (value: number | string) => void }>();
  let nextId = 1;
  let looping = false;
  let dirty = false;
  let driving: AbortController | null = null;
  /** The runtime's log repeats each line the host logs; the host's copy carries the error flag. */
  let hostLine: string | null = null;
  /** FreeType once loaded (memory stats). */
  let freeType: FreeType | null = null;
  const loadFreeType = options.loadFreeType;
  /** A NAS disc's fresh tokens from the engine; the latest is kept for a source created after it arrived. */
  const tokens = new TokenRelay(
    () => post({ type: 'remoteTokenNeeded' }),
    (ms, fn) => {
      const id = setTimeout(fn, ms);
      return () => clearTimeout(id);
    },
  );
  let latestToken: string | null = null;
  let remote: RemoteSource | null = null;
  let waitingSince = 0;
  /** Whether Java has shown it runs (the deadlock dump is for start-up only). */
  // once Java shows it runs, the start-up timeout is disarmed and the engine needs no more `io`
  const startup = new StartupWatch(() => io.stop());
  /** The plane Java draws into, read for its visibility. */
  let planeView: GraphicsPlaneReader | null = null;

  /** The storage scopes once loaded and in the VFS. */
  let sync: ScopeSync | null = null;
  /** Where they are kept, and a NAS disc's store client (it takes the fresh tokens too). */
  let store: BdjStore | null = null;
  let nasStore: NasBdjStore | null = null;
  /** The NAS's full or not full per scope, heard before `sync` was there (applied once it is). */
  const fullRelay = new FullRelay();
  /** The engine has heard that saved data won't last (storageLost): it hears it once a session. */
  let storageLostSent = false;
  /** No scope is kept past the session (no store, or the scopes could not be worked out): a write there is lost. */
  let unkept = false;
  /** Saves what Java changed, then has the store pass on what it holds (a NAS disc's write-ahead copy). */
  const flushStorage = async (): Promise<void> => {
    await sync?.flush();
    await store?.flush?.();
  };

  const post = (m: FromBdj): void => {
    if (!ended) port.postMessage(m);
  };

  /** Tells the engine, once and only while the session runs, that what the disc saves won't last (the viewer's `bdj-storage` notice). */
  const storageLost = (reason: StorageLoss): void => {
    if (storageLostSent || ended) return;
    storageLostSent = true;
    post({ type: 'storageLost', reason });
  };

  /** What the worker waits on (disc reads, the scopes, the fonts), and whether the engine was last told it waits. */
  const io = new IoWatch((pending) => post({ type: 'io', pending }));

  const fail = (e: unknown): void => {
    if (ended) return;
    let code: BdjFailureCode = 'internal';
    let message = e instanceof Error ? e.message : String(e);
    if (rt?.exitStatus != null) {
      code = 'halted';
      message = `the JVM halted with status ${rt.exitStatus}`;
    } else if (e instanceof BdjError) {
      code = e.code;
    }
    post({ type: 'failed', code, message });
    ended = true;
    driving?.abort();
    rt?.jvm.threads.halt();
  };

  const call = (name: BdjCallName, args: readonly BdjWireValue[]): Promise<number | string> => {
    const id = nextId++;
    startup.call(name, args);
    return new Promise((resolve) => {
      replies.set(id, { name, resolve });
      post({ type: 'call', id, name, args });
    });
  };

  /** Runs the Java threads until they idle; a message that gives them work runs them again. */
  const kick = (): void => {
    if (ended || !booted) return;
    dirty = true;
    if (looping) {
      driving?.abort();
      return;
    }
    looping = true;
    void (async () => {
      try {
        while (dirty && !ended) {
          dirty = false;
          driving = new AbortController();
          const outcome = await rt!.run({ signal: driving.signal });
          startup.plane(planeView?.visible() ?? false);
          if (rt!.exitStatus !== null) fail(null);
          else if (outcome === 'deadlock') deadlocked();
        }
      } catch (e) {
        fail(e);
      } finally {
        looping = false;
        driving = null;
      }
    })();
  };

  const deliver = (m: TitleMessage): void => {
    try {
      if (m.type === 'start') rt!.start(m.title);
      else rt!.processEvent(m.ev, m.param, m.coalesce);
    } catch (e) {
      fail(e);
      return;
    }
    kick();
  };

  const boot = async (m: BootMessage): Promise<void> => {
    const t0 = performance.now();
    try {
      // on the WebRTC route the engine relays the disc's requests through a port of this worker's own
      const fetchPort = m.disc.kind === 'remote' ? m.disc.fetchPort : undefined;
      const fetchFn = fetchPort ? portFetch(fetchPort) : (options.fetch ?? ((input: RequestInfo | URL, init?: RequestInit) => fetch(input, init)));
      // the BD-J read-ahead budget (memory profile bdjRemoteReadAheadBytes), in BD-J-sized requests: this worker reads
      // JARs and metadata, not streams, so the engine's much larger read-ahead would only add memory
      const disc = createByteSource(m.disc, {
        fetch: fetchFn,
        readAheadBytes: m.readAheadBytes,
        chunkBytes: BDJ_REMOTE_CHUNK_BYTES,
        inFlight: BDJ_REMOTE_IN_FLIGHT,
        // a read that has waited WAITING_AFTER_MS on the NAS, and how long it took in the end
        onWaiting: (on) => {
          if (on) waitingSince = performance.now();
          post({ type: 'log', line: on ? 'BD-J worker: disc reads are waiting for the network' : `BD-J worker: disc reads waited ${Math.round(performance.now() - waitingSince)} ms`, error: false });
        },
        refreshToken: () => tokens.request(),
      });
      if (disc instanceof RemoteSource) {
        remote = disc;
        if (latestToken !== null) disc.setToken(latestToken);
      }
      // everything below reads the disc through this: the time Java waits on it is not the start-up timeout's
      const reads = io.source(disc);
      // the disc model loads while the JDK starts up; the host reads it once Libbluray.init asks for disc info
      let model: { readonly disc: DiscModel; readonly clips: ReadonlyMap<string, Clpi> } | null = null;
      const loading = (async () => {
        const opened = await openDisc(reads);
        const clipIds = new Set([...opened.playlists.values()].flatMap((p) => p.playItems.map((i) => i.clipId)));
        // openDisc has already parsed the clips of a disc with movie objects; only the rest are read here
        const rest = await loadClips(reads, [...clipIds].filter((id) => !opened.clips.has(id) && disc.exists(clipInfoPath(id))));
        model = { disc: opened, clips: new Map([...opened.clips, ...rest]) };
      })();
      loading.catch(() => undefined); // awaited below; this only keeps a failure while the runtime is set up from going unhandled
      const loaded = (): NonNullable<typeof model> => {
        if (!model) throw new Error('the disc model is not loaded yet');
        return model;
      };
      // the storage scopes load while the JDK starts up too: Libbluray.init (and so every xlet) waits for them
      store = createStore(m, fetchFn);
      // a store was wanted and there is none (no IndexedDB): what the disc saves lasts until BD-J stops, which the
      // viewer hears of at Java's first write there, never at boot, since a disc that never writes loses nothing
      if (!store && options.createStore) unkept = true;
      const storeLoading = store ? io.track(loadScopes(store, reads, m.discId)) : Promise.resolve(null);
      planeView = new GraphicsPlaneReader(m.plane);
      rt = new BdjRuntime({
        disc: reads,
        discId: m.discId,
        classLibrary: m.classLibrary,
        ...(m.memory ? { memory: m.memory } : {}),
        host: () =>
          new WorkerBdjHost({
            regs: new SharedRegisterView(m.registers),
            status: new StatusBlockReader(m.status),
            plane: new GraphicsPlaneWriter(m.plane),
            background: (image, rect) => {
              startup.still(image);
              post({ type: 'background', image, rect });
            },
            call,
            get disc() {
              return loaded().disc;
            },
            get clips() {
              return loaded().clips;
            },
            log: (line, error) => {
              hostLine = line;
              post({ type: 'log', line, error });
            },
          }),
        // the wall clock (System.currentTimeMillis), kept monotonic: Java's timers and dates both read it
        nowMs: () => performance.timeOrigin + performance.now(),
        setTimer: (ms, fn) => {
          const id = setTimeout(fn, ms);
          return () => clearTimeout(id);
        },
        yieldTask: eventLoopTurn(),
        ...(options.extraIntrinsics ? { extraIntrinsics: options.extraIntrinsics } : {}),
        ...(loadFreeType && options.loadDefaultFont
          ? {
              fonts: {
                loadFreeType: () => io.track(loadFreeType().then((ft) => (freeType = ft))),
                loadDefaultFont: () => io.track(options.loadDefaultFont!()),
              },
            }
          : {}),
        log: (line) => {
          if (line === hostLine) hostLine = null;
          else post({ type: 'log', line, error: false });
        },
        onVfsChange: (path, change, to) => {
          if (sync) sync.changed(path, change, to);
          else if (unkept && change !== 'mkdir' && [path, to].some((p) => p !== undefined && /^\/(persistent|buda)\//.test(p))) storageLost('memory-only');
        },
        onVfsFull: (path) => sync?.refused(path),
      });
      // boot() reports a JDK failure itself, with its BdjError code
      const [, , scopes] = await Promise.all([loading, rt.bootJdk().catch(() => undefined), storeLoading]);
      if (ended) return;
      scopes?.attach(rt.jvm.opts.vfs!);
      sync = scopes;
      if (scopes) fullRelay.attach(scopes);
      // the engine hears that this session has scopes: its stop then always waits for the save (`stop`, `stopped`)
      if (scopes) port.postMessage({ type: 'unsaved', unsaved: false });
      await rt.boot();
    } catch (e) {
      fail(e);
      return;
    }
    if (ended) return;
    booted = true;
    post({ type: 'booted', bootMs: performance.now() - t0 });
    if (m.memoryStatsMs) reportMemory(m.memoryStatsMs);
    for (const w of waiting.splice(0)) deliver(w);
  };

  /** The disc's store, by where it comes from: a server's (NAS) or a picked folder's (this browser). */
  const createStore = (m: BootMessage, fetchFn: typeof fetch): BdjStore | null => {
    const apiBase = m.disc.kind === 'remote' ? storeApiBase(m.disc.base) : null;
    if (m.disc.kind !== 'remote' || !options.indexedDB || apiBase === null) return options.createStore?.(storeSource(m.disc)) ?? null;
    const log = (line: string, error?: boolean): void => port.postMessage({ type: 'log', line, error: error ?? false });
    nasStore = new NasBdjStore(apiBase, { fetch: fetchFn, token: latestToken ?? m.disc.token, refreshToken: () => tokens.request(), log });
    return new NasDiscStore({
      nas: nasStore,
      idb: options.indexedDB,
      discId: m.disc.manifest.discId,
      setTimer: (ms, fn) => {
        const id = setTimeout(fn, ms);
        return () => clearTimeout(id);
      },
      // straight to the engine, as ScopeSync's: puts still run after a stop or a failure has ended the session
      log,
      // a 507 of the boot's put can come before the scopes are in the VFS: kept until they are
      onFull: (scope, full) => fullRelay.full(scope, full),
      onLost: storageLost,
    });
  };

  /** The disc's storage scopes from `store`; null (saved data lasts the session only) when they cannot be worked out. */
  const loadScopes = async (store: BdjStore, disc: Parameters<typeof discScopes>[0], discId: string | null): Promise<ScopeSync | null> => {
    try {
      return await ScopeSync.load(await discScopes(disc, discId), {
        store,
        setTimer: (ms, fn) => {
          const id = setTimeout(fn, ms);
          return () => clearTimeout(id);
        },
        // straight to the engine, as the save state: saves still run after a stop or a failure has ended the session
        log: (line, error) => port.postMessage({ type: 'log', line, error: error ?? false }),
        onUnsaved: (unsaved) => port.postMessage({ type: 'unsaved', unsaved }),
        onLost: storageLost,
      });
    } catch (e) {
      post({ type: 'log', line: `BD-J storage: the disc's storage scopes could not be read (${e instanceof Error ? e.message : String(e)}); saved data lasts until BD-J stops`, error: true });
      unkept = true;
      return null;
    }
  };

  /** The engine stops BD-J: Java halts where it is, and what it wrote is saved before the worker is terminated. */
  const stop = async (): Promise<void> => {
    ended = true;
    driving?.abort();
    rt?.jvm.threads.halt();
    // the snapshot is what Java left when it halted, possibly in the middle of a write (a file half written stays so,
    // as after a power cut); a NAS disc's write-ahead copy is put on the NAS too, while the engine waits (else at the
    // next open)
    await flushStorage();
    port.postMessage({ type: 'stopped' });
  };

  /**
   * Every live Java thread is blocked with no timer or read to wake it: only an event or a title start can. A menu
   * waiting for keys is in this state; before Java has shown it runs it is how a boot stall looks, so the first one
   * then is dumped (the others are counted in the next dump).
   */
  let deadlocks = 0;
  const deadlocked = (): void => {
    deadlocks++;
    if (startup.deadlock()) dump('every Java thread is blocked before it selected a playlist or showed anything');
  };

  /** Logs the worker's state and a thread dump (the engine asks at its start-up timeout; the first deadlock). */
  const dump = (reason: string): void => {
    const calls = [...replies].map(([id, c]) => `${c.name}#${id}`);
    const lines = [
      `BD-J thread dump (${reason}): ${booted ? 'booted' : rt ? 'booting' : 'not booting'}, ${looping ? 'driving' : 'idle'}, ` +
        `${waiting.length} messages waiting for the boot, ${calls.length ? `waiting for the engine's reply to ${calls.join(', ')}` : 'no call waiting for the engine'}, ` +
        `${deadlocks} deadlock outcomes`,
      ...(rt ? rt.threadDump() : []),
    ];
    post({ type: 'log', line: lines.join('\n'), error: false });
  };

  /** Posts the memory stats now and every `everyMs` until the session ends (Vfs.buffers walks the tree: keep it coarse). */
  const reportMemory = (everyMs: number): void => {
    if (ended || !rt || rt.jvm.threads.isHalted) return;
    post({ type: 'memory', jvm: rt.jvm.memoryStats(), freeType: freeType?.memoryStats() ?? null });
    setTimeout(() => reportMemory(everyMs), everyMs);
  };

  port.onmessage = ({ data: m }) => {
    // a stop and a flush come after a failure too: what Java wrote before it is still saved
    if (m.type === 'stop') return void stop();
    if (m.type === 'flush') return void flushStorage();
    if (ended) return;
    switch (m.type) {
      case 'remoteToken':
        latestToken = m.token;
        remote?.setToken(m.token);
        nasStore?.setToken(m.token);
        tokens.deliver(m.token);
        break;
      case 'boot':
        void boot(m);
        break;
      case 'start':
      case 'event':
        if (booted) deliver(m);
        else waiting.push(m);
        break;
      case 'dump':
        io.stop(); // the start-up timeout has fired
        dump(m.reason);
        post({ type: 'dumped' });
        break;
      case 'reply': {
        const c = replies.get(m.id);
        replies.delete(m.id);
        c?.resolve(m.value);
        if (!looping) kick();
        break;
      }
    }
  };

  return {
    get runtime() {
      return rt;
    },
  };
}
