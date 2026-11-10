// SPDX-License-Identifier: LGPL-3.0-or-later
import type { EncodeSettings, Job, JobEpisode, JobProgress } from '../api-types';
import type { AppApi } from './app-api';
import type { EventSourceLike } from './job-events';

// Stand-ins the queue tests share: an event source the test drives and a job to start from.

/** An `EventSource` the test drives: it records its address and lets the test send events, open and fail. */
export class FakeEventSource implements EventSourceLike {
  /** Every source made, in order. */
  static readonly made: FakeEventSource[] = [];
  /** Forgets the sources made so far. */
  static reset(): void {
    FakeEventSource.made.length = 0;
  }
  /** Whether `close` was called. */
  closed = false;
  private readonly handlers = new Map<string, ((e: { data?: string }) => void)[]>();
  /** Set by the code under test. */
  onopen: (() => void) | null = null;
  /** Set by the code under test. */
  onerror: (() => void) | null = null;

  constructor(readonly url: string) {
    FakeEventSource.made.push(this);
  }

  addEventListener(type: string, handler: (e: { data?: string }) => void): void {
    this.handlers.set(type, [...(this.handlers.get(type) ?? []), handler]);
  }

  close(): void {
    this.closed = true;
  }

  /** The browser opening the connection. */
  open(): void {
    this.onopen?.();
  }

  /** The browser failing the connection. */
  fail(): void {
    this.onerror?.();
  }

  /** The server sending the whole queue. */
  sendJobs(jobs: readonly Job[]): void {
    for (const h of this.handlers.get('jobs') ?? []) h({ data: JSON.stringify({ jobs }) });
  }

  /** The server sending a progress report. */
  sendProgress(progress: JobProgress): void {
    for (const h of this.handlers.get('progress') ?? []) h({ data: JSON.stringify(progress) });
  }
}

const unused = (): never => {
  throw new Error('not used');
};

/** The queue methods of `AppApi` for a test of another page, which never calls them. */
export const UNUSED_JOB_API: Pick<
  AppApi,
  'jobs' | 'createJob' | 'createTest' | 'cancelJob' | 'retryJob' | 'removeJob' | 'jobLog' | 'jobDefaults' | 'jobEventsUrl' | 'outputUrl' | 'sampleUrl'
> = {
  jobs: unused,
  createJob: unused,
  createTest: unused,
  sampleUrl: unused,
  cancelJob: unused,
  retryJob: unused,
  removeJob: unused,
  jobLog: unused,
  jobDefaults: unused,
  jobEventsUrl: unused,
  outputUrl: unused,
};

/** The AniList calls, for fakes of pages that never look a show up. */
export const UNUSED_ANILIST_API: Pick<AppApi, 'searchAniList' | 'aniListEntry' | 'aniListEpisodes'> = {
  searchAniList: unused,
  aniListEntry: unused,
  aniListEpisodes: unused,
};

/** The NAS calls, for fakes of pages that never pair. */
export const UNUSED_NAS_API: Pick<AppApi, 'nas' | 'pairNas' | 'unpairNas'> = {
  nas: unused,
  pairNas: unused,
  unpairNas: unused,
};

/** The default profile's settings. */
export const DEFAULT_TEST_SETTINGS: EncodeSettings = {
  crf: 25,
  preset: 4,
  filmGrain: 4,
  extraSvtArgs: [],
  opusBitrate: null,
  pgs: true,
  web: false,
  namePattern: 'episode-{n}',
  destination: 'folder',
};

/** An episode of a made-up job. */
export function makeEpisode(index: number, over: Partial<JobEpisode> = {}): JobEpisode {
  return { index, state: 'queued', framesDone: 0, frames: 0, encoded: false, step: null, stepDone: 0, stepTotal: 0, ...over };
}

/** A running encode of three episodes, the second one encoding, with `over` replacing any field. */
export function makeJob(over: Partial<Job> = {}): Job {
  return {
    id: 'aaaaaaaaaaaaaaaa',
    kind: 'encode',
    disc: { key: `f.${'a'.repeat(32)}`, label: 'LANTERN_HARBOR_D1', dir: '/discs/LANTERN_HARBOR_D1' },
    playlist: '00001',
    episodeSpec: '1-3,4-6,7-',
    settings: DEFAULT_TEST_SETTINGS,
    outDir: '/out/lantern',
    noSubtitles: false,
    state: 'running',
    waiting: null,
    paused: false,
    createdAt: '2026-11-08T10:00:00.000Z',
    startedAt: '2026-11-08T10:00:05.000Z',
    episodes: [
      makeEpisode(1, { state: 'done', framesDone: 1000, frames: 1000, encoded: true, path: '/out/lantern/episode-1.mkv' }),
      makeEpisode(2, { state: 'running', framesDone: 250, frames: 1000 }),
      makeEpisode(3, { state: 'queued' }),
    ],
    recordSavedAt: '2026-11-08T09:00:00.000Z',
    cli: "seikou-encode encode /discs/LANTERN_HARBOR_D1 --playlist 00001 --episodes '1-3,4-6,7-' --out /out/lantern",
    ...over,
  };
}
