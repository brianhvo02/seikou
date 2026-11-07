// SPDX-License-Identifier: LGPL-3.0-or-later
import { Semaphore } from '@seikou/fansubs/semaphore';

// The helper lines an episode up, then the user may line it up again or move on and come back; decoding an episode
// takes vspipe tens of seconds, so the last few decodes are kept. Decodes run one at a time because each one keeps a
// whole BestSource decode busy, and a second in parallel would only slow both.

/** One episode's decode, finished or running, and the requests waiting on it. */
interface Entry {
  readonly pcm: Promise<Int16Array>;
  /** Aborts the decode; used once no request is waiting any more. */
  readonly controller: AbortController;
  /** Requests waiting while the decode runs. */
  waiters: number;
  done: boolean;
}

/**
 * Keeps the 16 kHz PCM of the most recently used episodes (`keep` of them; a 24-minute episode is about 46 MB) and
 * decodes the others through `load`, one decode at a time. Concurrent requests for the same episode share one
 * decode. A request whose signal aborts rejects with the signal's reason at once; the decode itself is aborted only
 * when every request waiting on it has gone. A failed or aborted decode is forgotten, so the next request tries again.
 */
export class EpisodeAudioCache {
  private readonly entries = new Map<number, Entry>();
  private readonly decodes = new Semaphore(1);

  /** `load` decodes an episode (1-based) and must stop with a rejection when its signal aborts. */
  constructor(
    private readonly load: (episode: number, signal?: AbortSignal) => Promise<Int16Array>,
    private readonly keep = 2,
  ) {}

  /** The episode's PCM, decoded now or kept from before. */
  get(episode: number, signal?: AbortSignal): Promise<Int16Array> {
    signal?.throwIfAborted();
    let entry = this.entries.get(episode);
    if (entry) {
      // most recently used goes last
      this.entries.delete(episode);
      this.entries.set(episode, entry);
    } else {
      entry = this.start(episode);
    }
    if (entry.done) return entry.pcm;
    return this.wait(entry, signal);
  }

  private start(episode: number): Entry {
    const controller = new AbortController();
    const pcm = this.decodes.run(() => this.load(episode, controller.signal), controller.signal);
    const entry: Entry = { pcm, controller, waiters: 0, done: false };
    this.entries.set(episode, entry);
    pcm.then(
      () => {
        entry.done = true;
        this.evict();
      },
      () => {
        if (this.entries.get(episode) === entry) this.entries.delete(episode);
      },
    );
    return entry;
  }

  /** Waits for a running decode, leaving it when `signal` aborts and aborting it when nobody else waits. */
  private wait(entry: Entry, signal: AbortSignal | undefined): Promise<Int16Array> {
    entry.waiters++;
    return new Promise<Int16Array>((resolve, reject) => {
      let left = false;
      const leave = (): void => {
        if (left) return;
        left = true;
        signal?.removeEventListener('abort', onAbort);
        entry.waiters--;
      };
      const onAbort = (): void => {
        leave();
        if (entry.waiters === 0 && !entry.done) {
          // a request that comes after this starts afresh rather than joining a decode being stopped
          for (const [episode, e] of this.entries) if (e === entry) this.entries.delete(episode);
          entry.controller.abort(signal!.reason);
        }
        reject(signal!.reason);
      };
      signal?.addEventListener('abort', onAbort, { once: true });
      entry.pcm.then(
        (pcm) => {
          leave();
          resolve(pcm);
        },
        (e: unknown) => {
          leave();
          reject(e);
        },
      );
    });
  }

  /** Drops the least recently used finished decodes beyond `keep`; running ones are never dropped. */
  private evict(): void {
    let finished = [...this.entries].filter(([, e]) => e.done);
    while (finished.length > this.keep) {
      this.entries.delete(finished[0]![0]);
      finished = finished.slice(1);
    }
  }
}
