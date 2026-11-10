// SPDX-License-Identifier: LGPL-3.0-or-later
import { randomBytes } from 'node:crypto';
import { mkdir, open, readdir, readFile, rename, rm, stat } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { discKeyOf, parseDiscKey } from '@seikou/nas/disc-key';
import type { DiscManifest } from '@seikou/nas/nas-api';
import { hostOf, NasError, type NasClient } from './client';

// A NAS disc's mirror: a folder in the data directory that reads as an ordinary disc folder. Its metadata files are
// whole; each stream file is a sparse file of its true size that holds only the ranges fetched so far, which
// `fetch.json` records. The planner, BestSource and `discKeyOfFolder` read it as they read any disc.

/** What probes and PMT reads need of each clip. */
export const HEAD_BYTES = 4 * 1024 * 1024;
/** One range request. */
export const CHUNK_BYTES = 32 * 1024 * 1024;
/** Free space kept beyond what is fetched. */
export const ROOM_MARGIN_BYTES = 1024 ** 3;
/** The waits before each retry of a request that met a network error or a 5xx; after the last, `unreachable`. */
export const RETRY_DELAYS_MS: readonly number[] = [1000, 2000, 4000, 8000];

/** Why a fetch cannot go on. */
export type FetchErrorCode = 'disc-changed' | 'no-room' | 'unreachable';

/** A fetch that cannot go on: the NAS's disc is not the mirrored one, the drive has no room, or the NAS is not answering. */
export class FetchError extends Error {
  constructor(
    readonly code: FetchErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'FetchError';
  }
}

/** A half-open byte range `[start, endExclusive)`. */
export type ByteRange = [number, number];

/** `fetch.json`: the mirrored disc and what of each stream file is here. Paths are the manifest's (upper-case). */
export interface MirrorState {
  /** The NAS disc id `ensureMirror` was last called with. */
  discId: string;
  /**
   * Every NAS disc id `ensureMirror` was called with for this key, oldest first, `discId` last. Copies of one disc
   * share a key; a range a 404 refuses under one id is asked for under the others before the disc counts as changed.
   */
  discIds: string[];
  /** The disc id the metadata files on disk came from: a held mirror keeps them when another copy is opened. */
  metadataFrom: string;
  discKey: string;
  label: string;
  /** Every file of the disc with its size. */
  files: Record<string, number>;
  /** Each stream file's fetched ranges, sorted and merged. */
  ranges: Record<string, ByteRange[]>;
  /** The stream files whose head (`HEAD_BYTES`, or the whole file when smaller) is here. */
  heads: string[];
}

/** One mirror's in-memory side, shared by every fetcher of the app (ruling R-P2: keyed by data directory, then key). */
export interface MirrorEntry {
  /** `fetch.json` as last read or written; null until read, and after the mirror is removed. */
  state: MirrorState | null;
  /** The tail of the mirror's lock: file writes and `fetch.json` updates run one at a time. */
  tail: Promise<unknown>;
  /** Stream path → the holders that claim it whole. */
  readonly holders: Map<string, Set<string>>;
  /** Stream path → the download running for it. */
  readonly inflight: Map<string, Promise<void>>;
  /** Holders that claim the mirror's metadata (a helper session that plans from it) without holding any clip. */
  readonly claims: Set<string>;
}

const registry = new Map<string, Map<string, MirrorEntry>>();

/** The in-memory entry of mirror `key` in `dataDir`, made on first use. */
export function mirrorEntry(dataDir: string, key: string): MirrorEntry {
  const data = resolve(dataDir);
  let byKey = registry.get(data);
  if (!byKey) registry.set(data, (byKey = new Map()));
  let entry = byKey.get(key);
  if (!entry) byKey.set(key, (entry = { state: null, tail: Promise.resolve(), holders: new Map(), inflight: new Map(), claims: new Set() }));
  return entry;
}

/** Runs `fn` under the mirror's lock. */
export function locked<T>(entry: MirrorEntry, fn: () => Promise<T>): Promise<T> {
  const run = entry.tail.then(fn, fn);
  entry.tail = run.catch(() => undefined);
  return run;
}

/** `<data>/fetch`, where mirrors live. */
export function fetchRootOf(dataDir: string): string {
  return join(dataDir, 'fetch');
}

/** The mirror folder of disc `key`. Throws for a string that is not a disc key, so it never names another folder. */
export function mirrorDirOf(dataDir: string, key: string): string {
  if (parseDiscKey(key) === null) throw new Error('Not a disc key.');
  return join(fetchRootOf(dataDir), key);
}

/** Whether `dir` is a mirror: it has `fetch.json`. */
export async function isMirror(dir: string): Promise<boolean> {
  try {
    return (await stat(join(dir, 'fetch.json'))).isFile();
  } catch {
    return false;
  }
}

/** Whether `path` (a manifest path) is a stream file, kept sparse and fetched by range. */
export function isStreamPath(path: string): boolean {
  return path.startsWith('BDMV/STREAM/');
}

/** The manifest path of stream file `name` (`00001.M2TS`, any case). */
export function streamPathOf(name: string): string {
  return `BDMV/STREAM/${name.toUpperCase()}`;
}

/**
 * Where manifest path `path` lies in mirror `dir`. Folders keep the manifest's upper-case names and the file name is
 * lower-cased, as discs are usually written and as the encoder's readers look for them (`BDMV/PLAYLIST/00000.mpls`,
 * `BDMV/CLIPINF/00001.clpi`, `BDMV/STREAM/00001.m2ts`, `BDMV/index.bdmv`), so a mirror reads the same on a
 * case-sensitive filesystem. Throws for a path that would leave the folder.
 */
export function localPathOf(dir: string, path: string): string {
  const segments = path.split('/');
  const top = segments[0];
  if (
    (top !== 'BDMV' && top !== 'CERTIFICATE') ||
    segments.length < 2 ||
    segments.some((s) => s === '' || s === '.' || s === '..' || s.includes('\\') || s.includes('\0'))
  ) {
    throw new Error('The NAS listed a disc file the encoder will not write.');
  }
  const last = segments.length - 1;
  return join(dir, ...segments.slice(0, last), segments[last]!.toLowerCase());
}

// ---- Ranges ----

/** `ranges` with `[start, end)` added, sorted and merged. */
export function addRange(ranges: readonly ByteRange[], start: number, end: number): ByteRange[] {
  const all = [...ranges, [start, end] as ByteRange].filter(([a, b]) => b > a).sort((x, y) => x[0] - y[0]);
  const out: ByteRange[] = [];
  for (const [a, b] of all) {
    const prev = out[out.length - 1];
    if (prev && a <= prev[1]) prev[1] = Math.max(prev[1], b);
    else out.push([a, b]);
  }
  return out;
}

/** The parts of `[start, end)` that `ranges` covers, in order. */
export function coveredIn(ranges: readonly ByteRange[], start: number, end: number): ByteRange[] {
  const out: ByteRange[] = [];
  for (const [a, b] of ranges) {
    const lo = Math.max(a, start);
    const hi = Math.min(b, end);
    if (hi > lo) out.push([lo, hi]);
  }
  return out;
}

/** The parts of `[start, end)` that `ranges` leaves out, in order. */
export function gapsIn(ranges: readonly ByteRange[], start: number, end: number): ByteRange[] {
  const out: ByteRange[] = [];
  let at = start;
  for (const [a, b] of coveredIn(ranges, start, end)) {
    if (a > at) out.push([at, a]);
    at = Math.max(at, b);
  }
  if (at < end) out.push([at, end]);
  return out;
}

/** The bytes `ranges` holds. */
export function bytesIn(ranges: readonly ByteRange[]): number {
  return ranges.reduce((sum, [a, b]) => sum + (b - a), 0);
}

/** The head length of a stream file of `size` bytes. */
export function headLength(size: number): number {
  return Math.min(HEAD_BYTES, size);
}

// ---- fetch.json ----

function validState(v: unknown): v is MirrorState {
  if (typeof v !== 'object' || v === null) return false;
  const s = v as Record<string, unknown>;
  return (
    typeof s.discId === 'string' &&
    typeof s.discKey === 'string' &&
    typeof s.label === 'string' &&
    typeof s.files === 'object' &&
    s.files !== null &&
    typeof s.ranges === 'object' &&
    s.ranges !== null &&
    Array.isArray(s.heads) &&
    typeof s.metadataFrom === 'string' &&
    Array.isArray(s.discIds) &&
    s.discIds.every((id) => typeof id === 'string')
  );
}

/** `fetch.json` of mirror `dir`, or null when it is missing or unreadable. */
export async function readState(dir: string): Promise<MirrorState | null> {
  try {
    const v = JSON.parse(await readFile(join(dir, 'fetch.json'), 'utf8')) as unknown;
    return validState(v) ? v : null;
  } catch {
    return null;
  }
}

/** Writes `state` as `fetch.json` of `dir` (a temporary file renamed over it), its `heads` worked out from its ranges. */
export async function writeState(dir: string, state: MirrorState): Promise<void> {
  state.heads = Object.keys(state.files)
    .filter((p) => isStreamPath(p) && gapsIn(state.ranges[p] ?? [], 0, headLength(state.files[p]!)).length === 0)
    .sort();
  await writeAtomic(join(dir, 'fetch.json'), Buffer.from(`${JSON.stringify(state, null, 2)}\n`));
}

async function writeAtomic(path: string, bytes: Uint8Array): Promise<void> {
  const tmp = `${path}.${randomBytes(6).toString('hex')}.tmp`;
  const fh = await open(tmp, 'w');
  try {
    await fh.writeFile(bytes);
    await fh.sync();
  } finally {
    await fh.close();
  }
  await rename(tmp, path);
  // The rename is lasting only once its folder is flushed: without it, power loss could bring an older file back.
  const folder = await open(dirname(path), 'r');
  try {
    await folder.sync();
  } finally {
    await folder.close();
  }
}

/** The entry's state, read from `fetch.json` when not yet held. Throws when the mirror is not there. */
export async function loadState(dataDir: string, key: string, entry: MirrorEntry): Promise<MirrorState> {
  if (entry.state === null) {
    entry.state = await readState(mirrorDirOf(dataDir, key));
    if (entry.state === null) throw new Error(`There is no mirror of disc ${key}; open it from the NAS again.`);
  }
  return entry.state;
}

// ---- Requests ----

/** `ms` through `sleep`, cut short when `signal` aborts (throwing its reason). */
async function pause(ms: number, sleep: (ms: number) => Promise<void>, signal: AbortSignal | undefined): Promise<void> {
  if (!signal) return sleep(ms);
  signal.throwIfAborted();
  let onAbort: () => void = () => {};
  const aborted = new Promise<never>((_, reject) => {
    onAbort = () => reject(signal.reason);
    signal.addEventListener('abort', onAbort, { once: true });
  });
  try {
    await Promise.race([sleep(ms), aborted]);
  } finally {
    signal.removeEventListener('abort', onAbort);
  }
}

/** Waits `ms` on the timer; fetchers take another for tests. */
export const defaultSleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** A failure worth another try: no answer, or a 5xx. */
class Retryable extends Error {}

/**
 * `attempt` with the network rules: a `Retryable` failure or a `NasError('unreachable')` is tried again after 1 s,
 * 2 s, 4 s and 8 s, then is `FetchError('unreachable')`. An abort of `signal` throws its reason at once.
 */
async function withRetries<T>(client: NasClient, attempt: () => Promise<T>, sleep: (ms: number) => Promise<void>, signal?: AbortSignal): Promise<T> {
  for (let i = 0; ; i++) {
    signal?.throwIfAborted();
    try {
      return await attempt();
    } catch (e) {
      signal?.throwIfAborted();
      const retryable = e instanceof Retryable || (e instanceof NasError && e.code === 'unreachable');
      if (!retryable) throw e;
      const delay = RETRY_DELAYS_MS[i];
      if (delay === undefined) throw new FetchError('unreachable', `${hostOf(client.base)} is not answering.`);
      await pause(delay, sleep, signal);
    }
  }
}

function discChanged(): FetchError {
  return new FetchError('disc-changed', 'The disc on the NAS has changed since it was opened.');
}

/** An error answer that is neither 404, 5xx nor a retry: `NasError` with its status. */
function answerError(client: NasClient, status: number, what: string): NasError {
  const host = hostOf(client.base);
  if (status === 401) return new NasError('unauthorized', 401, `${host} refused the encoder's session. Pair it again.`);
  return new NasError('http', status, `${host} answered ${status} for ${what}.`);
}

/** `GET discs/<id>/manifest`, with the network rules; a 404 is `disc-changed`. */
export async function fetchManifest(client: NasClient, discId: string, sleep: (ms: number) => Promise<void> = defaultSleep): Promise<DiscManifest> {
  return withRetries(
    client,
    async () => {
      const res = await client.request(`discs/${encodeURIComponent(discId)}/manifest`);
      if (res.status === 404) {
        await res.body?.cancel();
        throw discChanged();
      }
      if (res.status >= 500) {
        await res.body?.cancel();
        throw new Retryable();
      }
      if (!res.ok) {
        await res.body?.cancel();
        throw answerError(client, res.status, 'a disc manifest');
      }
      let manifest: DiscManifest;
      try {
        manifest = (await res.json()) as DiscManifest;
      } catch {
        throw new Retryable();
      }
      if (!Array.isArray(manifest.files) || typeof manifest.inline !== 'object' || manifest.inline === null) {
        throw new NasError('http', res.status, `${hostOf(client.base)} gave a disc manifest the encoder cannot read.`);
      }
      return manifest;
    },
    sleep,
  );
}

/**
 * Bytes `[start, end]` (inclusive) of disc file `path` (a manifest path), whose size is `size`, with the network
 * rules. A 404, or a `Content-Range` total that is not `size`, is `disc-changed`.
 */
export async function fetchRange(
  client: NasClient,
  discId: string,
  path: string,
  start: number,
  end: number,
  size: number,
  opts: { signal?: AbortSignal; sleep?: (ms: number) => Promise<void> } = {},
): Promise<Uint8Array> {
  const url = `discs/${encodeURIComponent(discId)}/files/${path.split('/').map(encodeURIComponent).join('/')}`;
  const length = end - start + 1;
  return withRetries(
    client,
    async () => {
      const res = await client.request(url, { headers: { Range: `bytes=${start}-${end}` }, ...(opts.signal ? { signal: opts.signal } : {}) });
      if (res.status === 404) {
        await res.body?.cancel();
        throw discChanged();
      }
      if (res.status >= 500) {
        await res.body?.cancel();
        throw new Retryable();
      }
      if (res.status === 206) {
        const m = /^bytes (\d+)-(\d+)\/(\d+)$/.exec(res.headers.get('content-range') ?? '');
        if (!m || Number(m[3]) !== size) {
          await res.body?.cancel();
          throw discChanged();
        }
        if (Number(m[1]) !== start || Number(m[2]) !== end) {
          await res.body?.cancel();
          throw new NasError('http', 206, `${hostOf(client.base)} answered another range than the encoder asked for.`);
        }
      } else if (!(res.status === 200 && start === 0 && end === size - 1)) {
        await res.body?.cancel();
        throw answerError(client, res.status, 'a disc file');
      }
      let body: ArrayBuffer;
      try {
        body = await res.arrayBuffer();
      } catch {
        throw new Retryable(); // The connection dropped mid-answer.
      }
      if (body.byteLength !== length) throw new Retryable();
      return new Uint8Array(body);
    },
    opts.sleep ?? defaultSleep,
    opts.signal,
  );
}

/**
 * `fetchRange` of a mirror's stream file under `state.discId`, then, when the NAS answers `disc-changed`, under each
 * other id the key was mirrored from (newest first): a copy of the disc that is gone does not stop the others.
 */
export async function fetchMirrorRange(
  client: NasClient,
  state: Pick<MirrorState, 'discId' | 'discIds'>,
  path: string,
  start: number,
  end: number,
  size: number,
  opts: { signal?: AbortSignal; sleep?: (ms: number) => Promise<void> } = {},
): Promise<Uint8Array> {
  const ids = [state.discId, ...[...state.discIds].reverse().filter((id) => id !== state.discId)];
  let changed: unknown = null;
  for (const id of ids) {
    try {
      return await fetchRange(client, id, path, start, end, size, opts);
    } catch (e) {
      if (!(e instanceof FetchError && e.code === 'disc-changed')) throw e;
      changed = e;
    }
  }
  throw changed;
}

// ---- ensureMirror ----

/** The stream files of `files` with their sizes: what the disc key covers, and what makes a mirror stale. */
function streamsOf(files: Record<string, number>): Record<string, number> {
  return Object.fromEntries(Object.entries(files).filter(([p]) => isStreamPath(p)));
}

function sameFiles(a: Record<string, number>, b: Record<string, number>): boolean {
  const ka = Object.keys(a);
  return ka.length === Object.keys(b).length && ka.every((k) => b[k] === a[k]);
}

/** Whether any holder claims a clip of the mirror, or the mirror itself. */
function anyHeld(entry: MirrorEntry): boolean {
  return entry.claims.size > 0 || [...entry.holders.values()].some((set) => set.size > 0);
}

/** Makes a sparse file of `size` bytes at `path` (replacing any file there). */
export async function sparseFile(path: string, size: number): Promise<void> {
  const fh = await open(path, 'w');
  try {
    await fh.truncate(size);
  } finally {
    await fh.close();
  }
}

/**
 * Makes or refreshes the mirror of NAS disc `discId`: metadata files whole (inlined ones from the manifest), every
 * .M2TS a sparse file of its manifest size. Throws `disc-changed` when an existing mirror's stream files differ (the old
 * one is removed first, held or not) or when `discKeyOf(discId, manifest.files)` is not `expectedKey` (when given).
 * Returns the mirror folder.
 *
 * Copies of one disc share a key (it covers the stream files only) and may differ in metadata. A mirror whose streams
 * match keeps its fetched ranges; its metadata is rewritten from this manifest when no holder claims any of its clips
 * or the mirror itself (`claimMirror`), and left as the running work started with it otherwise. Either way `discId` becomes the mirror's latest id.
 */
export async function ensureMirror(dataDir: string, client: NasClient, discId: string, expectedKey?: string): Promise<{ dir: string; key: string; label: string }> {
  const manifest = await fetchManifest(client, discId);
  const key = discKeyOf(discId, manifest.files);
  const files: Record<string, number> = {};
  for (const f of manifest.files) {
    localPathOf('', f.path); // Refuse a path that would leave the mirror before anything is written.
    files[f.path] = f.size;
  }
  const streams = streamsOf(files);

  // An earlier mirror of this disc (or at this key) whose stream files differ is stale. One that other copies of its
  // disc still share only forgets this id; one this id alone made goes, held or not, and the caller hears of it.
  let changed = false;
  const root = fetchRootOf(dataDir);
  for (const name of await readdir(root).catch((): string[] => [])) {
    if (parseDiscKey(name) === null) continue;
    const entry = mirrorEntry(dataDir, name);
    const stale = await locked(entry, async () => {
      const dir = join(root, name);
      const state = await readState(dir);
      if (state === null || (name !== key && !state.discIds.includes(discId)) || sameFiles(streamsOf(state.files), streams)) return false;
      const others = state.discIds.filter((id) => id !== discId);
      if (name !== key && others.length > 0) {
        const kept: MirrorState = { ...state, discIds: others, discId: state.discId === discId ? others[others.length - 1]! : state.discId };
        await writeState(dir, kept);
        entry.state = kept;
        return false;
      }
      await rm(dir, { recursive: true, force: true });
      entry.state = null;
      return true;
    });
    changed ||= stale;
  }
  if (changed || (expectedKey !== undefined && key !== expectedKey)) throw discChanged();

  const dir = mirrorDirOf(dataDir, key);
  const entry = mirrorEntry(dataDir, key);
  const label = await locked(entry, async () => {
    await mkdir(dir, { recursive: true });
    const previous = await readState(dir);
    const kept = previous !== null && sameFiles(streamsOf(previous.files), streams) ? previous : null;
    const discIds = [...(kept?.discIds ?? []).filter((id) => id !== discId), discId];

    if (kept !== null && anyHeld(entry)) {
      // Clips are held: the running work keeps the metadata it started with.
      const state: MirrorState = { ...kept, discId, discIds };
      await writeState(dir, state);
      entry.state = state;
      return state.label;
    }

    const ranges: Record<string, ByteRange[]> = {};
    for (const f of manifest.files) {
      const local = localPathOf(dir, f.path);
      await mkdir(dirname(local), { recursive: true });
      const onDisk = await stat(local).catch(() => null);
      const sized = onDisk !== null && onDisk.isFile() && onDisk.size === f.size;
      if (isStreamPath(f.path)) {
        if (kept !== null && sized) ranges[f.path] = kept.ranges[f.path] ?? [];
        else {
          await sparseFile(local, f.size);
          ranges[f.path] = [];
        }
        continue;
      }
      const inline = manifest.inline[f.path];
      if (inline !== undefined) {
        const bytes = Buffer.from(inline, 'base64');
        if (bytes.length !== f.size) throw discChanged();
        await writeAtomic(local, bytes);
      } else if (!(kept !== null && kept.metadataFrom === discId && kept.files[f.path] === f.size && sized)) {
        // Another copy's file may hold other bytes at the same size, so it is fetched again for this one.
        await writeAtomic(local, await wholeFile(client, discId, f.path, f.size));
      }
    }
    // Metadata files of the previous copy that this one does not have.
    for (const path of Object.keys(previous?.files ?? {})) {
      if (!isStreamPath(path) && files[path] === undefined) await rm(localPathOf(dir, path), { force: true });
    }
    const state: MirrorState = { discId, discIds, metadataFrom: discId, discKey: key, label: manifest.name, files, ranges, heads: [] };
    await writeState(dir, state);
    entry.state = state;
    return state.label;
  });
  return { dir, key, label };
}

/** All of disc file `path` from the NAS, in `CHUNK_BYTES` requests. */
async function wholeFile(client: NasClient, discId: string, path: string, size: number): Promise<Uint8Array> {
  const out = new Uint8Array(size);
  for (let at = 0; at < size; at += CHUNK_BYTES) {
    const end = Math.min(size, at + CHUNK_BYTES) - 1;
    out.set(await fetchRange(client, discId, path, at, end, size), at);
  }
  return out;
}
