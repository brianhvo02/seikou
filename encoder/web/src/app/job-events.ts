// SPDX-License-Identifier: LGPL-3.0-or-later
import { ApiError } from '../api';
import type { Job, JobProgress } from '../api-types';
import type { AppApi } from './app-api';

// The live queue: one server-sent-event stream that reconnects, and the store the whole app reads it through.

/** The part of the browser's `EventSource` the app uses. */
export interface EventSourceLike {
  /** Called when the connection opens. */
  onopen: (() => void) | null;
  /** Called when the connection fails or closes. */
  onerror: (() => void) | null;
  /** Listens for events named `type`; `data` is the event's text. */
  addEventListener(type: string, handler: (e: { data?: string }) => void): void;
  /** Closes the connection for good. */
  close(): void;
}

/** A constructor like `EventSource`'s, which tests replace with a fake. */
export type EventSourceCtor = new (url: string) => EventSourceLike;

/** What `subscribeJobs` and the store can be given besides the client. */
export interface SubscribeOptions {
  /** The `EventSource` to use; the browser's by default. */
  readonly eventSource?: EventSourceCtor;
  /** Hears why the stream keeps failing (the message of `GET /api/jobs`), or null when that answers again. */
  readonly onProblem?: (message: string | null) => void;
}

/** The wait before the next try after `failures` failed connections in a row: 1 s, 2 s, 4 s and on, at most 30 s. */
export function backoffMs(failures: number): number {
  return Math.min(30_000, 1000 * 2 ** Math.max(0, failures));
}

/**
 * Listens to the queue's event stream (`GET /api/jobs/events`, with the token in the address): `onJobs` hears the whole
 * queue on connect and after every change, `onProgress` each progress report. A failed connection is tried again after
 * a wait that doubles from 1 s to 30 s and starts over once a connection opens. After a failure the client asks
 * `GET /api/jobs` why, and `options.onProblem` hears the answer's message when it is an error (a damaged queue file
 * fails the stream the same way every time). Returns the function that stops listening.
 */
export function subscribeJobs(
  api: Pick<AppApi, 'jobEventsUrl' | 'jobs'>,
  onJobs: (jobs: readonly Job[]) => void,
  onProgress: (progress: JobProgress) => void,
  options: SubscribeOptions = {},
): () => void {
  const Source: EventSourceCtor = options.eventSource ?? (EventSource as unknown as EventSourceCtor);
  let stopped = false;
  let failures = 0;
  let source: EventSourceLike | null = null;
  let timer: ReturnType<typeof setTimeout> | undefined;

  const parse = <T>(e: { data?: string }): T | null => {
    try {
      return JSON.parse(e.data ?? '') as T;
    } catch {
      return null;
    }
  };

  const explain = (): void => {
    api.jobs().then(
      () => {
        if (!stopped) options.onProblem?.(null);
      },
      (e: unknown) => {
        if (!stopped) options.onProblem?.(e instanceof ApiError || e instanceof Error ? e.message : String(e));
      },
    );
  };

  const connect = (): void => {
    if (stopped) return;
    const s = new Source(api.jobEventsUrl());
    source = s;
    s.onopen = () => {
      failures = 0;
      options.onProblem?.(null);
    };
    s.addEventListener('jobs', (e) => {
      const body = parse<{ jobs?: Job[] }>(e);
      if (body?.jobs) onJobs(body.jobs);
    });
    s.addEventListener('progress', (e) => {
      const p = parse<JobProgress>(e);
      if (p) onProgress(p);
    });
    s.onerror = () => {
      s.close();
      if (stopped || source !== s) return;
      source = null;
      explain();
      timer = setTimeout(connect, backoffMs(failures));
      failures += 1;
    };
  };

  connect();
  return () => {
    stopped = true;
    clearTimeout(timer);
    source?.close();
    source = null;
  };
}

/** What the whole app knows about the queue. */
export interface JobsSnapshot {
  /** The queue as the server last said it, oldest first; null until the first answer. */
  readonly jobs: readonly Job[] | null;
  /** The latest progress report of each job that is running, by job id. */
  readonly progress: Readonly<Record<string, JobProgress>>;
  /** Why the stream is failing, when `GET /api/jobs` says; null otherwise. */
  readonly problem: string | null;
}

/** The app's one view of the queue, for `useSyncExternalStore`. */
export interface JobsStore {
  /** Calls `listener` on every change; the stream opens with the first listener and closes with the last. */
  subscribe(listener: () => void): () => void;
  /** The current view; the same object until something changes. */
  getSnapshot(): JobsSnapshot;
  /** Puts a job the server just answered (after cancel or retry) into the queue without waiting for the stream. */
  applyJob(job: Job): void;
  /** Takes a removed job out of the queue without waiting for the stream. */
  dropJob(id: string): void;
}

/** Makes the store over `api`'s event stream; one stream is shared by every listener. */
export function createJobsStore(api: Pick<AppApi, 'jobEventsUrl' | 'jobs'>, options: SubscribeOptions = {}): JobsStore {
  let snapshot: JobsSnapshot = { jobs: null, progress: {}, problem: null };
  const listeners = new Set<() => void>();
  let stop: (() => void) | null = null;

  const set = (next: JobsSnapshot): void => {
    snapshot = next;
    for (const l of [...listeners]) l();
  };

  const keepRunning = (progress: JobsSnapshot['progress'], jobs: readonly Job[]): JobsSnapshot['progress'] => {
    const kept: Record<string, JobProgress> = {};
    for (const job of jobs) {
      const p = progress[job.id];
      if (p !== undefined && job.state === 'running') kept[job.id] = p;
    }
    return kept;
  };

  return {
    subscribe(listener) {
      listeners.add(listener);
      if (stop === null) {
        stop = subscribeJobs(
          api,
          (jobs) => set({ ...snapshot, jobs, progress: keepRunning(snapshot.progress, jobs) }),
          (p) => set({ ...snapshot, progress: { ...snapshot.progress, [p.jobId]: p } }),
          {
            ...options,
            onProblem: (problem) => {
              if (problem !== snapshot.problem) set({ ...snapshot, problem });
              options.onProblem?.(problem);
            },
          },
        );
      }
      return () => {
        listeners.delete(listener);
        if (listeners.size === 0) {
          stop?.();
          stop = null;
        }
      };
    },
    getSnapshot: () => snapshot,
    applyJob(job) {
      const jobs = snapshot.jobs ?? [];
      const at = jobs.findIndex((j) => j.id === job.id);
      const next = at === -1 ? [...jobs, job] : jobs.map((j) => (j.id === job.id ? job : j));
      set({ ...snapshot, jobs: next, progress: keepRunning(snapshot.progress, next) });
    },
    dropJob(id) {
      if (snapshot.jobs === null) return;
      set({ ...snapshot, jobs: snapshot.jobs.filter((j) => j.id !== id) });
    },
  };
}
