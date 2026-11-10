// SPDX-License-Identifier: LGPL-3.0-or-later
import { open, readdir, readFile, statfs } from 'node:fs/promises';
import { dirname } from 'node:path';
import { parseDiscKey } from '@seikou/nas/disc-key';
import { loadPlaylist } from '../disc/playlist';
import { episodeItems, parseEpisodeSpec, type EpisodePlan } from '../plan/episodes';
import type { NasClient } from './client';
import {
  addRange,
  bytesIn,
  CHUNK_BYTES,
  coveredIn,
  defaultSleep,
  fetchMirrorRange,
  FetchError,
  fetchRootOf,
  gapsIn,
  headLength,
  isMirror,
  isStreamPath,
  loadState,
  localPathOf,
  locked,
  mirrorDirOf,
  mirrorEntry,
  type MirrorEntry,
  readState,
  ROOM_MARGIN_BYTES,
  streamPathOf,
  writeState,
} from './mirror';

// Fetching into a mirror: clip heads for probing, whole clips while a holder (a job's episode, a helper session's
// line-up) claims them, emptied back to their heads when no holder does. Holders are kept in memory only, so after a
// start nothing is held, and the runner's start sweep (`sweepUnheld`) empties every whole clip.

/** Free bytes on the filesystem of `dir`. */
async function statfsFree(dir: string): Promise<number> {
  const s = await statfs(dir);
  return s.bavail * s.bsize;
}

/** One stretch of a stream file to have here: `[0, end)`. */
interface Want {
  readonly path: string;
  readonly end: number;
}

/**
 * Fetches clips of one mirror from the NAS: heads for probing, whole clips while a holder claims them. Every fetcher of
 * a data directory and disc key shares the holders and the running downloads.
 */
export class ClipFetcher {
  private readonly dataDir: string;
  private readonly client: NasClient;
  private readonly key: string;
  private readonly signal: AbortSignal | undefined;
  private readonly onProgress: ((p: { bytesDone: number; bytes: number }) => void) | undefined;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly freeBytes: (dir: string) => Promise<number>;
  private readonly entry: MirrorEntry;

  constructor(o: {
    dataDir: string;
    client: NasClient;
    key: string;
    signal?: AbortSignal;
    onProgress?: (p: { bytesDone: number; bytes: number }) => void;
    sleep?: (ms: number) => Promise<void>;
    /** Free bytes on the mirror's filesystem (`statfs`'s `bavail * bsize` by default); tests stand in for it. */
    freeBytes?: (dir: string) => Promise<number>;
  }) {
    this.dataDir = o.dataDir;
    this.client = o.client;
    this.key = o.key;
    this.signal = o.signal;
    this.onProgress = o.onProgress;
    this.sleep = o.sleep ?? defaultSleep;
    this.freeBytes = o.freeBytes ?? statfsFree;
    this.entry = mirrorEntry(o.dataDir, o.key);
  }

  private get dir(): string {
    return mirrorDirOf(this.dataDir, this.key);
  }

  /** Fetches the first HEAD_BYTES of each clip a playlist names (what probing reads). */
  async heads(playlistId: string): Promise<void> {
    const playlist = await loadPlaylist(this.dir, playlistId);
    const state = await loadState(this.dataDir, this.key, this.entry);
    const paths = [...new Set(playlist.items.map((i) => streamPathOf(`${i.clipId}.M2TS`)))];
    await this.fetchAll(paths.map((path) => ({ path, end: headLength(this.sizeOf(state.files, path)) })));
  }

  /**
   * Fetches `clips` (stream file names such as '00001.M2TS') whole for `holder`; resumes from `fetch.json`; checks room
   * first (throws `no-room` naming the bytes needed). The claim is made before anything is fetched and stays when the
   * hold fails, so the caller always `release`s it.
   */
  async hold(holder: string, clips: readonly string[]): Promise<void> {
    const state = await loadState(this.dataDir, this.key, this.entry);
    const paths = [...new Set(clips.map(streamPathOf))];
    const wants = paths.map((path) => ({ path, end: this.sizeOf(state.files, path) }));
    for (const { path } of wants) {
      let set = this.entry.holders.get(path);
      if (!set) this.entry.holders.set(path, (set = new Set()));
      set.add(holder);
    }
    await this.fetchAll(wants);
  }

  /** Drops `holder`'s claim; a clip no holder claims is emptied back to a sparse file keeping its head. */
  async release(holder: string, clips?: readonly string[]): Promise<void> {
    const paths = clips === undefined ? [...this.entry.holders.keys()] : [...new Set(clips.map(streamPathOf))];
    const freed: string[] = [];
    for (const path of paths) {
      const set = this.entry.holders.get(path);
      if (!set?.delete(holder)) continue;
      if (set.size === 0) {
        this.entry.holders.delete(path);
        freed.push(path);
      }
    }
    for (const path of freed) await emptyClip(this.dataDir, this.key, this.entry, path);
  }

  private sizeOf(files: Record<string, number>, path: string): number {
    const size = files[path];
    if (size === undefined || !isStreamPath(path)) throw new Error(`The disc has no stream file ${path.slice('BDMV/STREAM/'.length)}.`);
    return size;
  }

  /** Has each want here: checks room for what is missing, then fetches it, sharing a download already running. */
  private async fetchAll(wants: readonly Want[]): Promise<void> {
    this.signal?.throwIfAborted();
    const state = await loadState(this.dataDir, this.key, this.entry);
    const bytes = wants.reduce((sum, w) => sum + bytesIn(gapsIn(state.ranges[w.path] ?? [], 0, w.end)), 0);
    if (bytes === 0) return;
    const free = await this.freeBytes(this.dir);
    if (bytes + ROOM_MARGIN_BYTES > free) {
      throw new FetchError(
        'no-room',
        `Fetching from the NAS needs ${bytes} bytes plus ${ROOM_MARGIN_BYTES} bytes kept free, and the drive has ${Math.max(0, free)} bytes free.`,
      );
    }
    let done = 0;
    const tick = (n: number): void => {
      done = Math.min(bytes, done + n);
      this.onProgress?.({ bytesDone: done, bytes });
    };
    for (const want of wants) await this.fetchOne(want, tick);
    if (done < bytes) this.onProgress?.({ bytesDone: bytes, bytes });
  }

  /** Has `[0, want.end)` of one stream file here; waits on a download already running for it rather than starting another. */
  private async fetchOne(want: Want, tick: (n: number) => void): Promise<void> {
    for (;;) {
      const running = this.entry.inflight.get(want.path);
      if (running) {
        await running.catch(() => undefined);
        this.signal?.throwIfAborted();
        continue;
      }
      const state = await loadState(this.dataDir, this.key, this.entry);
      const gaps = gapsIn(state.ranges[want.path] ?? [], 0, want.end);
      if (gaps.length === 0) return;
      const download = this.download(want.path, gaps, tick);
      this.entry.inflight.set(want.path, download);
      try {
        await download;
      } finally {
        if (this.entry.inflight.get(want.path) === download) this.entry.inflight.delete(want.path);
      }
      return;
    }
  }

  /** Fetches `gaps` of stream file `path` in `CHUNK_BYTES` requests, each written in place, flushed, then recorded. */
  private async download(path: string, gaps: readonly [number, number][], tick: (n: number) => void): Promise<void> {
    const size = (await loadState(this.dataDir, this.key, this.entry)).files[path]!;
    for (const [from, to] of gaps) {
      for (let at = from; at < to; at += CHUNK_BYTES) {
        const end = Math.min(to, at + CHUNK_BYTES);
        const ids = await loadState(this.dataDir, this.key, this.entry);
        const bytes = await fetchMirrorRange(this.client, ids, path, at, end - 1, size, {
          ...(this.signal ? { signal: this.signal } : {}),
          sleep: this.sleep,
        });
        await locked(this.entry, async () => {
          const state = this.entry.state;
          // The mirror was removed, or made again with other files, meanwhile: nothing of this download belongs in it.
          if (state === null || state.files[path] !== size) throw new FetchError('disc-changed', 'The disc on the NAS has changed since it was opened.');
          const fh = await open(localPathOf(this.dir, path), 'r+');
          try {
            await fh.write(bytes, 0, bytes.length, at);
            await fh.sync();
          } finally {
            await fh.close();
          }
          state.ranges[path] = addRange(state.ranges[path] ?? [], at, end);
          await writeState(this.dir, state);
        });
        tick(bytes.length);
      }
    }
  }
}

/**
 * Empties stream file `path` of mirror `key` back to a sparse file that keeps the fetched part of its head. A download
 * of the clip already running is waited for first, and nothing happens when a holder claims the clip by the time the
 * lock is held, or when nothing past the head is here. The order keeps the record never larger than the file: the
 * shrunken ranges are written first, then the rest is freed by truncating to the head and back to the full size, so
 * the head never leaves the disk and a crash at any point loses only bytes no longer recorded.
 */
async function emptyClip(dataDir: string, key: string, entry: MirrorEntry, path: string): Promise<void> {
  for (let running = entry.inflight.get(path); running; running = entry.inflight.get(path)) await running.catch(() => undefined);
  await locked(entry, async () => {
    if (entry.holders.has(path)) return;
    const state = await loadState(dataDir, key, entry).catch(() => null);
    const size = state?.files[path];
    if (!state || size === undefined) return;
    const ranges = state.ranges[path] ?? [];
    const head = headLength(size);
    const keep = coveredIn(ranges, 0, head);
    if (bytesIn(keep) === bytesIn(ranges)) return;
    const dir = mirrorDirOf(dataDir, key);
    state.ranges[path] = keep;
    await writeState(dir, state);
    const fh = await open(localPathOf(dir, path), 'r+');
    try {
      await fh.truncate(head);
      await fh.truncate(size);
      await fh.sync();
    } finally {
      await fh.close();
    }
  });
}

/**
 * The start sweep: empties every whole clip of every mirror in `dataDir` that no holder claims, keeping heads. The
 * queue runner calls it when it starts, since holders live in memory and a restart left none.
 */
export async function sweepUnheld(dataDir: string): Promise<void> {
  for (const key of await readdir(fetchRootOf(dataDir)).catch((): string[] => [])) {
    if (parseDiscKey(key) === null) continue;
    const entry = mirrorEntry(dataDir, key);
    const state = entry.state ?? (await readState(mirrorDirOf(dataDir, key)));
    if (state === null) continue;
    for (const path of Object.keys(state.files)) {
      if (isStreamPath(path) && !entry.holders.has(path)) await emptyClip(dataDir, key, entry, path);
    }
  }
}

/**
 * Claims the metadata of mirror `key` for `holder` (`session:<id>`): while any claim or clip holder stands, opening
 * another copy of the disc leaves the mirror's metadata as it is, so work that planned from it keeps reading the same
 * files. Claiming twice is one claim.
 */
export function claimMirror(dataDir: string, key: string, holder: string): void {
  mirrorEntry(dataDir, key).claims.add(holder);
}

/** Drops `holder`'s claim on the metadata of mirror `key`. */
export function releaseMirror(dataDir: string, key: string, holder: string): void {
  mirrorEntry(dataDir, key).claims.delete(holder);
}

/** The stream files episode `index` (1-based) of `episodeSpec` reads (its plan's segments' clips), as '00001.M2TS'. */
export async function clipsOfEpisode(discDir: string, playlistId: string, episodeSpec: string, index: number): Promise<string[]> {
  const playlist = await loadPlaylist(discDir, playlistId);
  const spec = parseEpisodeSpec(episodeSpec, playlist.chapters.length)[index - 1];
  if (spec === undefined) throw new RangeError(`Episode ${index} is not in the list ${episodeSpec}.`);
  return [...new Set(episodeItems(playlist, spec).map((item) => `${item.clipId}.M2TS`))];
}

/**
 * Throws `Error('Clip <name> is not fetched from the NAS yet')` for the first of `clips` (stream file names such as
 * '00001.M2TS') that mirror `dir` (the folder holding BDMV) does not hold whole, as its `fetch.json` records; a folder
 * that is not a mirror passes. A guard against a bug, run before anything reads a clip past its head (BestSource,
 * the PG reader): every such reader works on clips a holder has fetched.
 */
export async function assertFetched(dir: string, clips: readonly string[]): Promise<void> {
  if (!(await isMirror(dir))) return;
  const state = await readState(dir);
  for (const clip of clips) {
    const path = streamPathOf(clip);
    const size = state?.files[path];
    if (size === undefined || gapsIn(state?.ranges[path] ?? [], 0, size).length > 0) throw new Error(`Clip ${clip} is not fetched from the NAS yet`);
  }
}

/** `assertFetched` for the clips `plan`'s segments read, on the disc they lie on. */
export async function assertPlanFetched(plan: Pick<EpisodePlan, 'segments'>): Promise<void> {
  const first = plan.segments[0];
  if (first === undefined) return;
  // A clip lies at <disc>/BDMV/STREAM/<clip>.m2ts.
  const dir = dirname(dirname(dirname(first.item.m2tsPath)));
  await assertFetched(dir, [...new Set(plan.segments.map((s) => `${s.item.clipId}.M2TS`))]);
}

/**
 * Reads `[start, end]` of a mirror file: local bytes where fetched, else from the NAS (not stored). An abort of
 * `signal` stops the NAS requests and their retries, throwing its reason.
 */
export async function readMirrorRange(
  dataDir: string,
  client: NasClient,
  key: string,
  path: string,
  start: number,
  end: number,
  signal?: AbortSignal,
): Promise<Uint8Array> {
  const entry = mirrorEntry(dataDir, key);
  const dir = mirrorDirOf(dataDir, key);
  const state = await loadState(dataDir, key, entry);
  const size = state.files[path];
  if (size === undefined) throw new Error(`The disc has no file ${path}.`);
  if (!(Number.isInteger(start) && Number.isInteger(end) && start >= 0 && end >= start && end < size)) {
    throw new RangeError(`Bytes ${start}-${end} are not in ${path} (${size} bytes).`);
  }
  const out = new Uint8Array(end - start + 1);
  if (!isStreamPath(path)) {
    const whole = await readFile(localPathOf(dir, path));
    out.set(whole.subarray(start, end + 1));
    return out;
  }
  // What is here is read under the lock, so a clip being emptied meanwhile never gives zeros.
  const gaps = await locked(entry, async () => {
    const ranges = entry.state?.ranges[path] ?? [];
    const here = coveredIn(ranges, start, end + 1);
    if (here.length > 0) {
      const fh = await open(localPathOf(dir, path), 'r');
      try {
        for (const [a, b] of here) await fh.read(out, a - start, b - a, a);
      } finally {
        await fh.close();
      }
    }
    return gapsIn(ranges, start, end + 1);
  });
  for (const [a, b] of gaps) out.set(await fetchMirrorRange(client, entry.state ?? state, path, a, b - 1, size, signal ? { signal } : {}), a - start);
  return out;
}
