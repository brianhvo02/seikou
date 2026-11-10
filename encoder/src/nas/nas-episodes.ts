// SPDX-License-Identifier: LGPL-3.0-or-later
import { unlink } from 'node:fs/promises';
import type { NasClient } from './client';
import { ClipFetcher, clipsOfEpisode, releaseHolder } from './fetch';
import { uploadEpisode, type UploadState } from './upload';

// The command line's episode loop for the NAS: a NAS disc's clips fetched one episode ahead and let go of once no later
// episode needs them, and each encoded episode uploaded and deleted here once the NAS has it. Nothing is kept between
// runs (the queue in `src/server/jobs.ts` is what resumes); a failure stops the loop.

/** What `runNasEpisodes` works on. */
export interface NasEpisodesOptions {
  readonly dataDir: string;
  readonly client: NasClient;
  /** The disc folder: a NAS mirror (`fetchClips`) or a disc on this computer. */
  readonly discDir: string;
  readonly discKey: string;
  readonly playlistId: string;
  readonly episodeSpec: string;
  /** How many episodes the spec has; they are encoded in order, from 1. */
  readonly episodeCount: number;
  /** Whether the disc is a NAS mirror whose clips are fetched before each episode. */
  readonly fetchClips: boolean;
  /** The NAS file name of each episode (`<encode id>.mkv`, in episode order), or null to keep the MKVs here. */
  readonly uploadNames: readonly string[] | null;
  /** Who holds the clips (`cli:<id>`); every claim is let go of when the loop ends, however it ends. */
  readonly holder: string;
  readonly signal: AbortSignal;
  /** Encodes episode `index` (1-based) and resolves with its MKV. */
  encode(index: number): Promise<string>;
  /** One line of what happens, for the terminal. */
  log(line: string): void;
  readonly sleep?: (ms: number) => Promise<void>;
  readonly uploadChunkBytes?: number;
}

/** A failed or stopped episode upload; the MKV is kept at `path`. */
export class NasUploadFailed extends Error {
  constructor(
    readonly episode: number,
    readonly path: string,
    readonly cause: unknown,
  ) {
    super(`${cause instanceof Error ? cause.message : String(cause)}\n${keptLine(episode, path)}`);
    this.name = 'NasUploadFailed';
  }

  /** The line saying where the MKV is kept. */
  get kept(): string {
    return keptLine(this.episode, this.path);
  }
}

function keptLine(episode: number, path: string): string {
  return `The MKV of episode ${episode} is kept at ${path}.`;
}

/**
 * Encodes every episode in order: for a NAS disc it holds the episode's clips (fetched while the episode before was
 * encoding, the rest now) and starts fetching the next episode's, then encodes, then lets go of the clips no later
 * episode needs; with `uploadNames` it uploads the MKV and deletes it once the NAS's `complete` answer came. Resolves
 * with the NAS's encode ids (empty without uploads). The first failure rejects: a fetch's `FetchError` or `NasError`,
 * the encode's error, or `NasUploadFailed` with the kept MKV (an abort during an upload too, its `cause` the abort's);
 * every clip claim is let go of first.
 */
export async function runNasEpisodes(o: NasEpisodesOptions): Promise<string[]> {
  const clipsOf = (index: number): Promise<string[]> => clipsOfEpisode(o.discDir, o.playlistId, o.episodeSpec, index);
  const fetcher = (signal: AbortSignal): ClipFetcher => new ClipFetcher({ dataDir: o.dataDir, client: o.client, key: o.discKey, signal, sleep: o.sleep });
  // the fetch of the next episode's clips, which runs while an episode encodes and stops with the loop
  const ahead = new AbortController();
  const stopAhead = (): void => ahead.abort();
  o.signal.addEventListener('abort', stopAhead, { once: true });
  let fetching: Promise<void> | null = null;
  const ids: string[] = [];
  try {
    for (let index = 1; index <= o.episodeCount; index++) {
      if (o.signal.aborted) throw new DOMException('Stopped', 'AbortError');
      if (o.fetchClips) {
        const clips = await clipsOf(index);
        o.log(`Episode ${index}: fetching ${clips.join(', ')} from the NAS.`);
        // a failure of the fetch that ran ahead is this step's; holding again fetches only what it missed
        await fetching?.catch(() => undefined);
        fetching = null;
        await fetcher(o.signal).hold(o.holder, clips);
        if (index < o.episodeCount) {
          const next = fetcher(ahead.signal).hold(o.holder, await clipsOf(index + 1));
          next.catch(() => undefined); // reported by that episode's own fetch step
          fetching = next;
        }
      }
      const path = await o.encode(index);
      if (o.fetchClips) {
        const later = new Set<string>();
        for (let i = index + 1; i <= o.episodeCount; i++) for (const clip of await clipsOf(i)) later.add(clip);
        const free = (await clipsOf(index)).filter((c) => !later.has(c));
        if (free.length > 0) await releaseHolder(o.dataDir, o.discKey, o.holder, free);
      }
      const name = o.uploadNames?.[index - 1];
      if (name === undefined) continue;
      o.log(`Episode ${index}: uploading ${path} to the NAS as ${name}.`);
      const state: UploadState = { id: null, sha256: null, size: 0, sent: 0 };
      let id: string;
      try {
        id = await uploadEpisode(o.client, path, name, state, { signal: o.signal, sleep: o.sleep, chunkBytes: o.uploadChunkBytes });
      } catch (e) {
        throw new NasUploadFailed(index, path, e);
      }
      ids.push(id);
      await unlink(path).catch((e: unknown) => {
        if ((e as NodeJS.ErrnoException).code !== 'ENOENT') o.log(`${path} is on the NAS but could not be deleted here: ${e instanceof Error ? e.message : String(e)}`);
      });
      o.log(`Episode ${index}: on the NAS as ${id}; ${path} deleted.`);
    }
    return ids;
  } finally {
    o.signal.removeEventListener('abort', stopAhead);
    ahead.abort();
    await fetching?.catch(() => undefined);
    if (o.fetchClips) await releaseHolder(o.dataDir, o.discKey, o.holder).catch(() => undefined);
  }
}
