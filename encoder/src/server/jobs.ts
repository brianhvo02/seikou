// SPDX-License-Identifier: LGPL-3.0-or-later
import { randomBytes } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { appendFileSync, mkdirSync } from 'node:fs';
import { readFile, realpath, rm, unlink, mkdir } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, resolve, sep } from 'node:path';
import { replaceAtomically } from '@seikou/titles';
import { loadPlaylist } from '../disc/playlist';
import { encodeEpisodes, episodeName, type EncodeEvent, type EncodeOptions } from '../encode';
import { packageEpisode } from '../package/package';
import { EpisodeSpecError, parseEpisodeSpec, sameEpisodeList } from '../plan/episodes';
import { loadEncodeRecord, MissingSubtitleFilesError, NoAudioChosenError, RecordMismatchError } from '../subs/encode-record';
import { RecordError, RecordStore, type SubtitleRecord } from '../subs/record';
import type { AppContext } from './http';
import { libraryOf } from './library';
import { takeJobsLock, type JobsLock } from './jobs-lock';
import { parseSettings, ProfileError, type EncodeSettings } from './profiles';
import { discOf, sessionsOf } from './sessions';
import { parseTestProfiles, planTest, runTestEncode, testDirOf, TestInputError, type TestOutcome, type TestPlan } from './test-encode';

// The encode queue: jobs kept in `<data>/jobs.json`, run one at a time in this process. A job encodes one disc
// playlist's episodes into one output folder with a copy of the settings it was queued with. The runner encodes one
// episode per `encodeEpisodes` call, so it can stop between episodes (for a test job, which goes first) and so an
// episode counts as done only once the runner has seen it finish.

/** What a job does: encode a playlist's episodes, or encode short samples to compare settings. */
export type JobKind = 'encode' | 'test';

/** Where a job is: waiting, encoding, or finished one of four ways. */
export type JobState = 'queued' | 'running' | 'done' | 'failed' | 'interrupted' | 'cancelled';

/** Where one episode of a job is. `packaging-failed`: the MKV is complete but the web package is not. */
export type EpisodeState = 'queued' | 'running' | 'done' | 'packaging-failed' | 'failed';

/** One episode of a job. */
export interface JobEpisode {
  /** 1-based position in the job's episode list. */
  readonly index: number;
  /** Where it is. */
  state: EpisodeState;
  /** Video frames written so far in the current or last attempt. */
  framesDone: number;
  /** The episode's video frames in all; 0 until the encoder has said. */
  frames: number;
  /** Whether the runner saw the episode's MKV completed (its closing progress or its `episode-done`). */
  encoded: boolean;
  /** The episode's MKV, once known. */
  path?: string;
  /** Why the episode failed. */
  error?: string;
}

/** One queued encode or test, as `jobs.json` keeps it and the job routes answer it. */
export interface Job {
  /** 16 lower-case hex digits. */
  readonly id: string;
  /** What the job does. */
  readonly kind: JobKind;
  /** The disc: its key, its folder's name and the real path of the folder holding BDMV. */
  readonly disc: { readonly key: string; readonly label: string; readonly dir: string };
  /** Five-digit playlist name. */
  readonly playlist: string;
  /** The episode list as it was given. */
  readonly episodeSpec: string;
  /** The job's own copy of the settings it was queued with. */
  readonly settings: EncodeSettings;
  /** The absolute folder the episodes are written to (for a test, `<data>/tests/<id>`). */
  readonly outDir: string;
  /** Whether the encode leaves the saved subtitle record out. */
  readonly noSubtitles: boolean;
  /** Where the job is. */
  state: JobState;
  /** True while a test job runs ahead of this one between two of its episodes; the job is then `queued` and resumes first. */
  paused: boolean;
  /** ISO 8601 times. */
  readonly createdAt: string;
  /** When the job first ran. */
  startedAt?: string;
  /** When it last finished, failed or stopped. */
  finishedAt?: string;
  /**
   * The episodes, in order. For a test job, one entry per sample encode, numbered as the test's progress units:
   * stretch by stretch, each with every profile in order.
   */
  episodes: JobEpisode[];
  /** Why the job failed. */
  error?: string;
  /** The `savedAt` of the subtitle record the job's episodes were encoded with; null with no record or before the first run. */
  recordSavedAt: string | null;
  /** The equivalent `seikou-encode encode …` command, quoted for a POSIX shell; empty for a test job. */
  readonly cli: string;
  /** A test job's profiles, stretches, episode lengths and, once it is done, its measurements; absent on an encode job. */
  test?: TestPlan;
}

/** What a job is queued from; the routes pass the request body's fields as they are, and `add` checks them. */
export interface JobInput {
  /** `encode` (the default) or `test`. */
  readonly kind?: unknown;
  /** The disc's key, of a disc the library holds or a helper session is on. */
  readonly discKey: unknown;
  /** Five-digit playlist name. */
  readonly playlistId: unknown;
  /** The episode list. */
  readonly episodeSpec: unknown;
  /** The settings (see `parseSettings`); ignored for a test job, which takes its first profile's. */
  readonly settings?: unknown;
  /** A test job's one to three profiles, each `{ id, name, settings }` (see `parseTestProfiles`). */
  readonly profiles?: unknown;
  /** An absolute folder; ignored for a test job. */
  readonly outDir?: unknown;
  /** Leave the saved subtitle record out (and skip its check). */
  readonly noSubtitles?: unknown;
}

/** A progress report: at most one a second per episode, plus each episode's first and closing 100% reports. */
export interface JobProgress {
  /** The job. */
  readonly jobId: string;
  /** 1-based episode number. */
  readonly episode: number;
  /** Video frames written so far. */
  readonly framesDone: number;
  /** The episode's video frames in all. */
  readonly frames: number;
  /** Frames per second since the episode started; null before any time has passed. */
  readonly fps: number | null;
  /** Seconds left for this episode at that speed, rounded; null when the speed is unknown. */
  readonly etaSeconds: number | null;
}

/** A job call that is refused: the HTTP status, a short code the page tests, and any more fields for the answer. */
export class JobError extends Error {
  override name = 'JobError';
  constructor(
    /** The HTTP status to answer with. */
    readonly status: number,
    /** A short kebab-case word. */
    readonly code: string,
    message: string,
    /** More fields of the error answer, such as `field` or the two episode lists of a record mismatch. */
    readonly extra: Readonly<Record<string, unknown>> = {},
  ) {
    super(message);
  }
}

/**
 * Runs a test job: encodes its samples into `job.outDir` and reports through `onEvent` as an encode does, each event's
 * `episode` the number of a sample encode in `job.episodes` (its `progress` events reach the progress stream). It must
 * stop, with every tool exited, and reject when `signal` aborts. Resolving marks the job done and stores the outcome in
 * `job.test`; rejecting marks it failed (or cancelled, when `signal` aborted).
 */
export type TestRunner = (job: Job, signal: AbortSignal, onEvent: (e: EncodeEvent) => void) => Promise<TestOutcome>;

/** What the runner does its work with; tests replace them. */
export interface JobRunnerDeps {
  /** Encodes episodes; the runner always passes one episode in `onlyEpisodes`. Default `encodeEpisodes`. */
  readonly encode: (options: EncodeOptions, onEvent: (e: EncodeEvent) => void) => Promise<string[]>;
  /** Packages a finished MKV for the web player, for an episode whose packaging failed. Default `packageEpisode`. */
  readonly packageEpisode: (mkvPath: string, outDir: string) => Promise<unknown>;
  /** Runs a test job. Default `runTestEncode` with the app's data folder and tools. */
  readonly runTest: TestRunner;
  /** The clock, in milliseconds since the epoch: times in jobs, log lines and the progress pacing. */
  readonly now: () => number;
  /** Hears about problems with `jobs.json` and the logs. */
  readonly log: (message: string) => void;
}

const PROGRESS_INTERVAL_MS = 1000;
/** The most lines the log route answers. */
export const MAX_LOG_TAIL = 2000;

const FINISHED: ReadonlySet<JobState> = new Set(['done', 'failed', 'interrupted', 'cancelled']);
const RETRYABLE: ReadonlySet<JobState> = new Set(['failed', 'interrupted', 'cancelled']);
const JOB_STATES: ReadonlySet<string> = new Set(['queued', 'running', ...FINISHED]);
const EPISODE_STATES: ReadonlySet<string> = new Set(['queued', 'running', 'done', 'packaging-failed', 'failed']);

const message = (e: unknown): string => (e instanceof Error ? e.message : String(e));

/** `text` as one POSIX shell word: as it is when it holds only safe characters, else in single quotes. */
function shellWord(text: string): string {
  if (/^[A-Za-z0-9_/.,:=+@%-]+$/.test(text)) return text;
  return `'${text.replaceAll("'", `'\\''`)}'`;
}

/**
 * The `seikou-encode encode …` command that encodes what a job with these values does: the disc folder, playlist,
 * episode list and output folder, then the name pattern, CRF, preset and film grain, and the flags the other settings
 * imply (`--svt-args`, `--opus-bitrate`, `--no-subtitles`, `--no-pgs`, `--web <outDir>/web`). Every word is quoted for
 * a POSIX shell, so the command can be pasted.
 */
export function jobCli(o: { discDir: string; playlistId: string; episodeSpec: string; outDir: string; noSubtitles: boolean; settings: EncodeSettings }): string {
  const s = o.settings;
  const words = ['seikou-encode', 'encode', o.discDir, '--playlist', o.playlistId, '--episodes', o.episodeSpec, '--out', o.outDir];
  words.push('--name', s.namePattern, '--crf', String(s.crf), '--preset', String(s.preset), '--film-grain', String(s.filmGrain));
  if (s.extraSvtArgs.length > 0) words.push('--svt-args', s.extraSvtArgs.join(' '));
  if (s.opusBitrate !== null) words.push('--opus-bitrate', String(s.opusBitrate));
  if (o.noSubtitles) words.push('--no-subtitles');
  if (!s.pgs) words.push('--no-pgs');
  if (s.web) words.push('--web', webDirOf(o.outDir));
  return words.map(shellWord).join(' ');
}

/** The folder a job's web packages go to. */
function webDirOf(outDir: string): string {
  return join(outDir, 'web');
}

/**
 * The real path `p` would have: the real path of its deepest existing folder with the rest appended, so a folder that
 * does not exist yet is compared as it will be once made.
 */
async function realPathOf(p: string): Promise<string> {
  let current = resolve(p);
  const rest: string[] = [];
  for (;;) {
    try {
      return join(await realpath(current), ...rest.reverse());
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code;
      if (code !== 'ENOENT' && code !== 'ENOTDIR') throw e;
      const parent = dirname(current);
      if (parent === current) return resolve(p);
      rest.push(basename(current));
      current = parent;
    }
  }
}

/** Whether `child` is `parent` or inside it. */
function within(child: string, parent: string): boolean {
  return child === parent || child.startsWith(parent.endsWith(sep) ? parent : parent + sep);
}

/** Checks one stored job's shape; throws on anything that is not a job this runner wrote. */
function parseStoredJob(value: unknown): Job {
  if (typeof value !== 'object' || value === null) throw new Error('a job is not an object');
  const j = value as Record<string, unknown>;
  const str = (v: unknown, name: string): string => {
    if (typeof v !== 'string') throw new Error(`job ${name} is not text`);
    return v;
  };
  const optStr = (v: unknown, name: string): string | undefined => (v === undefined ? undefined : str(v, name));
  const id = str(j.id, 'id');
  if (!/^[0-9a-f]{16}$/.test(id)) throw new Error('bad job id');
  if (j.kind !== 'encode' && j.kind !== 'test') throw new Error('bad job kind');
  if (!JOB_STATES.has(str(j.state, 'state'))) throw new Error('bad job state');
  const disc = j.disc as Record<string, unknown> | null;
  if (typeof disc !== 'object' || disc === null) throw new Error('job disc is not an object');
  const outDir = str(j.outDir, 'outDir');
  if (!isAbsolute(outDir)) throw new Error('job outDir is not absolute');
  if (!Array.isArray(j.episodes)) throw new Error('job episodes is not a list');
  const episodes = j.episodes.map((e: unknown): JobEpisode => {
    const ep = e as Record<string, unknown>;
    if (typeof ep !== 'object' || ep === null || typeof ep.index !== 'number' || !Number.isInteger(ep.index) || ep.index < 1) throw new Error('bad episode');
    if (!EPISODE_STATES.has(str(ep.state, 'episode state'))) throw new Error('bad episode state');
    if (typeof ep.framesDone !== 'number' || typeof ep.frames !== 'number') throw new Error('bad episode frames');
    const out: JobEpisode = { index: ep.index, state: ep.state as EpisodeState, framesDone: ep.framesDone, frames: ep.frames, encoded: ep.encoded === true };
    const path = optStr(ep.path, 'episode path');
    const error = optStr(ep.error, 'episode error');
    if (path !== undefined) out.path = path;
    if (error !== undefined) out.error = error;
    return out;
  });
  const job: Job = {
    id,
    kind: j.kind,
    disc: { key: str(disc.key, 'disc key'), label: str(disc.label, 'disc label'), dir: str(disc.dir, 'disc dir') },
    playlist: str(j.playlist, 'playlist'),
    episodeSpec: str(j.episodeSpec, 'episodeSpec'),
    settings: parseSettings(j.settings),
    outDir,
    noSubtitles: j.noSubtitles === true,
    state: j.state as JobState,
    paused: j.paused === true,
    createdAt: str(j.createdAt, 'createdAt'),
    episodes,
    recordSavedAt: j.recordSavedAt === null || j.recordSavedAt === undefined ? null : str(j.recordSavedAt, 'recordSavedAt'),
    cli: typeof j.cli === 'string' ? j.cli : '',
  };
  if (j.test !== undefined) job.test = parseStoredTest(j.test);
  for (const key of ['startedAt', 'finishedAt', 'error'] as const) {
    const v = optStr(j[key], key);
    if (v !== undefined) job[key] = v;
  }
  return job;
}

/** Checks a stored test plan; throws on anything this runner did not write. */
function parseStoredTest(value: unknown): TestPlan {
  if (typeof value !== 'object' || value === null) throw new Error('job test is not an object');
  const t = value as Record<string, unknown>;
  const num = (v: unknown): number => {
    if (typeof v !== 'number' || !Number.isFinite(v)) throw new Error('job test holds a bad number');
    return v;
  };
  if (!Array.isArray(t.stretches) || !Array.isArray(t.episodeSeconds)) throw new Error('job test lacks its stretches');
  if (t.results !== null && t.results !== undefined && !Array.isArray(t.results)) throw new Error('bad test results');
  const stretches = t.stretches.map((r: unknown) => {
    const range = r as Record<string, unknown> | null;
    if (typeof range !== 'object' || range === null) throw new Error('bad stretch');
    return { startMs: num(range.startMs), endMs: num(range.endMs) };
  });
  const results = Array.isArray(t.results)
    ? t.results.map((r: unknown) => {
        const x = r as Record<string, unknown> | null;
        if (typeof x !== 'object' || x === null || typeof x.id !== 'string') throw new Error('bad test result');
        return { id: x.id, videoBytesPerSecond: num(x.videoBytesPerSecond), audioBytesPerSecond: num(x.audioBytesPerSecond) };
      })
    : null;
  return {
    profiles: parseTestProfiles(t.profiles),
    stretches,
    episodeSeconds: t.episodeSeconds.map(num),
    audioStreams: t.audioStreams === null || t.audioStreams === undefined ? null : num(t.audioStreams),
    results,
  };
}

/**
 * The jobs file, `<dataDir>/jobs.json` (`{ jobs: Job[] }`), written whole and atomically. A missing file is an empty
 * queue; a file that cannot be read or parsed loads as null and is never written over.
 */
export class JobStore {
  private readonly file: string;

  /** The store in the data directory `dataDir` (created on the first write). */
  constructor(private readonly dataDir: string) {
    this.file = join(dataDir, 'jobs.json');
  }

  /** The stored jobs; null (with the reason) when the file is there but unusable. */
  async load(): Promise<{ jobs: Job[] } | { jobs: null; problem: string }> {
    let text: string;
    try {
      text = await readFile(this.file, 'utf8');
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') return { jobs: [] };
      return { jobs: null, problem: message(e) };
    }
    try {
      const parsed = JSON.parse(text) as { jobs?: unknown };
      if (!Array.isArray(parsed.jobs)) throw new Error('no jobs list');
      const jobs = parsed.jobs.map(parseStoredJob);
      if (new Set(jobs.map((j) => j.id)).size !== jobs.length) throw new Error('a job id appears twice');
      return { jobs };
    } catch (e) {
      return { jobs: null, problem: message(e) };
    }
  }

  /** Replaces the file with `jobs`. */
  save(jobs: readonly Job[]): void {
    mkdirSync(this.dataDir, { recursive: true });
    replaceAtomically(this.file, `${JSON.stringify({ jobs }, null, 2)}\n`);
  }
}

/** The job that is running and how to stop it. */
interface Current {
  readonly job: Job;
  readonly controller: AbortController;
  /** Settles once the job has stopped and its state is saved. */
  done: Promise<void>;
}

/**
 * The encode queue of one app. Jobs run one at a time, in the order they were queued, except that a queued test job
 * runs first: a running encode is stopped between two episodes (after the one in progress), marked `paused` and
 * `queued`, and resumes, ahead of the others, at its next episode once the test is over.
 *
 * An encode job runs `encodeEpisodes` once per episode it still needs, with the job's settings (`pgs: false` is
 * `noPgs`, `web: true` writes packages to `<outDir>/web`), its record read once per run, and an `AbortSignal` that a
 * cancel aborts. An episode is done once the runner sees its closing 100% `progress` event or its `episode-done`
 * (with the web package, once `packaged`); a file merely found on disk never counts. A job remembers the `savedAt` of
 * the subtitle record it encoded with; when a later run finds the record saved again since, every episode is encoded
 * again, so one job's episodes never mix two sets of subtitle choices. Every log event and state change is appended to
 * `<data>/jobs/<id>.log`.
 *
 * `events` emits `jobs` (the whole list, after every state change) and `progress` (a `JobProgress`, at most once a
 * second per episode, except that an episode's first report and its closing 100% report are always sent).
 */
export class JobRunner {
  /** `jobs` (Job[]) and `progress` (JobProgress). */
  readonly events = new EventEmitter();
  /** Resolves once `start` has loaded the jobs. */
  ready: Promise<void> = Promise.resolve();
  private jobs: Job[] = [];
  private readonly store: JobStore;
  private readonly deps: JobRunnerDeps;
  private writable = true;
  private loaded = false;
  private stopping = false;
  private active: Promise<void> | null = null;
  private current: Current | null = null;
  /** The pid of the process that runs this data folder's queue instead, when `start` could not take the lock. */
  private elsewhere: number | null = null;
  /** When each episode's last progress report was sent, by `<jobId>:<episode>`. */
  private readonly lastProgress = new Map<string, number>();
  /** When each running episode's encode started, by `<jobId>:<episode>`, for its speed. */
  private readonly episodeStarts = new Map<string, number>();

  /**
   * The runner of `app`, with `deps` replacing the defaults it names. `lock` is the data folder's queue lock when the
   * caller has taken it already; otherwise `start` takes it. Call `start` before anything else.
   */
  constructor(
    private readonly app: AppContext,
    deps: Partial<JobRunnerDeps> = {},
    private lock: JobsLock | null = null,
  ) {
    this.store = new JobStore(app.dataDir);
    this.deps = {
      encode: encodeEpisodes,
      packageEpisode,
      runTest: (job, signal, onEvent) => {
        if (job.test === undefined) return Promise.reject(new Error('The job is not a test.'));
        return runTestEncode({ ...job, test: job.test }, { dataDir: app.dataDir, tools: app.tools }, signal, onEvent);
      },
      now: Date.now,
      log: (m) => console.error(m),
      ...deps,
    };
    this.events.setMaxListeners(100);
  }

  /**
   * Loads `jobs.json`, marks every job that was running as `interrupted` (an episode in progress goes back to `queued`
   * and its `<name>.mkv.partial` in the job's folder is removed; one whose MKV was complete but not packaged becomes
   * `packaging-failed`), removes the sample folder of every test job that is or becomes `interrupted`, and starts the
   * queue. A damaged file leaves the queue empty, is logged, and refuses every
   * change with 500 `jobs-unreadable`.
   *
   * First it takes the data folder's queue lock (`takeJobsLock`) unless it was given one. When another live process
   * holds it, this runner loads nothing and runs nothing: `queueElsewhere` names that process, and every call is
   * refused with 409 `queue-elsewhere`.
   */
  start(): Promise<void> {
    this.ready = (async () => {
      if (this.lock === null) {
        const attempt = takeJobsLock(this.app.dataDir);
        if ('heldBy' in attempt) {
          this.elsewhere = attempt.heldBy;
          this.deps.log(`Another seikou-encode (pid ${attempt.heldBy}) runs the encode queue of ${this.app.dataDir}; this one runs no encodes.`);
          return;
        }
        this.lock = attempt.lock;
      }
      const loaded = await this.store.load();
      if (loaded.jobs === null) {
        this.writable = false;
        this.deps.log(`jobs.json cannot be read (${loaded.problem}); the queue is empty and nothing can be queued until it is fixed or removed.`);
        this.jobs = [];
      } else {
        this.jobs = loaded.jobs;
      }
      for (const job of this.jobs) {
        // A test interrupted by an earlier stop (Ctrl-C saves it as interrupted) loses its samples too: its retry starts over.
        if (job.kind === 'test' && job.state === 'interrupted') await this.removeTestFolder(job);
        if (job.state !== 'running') continue;
        job.state = 'interrupted';
        job.finishedAt = this.iso();
        for (const ep of job.episodes) this.settleStopped(job, ep, 'The app stopped before this episode was packaged.');
        await this.removePartials(job);
        if (job.kind === 'test') await this.removeTestFolder(job);
        this.appendLog(job, 'Interrupted: the app stopped while the job was running.');
      }
      this.loaded = true;
      if (this.jobs.length > 0) this.persist();
      this.pump();
    })();
    return this.ready;
  }

  /** Every job, oldest first. */
  list(): Job[] {
    return this.jobs.map((j) => structuredClone(j));
  }

  /** The job with `id`, or null. */
  get(id: string): Job | null {
    const job = this.jobs.find((j) => j.id === id);
    return job === undefined ? null : structuredClone(job);
  }

  /**
   * Queues a job and resolves with it. Refusals (`JobError`): 400 `bad-request` (a malformed field), 400 `bad-setting`
   * (with `field`), 404 `not-found` (an unknown disc or playlist), 400 `bad-episode-spec`, 400 `output-not-absolute`,
   * 400 `output-not-allowed` (a folder inside a library root, inside the disc, or inside the data directory other than
   * under `<data>/output`), 409 `record-mismatch` (the saved subtitle record is for another episode list or misses an
   * episode; `recordEpisodeSpec` and `episodeSpec` name both lists), 409 `no-audio-chosen`, 409 `subtitle-files-missing`,
   * 409 `record-unreadable`, and 500 `jobs-unreadable`. The record is not checked with `noSubtitles` or for a test job.
   * The output folder is made when missing.
   */
  async add(input: JobInput): Promise<Job> {
    await this.ready;
    this.checkAvailable();
    const kind = input.kind ?? 'encode';
    if (kind !== 'encode' && kind !== 'test') throw new JobError(400, 'bad-request', 'A job kind is "encode" or "test".');
    const { discKey, playlistId, episodeSpec } = input;
    if (typeof discKey !== 'string' || typeof playlistId !== 'string' || typeof episodeSpec !== 'string') {
      throw new JobError(400, 'bad-request', 'A job needs discKey, playlistId and episodeSpec.');
    }
    if (!/^\d{5}$/.test(playlistId)) throw new JobError(400, 'bad-request', 'A playlist id is five digits.');
    const noSubtitles = input.noSubtitles ?? false;
    if (typeof noSubtitles !== 'boolean') throw new JobError(400, 'bad-request', 'noSubtitles must be true or false.');
    let settings: EncodeSettings;
    let profiles: TestPlan['profiles'] = [];
    try {
      if (kind === 'test') {
        profiles = parseTestProfiles(input.profiles);
        settings = profiles[0]!.settings;
      } else {
        settings = parseSettings(input.settings);
      }
    } catch (e) {
      if (e instanceof ProfileError) throw new JobError(e.status, e.code, e.message, e.field === undefined ? {} : { field: e.field });
      if (e instanceof TestInputError) {
        const isSetting = e.field !== undefined && e.field !== 'profiles';
        throw new JobError(400, isSetting ? 'bad-setting' : 'bad-request', e.message, e.field === undefined ? {} : { field: e.field });
      }
      throw e;
    }
    const dir = await sessionsOf(this.app).discDirOf(discKey);
    if (dir === null) throw new JobError(404, 'not-found', 'No disc the app knows has that key.');
    const disc = await discOf(this.app, dir);
    let playlist: Awaited<ReturnType<typeof loadPlaylist>>;
    try {
      playlist = await loadPlaylist(disc.root, playlistId);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') throw new JobError(404, 'not-found', `The disc has no playlist ${playlistId}.`);
      throw e;
    }
    const chapters = playlist.chapters.length;
    let episodeCount: number;
    let test: TestPlan | undefined;
    try {
      episodeCount = parseEpisodeSpec(episodeSpec, chapters).length;
      if (kind === 'test') test = { profiles, ...planTest(playlist, episodeSpec), audioStreams: null, results: null };
    } catch (e) {
      if (e instanceof EpisodeSpecError) throw new JobError(400, 'bad-episode-spec', e.message);
      throw e;
    }
    const id = randomBytes(8).toString('hex');
    let outDir: string;
    if (kind === 'test') {
      outDir = testDirOf(this.app.dataDir, id);
    } else {
      outDir = await this.checkOutputFolder(input.outDir, disc.root);
      if (!noSubtitles) await this.checkRecord(disc.root, disc.key, playlistId, episodeSpec, chapters);
    }
    await mkdir(outDir, { recursive: true });
    if (!this.writable) throw this.unreadable();
    const job: Job = {
      id,
      kind,
      disc: { key: disc.key, label: disc.label, dir: disc.root },
      playlist: playlistId,
      episodeSpec,
      settings,
      outDir,
      noSubtitles,
      state: 'queued',
      paused: false,
      createdAt: this.iso(),
      episodes: Array.from(
        { length: test === undefined ? episodeCount : test.stretches.length * test.profiles.length },
        (_, i): JobEpisode => ({ index: i + 1, state: 'queued', framesDone: 0, frames: 0, encoded: false }),
      ),
      recordSavedAt: null,
      cli: kind === 'test' ? '' : jobCli({ discDir: disc.root, playlistId, episodeSpec, outDir, noSubtitles, settings }),
    };
    if (test !== undefined) job.test = test;
    this.jobs.push(job);
    this.appendLog(job, `Queued: ${test !== undefined ? `test of ${test.profiles.map((p) => p.name).join(', ')}` : job.cli}`);
    this.persist();
    this.pump();
    return structuredClone(job);
  }

  /**
   * Cancels a job: a queued one at once, a running one by aborting its encode and waiting until every tool has exited
   * and its partial file is gone. Resolves with the job. 404 `not-found`; 409 `not-cancellable` for a finished job.
   */
  async cancel(id: string): Promise<Job> {
    await this.ready;
    this.checkElsewhere();
    const job = this.find(id);
    if (this.current?.job === job) {
      this.current.controller.abort();
      await this.current.done;
    } else if (job.state === 'queued') {
      if (!this.writable) throw this.unreadable();
      job.state = 'cancelled';
      job.paused = false;
      job.finishedAt = this.iso();
      this.appendLog(job, 'Cancelled.');
      this.persist();
    } else {
      throw new JobError(409, 'not-cancellable', 'Only a queued or running job can be cancelled.');
    }
    return structuredClone(job);
  }

  /**
   * Queues a failed, interrupted or cancelled job again. It encodes only the episodes not done (an episode whose
   * packaging failed is packaged again from its MKV, not encoded); when the subtitle record was saved again since the
   * job's first run, every episode is encoded again. 404 `not-found`; 409 `not-retryable` for any other state.
   */
  async retry(id: string): Promise<Job> {
    await this.ready;
    this.checkElsewhere();
    const job = this.find(id);
    if (!RETRYABLE.has(job.state)) throw new JobError(409, 'not-retryable', 'Only a failed, interrupted or cancelled job can be retried.');
    if (!this.writable) throw this.unreadable();
    job.state = 'queued';
    job.paused = false;
    delete job.error;
    delete job.finishedAt;
    for (const ep of job.episodes) {
      if (ep.state === 'failed' || ep.state === 'running') this.resetEpisode(ep);
    }
    this.appendLog(job, 'Queued again.');
    this.persist();
    this.pump();
    return structuredClone(job);
  }

  /**
   * Removes a finished job from the queue, and its log; an encode's output files stay, a test's sample folder is
   * deleted. 404 `not-found`; 409 `not-finished`.
   */
  async remove(id: string): Promise<void> {
    await this.ready;
    this.checkElsewhere();
    const job = this.find(id);
    if (!FINISHED.has(job.state)) throw new JobError(409, 'not-finished', 'Cancel the job before removing it.');
    if (!this.writable) throw this.unreadable();
    this.jobs = this.jobs.filter((j) => j !== job);
    this.persist();
    await rm(this.logFile(job.id), { force: true });
    if (job.kind === 'test') await this.removeTestFolder(job);
  }

  /** Deletes a test job's sample folder, `<data>/tests/<id>`, worked out from its id rather than the stored path. */
  private async removeTestFolder(job: Job): Promise<void> {
    await rm(testDirOf(this.app.dataDir, job.id), { recursive: true, force: true });
  }

  /** The last `lines` lines of a job's log (at most `MAX_LOG_TAIL`). 404 `not-found`. */
  async logTail(id: string, lines: number): Promise<string[]> {
    await this.ready;
    this.checkElsewhere();
    const job = this.find(id);
    let text: string;
    try {
      text = await readFile(this.logFile(job.id), 'utf8');
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw e;
    }
    const all = text.split('\n');
    if (all.at(-1) === '') all.pop();
    return all.slice(-Math.min(Math.max(0, lines), MAX_LOG_TAIL));
  }

  /**
   * Stops the runner for the process to exit: no job starts any more, and a running job is aborted, waited for (every
   * tool exited, its partial file removed) and saved as `interrupted`, so it can be retried. Then the queue lock is
   * released.
   */
  async shutdown(): Promise<void> {
    // Set before any await: a tool killed by the same Ctrl-C can fail the encode at any moment from now on.
    this.stopping = true;
    try {
      await this.ready;
      if (this.current !== null) {
        this.current.controller.abort();
        await this.current.done;
      }
      await this.active;
    } finally {
      this.lock?.release();
    }
  }

  /** The job with `id`, or a 404 `JobError`. */
  private find(id: string): Job {
    const job = this.jobs.find((j) => j.id === id);
    if (job === undefined) throw new JobError(404, 'not-found', 'There is no such job.');
    return job;
  }

  /** The pid of the process that runs this data folder's queue instead of this runner, or null when this one runs it. */
  get queueElsewhere(): number | null {
    return this.elsewhere;
  }

  /**
   * The error every call answers while this runner cannot serve the queue: 409 `queue-elsewhere` when another process
   * runs it, 500 `jobs-unreadable` while `jobs.json` cannot be read; null otherwise.
   */
  get unavailableError(): JobError | null {
    if (this.elsewhere !== null) return this.elsewhereError(this.elsewhere);
    return this.writable ? null : this.unreadable();
  }

  private elsewhereError(pid: number): JobError {
    return new JobError(
      409,
      'queue-elsewhere',
      `Another seikou-encode app (pid ${pid}) runs the encode queue of this data folder, so encodes can't be queued or shown here. Use that app's Queue page.`,
    );
  }

  /** Throws `queue-elsewhere` when another process runs the queue. */
  private checkElsewhere(): void {
    if (this.elsewhere !== null) throw this.elsewhereError(this.elsewhere);
  }

  /** Throws the error of `unavailableError`, if any. */
  private checkAvailable(): void {
    const error = this.unavailableError;
    if (error !== null) throw error;
  }

  private unreadable(): JobError {
    return new JobError(500, 'jobs-unreadable', 'jobs.json in the data folder cannot be read, so the queue cannot change. Fix or remove that file.');
  }

  /**
   * The output folder `raw` names, as an absolute path, after checking that it may be written: absolute (400
   * `output-not-absolute`), and not inside a library root, the disc, or the data directory other than `<data>/output`
   * (400 `output-not-allowed`), compared by real paths so a link cannot lead in.
   */
  private async checkOutputFolder(raw: unknown, discRoot: string): Promise<string> {
    if (typeof raw !== 'string' || !isAbsolute(raw)) {
      throw new JobError(400, 'output-not-absolute', 'The output folder must be an absolute path, such as /Users/you/Videos/Starfall.');
    }
    const outDir = resolve(raw);
    const real = await realPathOf(outDir);
    const data = await realPathOf(this.app.dataDir);
    const refuse = (where: string): JobError =>
      new JobError(400, 'output-not-allowed', `The output folder cannot be inside ${where}; pick a folder of its own.`);
    if (within(real, data) && !within(real, join(data, 'output'))) throw refuse('the app\'s data folder (except its "output" folder)');
    if (within(real, await realPathOf(discRoot))) throw refuse('the disc');
    for (const root of await libraryOf(this.app).roots()) {
      if (within(real, await realPathOf(root))) throw refuse('the disc library');
    }
    return outDir;
  }

  /** Checks the saved subtitle record against the job's playlist and episodes, as the encode will. */
  private async checkRecord(discDir: string, discKey: string, playlistId: string, episodeSpec: string, chapters: number): Promise<void> {
    let saved: SubtitleRecord | null;
    try {
      saved = await new RecordStore(this.app.dataDir).read(discKey, playlistId);
    } catch (e) {
      if (e instanceof RecordError) throw new JobError(409, 'record-unreadable', `The saved subtitle choices cannot be read (${e.message}).`);
      throw e;
    }
    if (saved === null) return;
    const mismatch = (text: string): JobError =>
      new JobError(409, 'record-mismatch', text, { recordEpisodeSpec: saved.episodeSpec, episodeSpec });
    if (!sameEpisodeList(saved.episodeSpec, episodeSpec, chapters)) {
      throw mismatch(`The saved subtitle choices are for episodes ${saved.episodeSpec}; this job asks for ${episodeSpec}.`);
    }
    try {
      await loadEncodeRecord({ discDir, playlistId, episodeSpec, dataDir: this.app.dataDir, noSubtitles: false });
    } catch (e) {
      if (e instanceof RecordMismatchError) throw mismatch(e.message);
      if (e instanceof NoAudioChosenError) throw new JobError(409, 'no-audio-chosen', e.message);
      if (e instanceof MissingSubtitleFilesError) throw new JobError(409, 'subtitle-files-missing', e.message);
      if (e instanceof RecordError) throw new JobError(409, 'record-unreadable', e.message);
      throw e;
    }
  }

  private iso(): string {
    return new Date(this.deps.now()).toISOString();
  }

  private logFile(id: string): string {
    return join(this.app.dataDir, 'jobs', `${id}.log`);
  }

  /** Appends one line to the job's log; a log that cannot be written is reported, never fatal. */
  private appendLog(job: Job, text: string): void {
    try {
      mkdirSync(join(this.app.dataDir, 'jobs'), { recursive: true });
      appendFileSync(this.logFile(job.id), `${this.iso()} ${text.replaceAll('\n', ' ')}\n`);
    } catch (e) {
      this.deps.log(`The log of job ${job.id} cannot be written: ${message(e)}`);
    }
  }

  /** Saves the queue and tells listeners; a failed save is reported, never fatal. */
  private persist(): void {
    if (this.writable) {
      try {
        this.store.save(this.jobs);
      } catch (e) {
        this.deps.log(`jobs.json cannot be written: ${message(e)}`);
      }
    }
    this.events.emit('jobs', this.list());
  }

  private resetEpisode(ep: JobEpisode): void {
    ep.state = 'queued';
    ep.framesDone = 0;
    ep.encoded = false;
    delete ep.error;
  }

  /** The state of an episode that was running when its job stopped. */
  private settleStopped(job: Job, ep: JobEpisode, unpackaged: string): void {
    if (ep.state !== 'running') return;
    if (ep.encoded && job.settings.web) {
      ep.state = 'packaging-failed';
      ep.error = unpackaged;
    } else if (ep.encoded) {
      ep.state = 'done';
    } else {
      this.resetEpisode(ep);
    }
  }

  /** Removes `<name>.mkv.partial` of each of the job's episodes from its own folder; nothing else. */
  private async removePartials(job: Job): Promise<void> {
    if (job.kind !== 'encode') return;
    for (const ep of job.episodes) {
      if (ep.state === 'done') continue;
      await unlink(join(job.outDir, `${episodeName(job.settings.namePattern, ep.index)}.mkv.partial`)).catch(() => undefined);
    }
  }

  /** The next job to run: a queued test, else a paused job, else the oldest queued job. */
  private pickNext(): Job | null {
    const queued = this.jobs.filter((j) => j.state === 'queued');
    return queued.find((j) => j.kind === 'test') ?? queued.find((j) => j.paused) ?? queued[0] ?? null;
  }

  /** Runs queued jobs one after another until none is left; does nothing while it already runs. */
  private pump(): void {
    if (this.active !== null || this.stopping || !this.loaded) return;
    this.active = (async () => {
      // Yield first: a body that ended synchronously would clear `active` before it was set.
      await Promise.resolve();
      try {
        for (;;) {
          if (this.stopping) break;
          const next = this.pickNext();
          if (next === null) break;
          await this.runJob(next);
        }
      } finally {
        this.active = null;
      }
    })();
  }

  /** Runs one job to its end, a pause or a stop; never rejects. */
  private runJob(job: Job): Promise<void> {
    const controller = new AbortController();
    const current: Current = { job, controller, done: Promise.resolve() };
    this.current = current;
    current.done = (async () => {
      const firstRun = job.startedAt === undefined;
      job.state = 'running';
      job.paused = false;
      job.startedAt ??= this.iso();
      delete job.error;
      delete job.finishedAt;
      this.appendLog(job, 'State: running.');
      this.persist();
      try {
        if (job.kind === 'test') {
          await this.runTestJob(job, controller.signal);
        } else if ((await this.runEncode(job, controller.signal, firstRun)) === 'paused') {
          job.state = 'queued';
          job.paused = true;
          this.appendLog(job, 'Paused for a test encode; resumes at the next episode.');
          return;
        }
        job.state = 'done';
        job.finishedAt = this.iso();
        this.appendLog(job, 'State: done.');
      } catch (e) {
        for (const ep of job.episodes) this.settleStopped(job, ep, 'The job stopped before this episode was packaged.');
        await this.removePartials(job);
        job.finishedAt = this.iso();
        // While the runner stops, any failure is the stop's doing: Ctrl-C reaches the tools too, and may fail them
        // before the runner aborts the encode.
        if (controller.signal.aborted || this.stopping) {
          job.state = this.stopping ? 'interrupted' : 'cancelled';
          this.appendLog(job, `State: ${job.state}.`);
        } else {
          job.state = 'failed';
          job.error = message(e);
          this.appendLog(job, `State: failed: ${job.error}`);
        }
      } finally {
        this.current = null;
        this.persist();
      }
    })();
    return current.done;
  }

  /** Runs a test job from scratch: an empty sample folder, every unit waiting, no results; then stores what it measured. */
  private async runTestJob(job: Job, signal: AbortSignal): Promise<void> {
    await this.removeTestFolder(job);
    await mkdir(testDirOf(this.app.dataDir, job.id), { recursive: true });
    for (const ep of job.episodes) {
      this.resetEpisode(ep);
      ep.frames = 0;
      delete ep.path;
    }
    if (job.test !== undefined) {
      job.test.results = null;
      job.test.audioStreams = null;
    }
    this.persist();
    const outcome = await this.deps.runTest(structuredClone(job), signal, (e) => this.onEvent(job, e));
    if (job.test !== undefined) {
      job.test.audioStreams = outcome.audioStreams;
      job.test.results = outcome.results;
    }
  }

  /** Encodes the episodes a job still needs, one per call; 'paused' when it stopped early for a test job. */
  private async runEncode(job: Job, signal: AbortSignal, firstRun: boolean): Promise<'paused' | void> {
    const tools = this.app.tools;
    if (tools === null) throw new Error('The encoding tools (vspipe with BestSource, SvtAv1EncApp and opusenc) were not found when the app started.');
    const record = job.noSubtitles
      ? null
      : await loadEncodeRecord({ discDir: job.disc.dir, playlistId: job.playlist, episodeSpec: job.episodeSpec, dataDir: this.app.dataDir, noSubtitles: false });
    const savedAt = record?.savedAt ?? null;
    if (!firstRun && savedAt !== job.recordSavedAt) {
      for (const ep of job.episodes) this.resetEpisode(ep);
      this.appendLog(job, 'The subtitle choices were saved again since the last run, so every episode is encoded again.');
    }
    job.recordSavedAt = savedAt;
    for (const ep of job.episodes) {
      if (ep.state === 'done') continue;
      if (signal.aborted) throw new DOMException('The job was cancelled', 'AbortError');
      if (this.jobs.some((j) => j.kind === 'test' && j.state === 'queued')) return 'paused';
      if (ep.state === 'packaging-failed') await this.repackage(job, ep);
      else await this.encodeEpisode(job, ep, record, tools, signal);
    }
  }

  private async encodeEpisode(job: Job, ep: JobEpisode, record: SubtitleRecord | null, tools: NonNullable<AppContext['tools']>, signal: AbortSignal): Promise<void> {
    this.resetEpisode(ep);
    ep.state = 'running';
    this.appendLog(job, `Episode ${ep.index}: encoding.`);
    this.persist();
    const s = job.settings;
    const key = `${job.id}:${ep.index}`;
    this.episodeStarts.set(key, this.deps.now());
    try {
      await this.deps.encode(
        {
          discDir: job.disc.dir,
          playlistId: job.playlist,
          episodes: job.episodeSpec,
          outDir: job.outDir,
          namePattern: s.namePattern,
          crf: s.crf,
          preset: s.preset,
          filmGrain: s.filmGrain,
          extraSvtArgs: [...s.extraSvtArgs],
          opusBitrate: s.opusBitrate ?? undefined,
          cacheDir: join(this.app.dataDir, 'bestsource'),
          tools,
          dataDir: this.app.dataDir,
          noSubtitles: job.noSubtitles,
          record,
          noPgs: !s.pgs,
          webDir: s.web ? webDirOf(job.outDir) : undefined,
          signal,
          onlyEpisodes: [ep.index],
        },
        (e) => this.onEvent(job, e),
      );
    } catch (e) {
      if (ep.state === 'running' && !ep.encoded && !signal.aborted && !this.stopping) {
        ep.state = 'failed';
        ep.error = message(e);
      }
      throw e;
    } finally {
      this.episodeStarts.delete(key);
      this.lastProgress.delete(key);
    }
    // The encode resolved, so the episode is complete even if its closing events were not seen.
    if (ep.state === 'running') this.markDone(job, ep, this.mkvPath(job, ep));
  }

  /** Packages an episode's finished MKV again; the episode is encoded only once. */
  private async repackage(job: Job, ep: JobEpisode): Promise<void> {
    const mkv = ep.path ?? this.mkvPath(job, ep);
    const out = join(webDirOf(job.outDir), episodeName(job.settings.namePattern, ep.index));
    ep.state = 'running';
    this.appendLog(job, `Episode ${ep.index}: packaging ${mkv} again.`);
    this.persist();
    try {
      await this.deps.packageEpisode(mkv, out);
    } catch (e) {
      ep.state = 'packaging-failed';
      ep.error = message(e);
      throw e;
    }
    this.appendLog(job, `Episode ${ep.index}: packaged into ${out}.`);
    this.markDone(job, ep, mkv);
  }

  private mkvPath(job: Job, ep: JobEpisode): string {
    return join(job.outDir, `${episodeName(job.settings.namePattern, ep.index)}.mkv`);
  }

  private markDone(job: Job, ep: JobEpisode, path: string): void {
    ep.state = 'done';
    ep.encoded = true;
    ep.path = path;
    delete ep.error;
    this.appendLog(job, `Episode ${ep.index}: done.`);
    this.persist();
  }

  /** Follows one event of a running encode or test. */
  private onEvent(job: Job, e: EncodeEvent): void {
    const ep = job.episodes.find((x) => x.index === e.episode);
    switch (e.kind) {
      case 'log':
        this.appendLog(job, e.episode > 0 ? `${job.kind === 'test' ? 'Sample encode' : 'Episode'} ${e.episode}: ${e.message}` : e.message);
        return;
      case 'episode-start':
        if (ep && e.path !== undefined) ep.path = e.path;
        if (ep && job.kind === 'test') {
          // A test's units start only here: the runner does not call the encoder for each of them itself.
          this.resetEpisode(ep);
          ep.state = 'running';
          this.persist();
        }
        this.appendLog(job, e.message);
        return;
      case 'progress':
        this.onProgress(job, ep, e);
        return;
      case 'episode-done':
        if (ep && ep.state !== 'done') this.markDone(job, ep, e.path ?? this.mkvPath(job, ep));
        return;
      case 'packaged':
        this.appendLog(job, `Episode ${e.episode}: packaged into ${e.path ?? ''}.`);
        if (ep && ep.state !== 'done') this.markDone(job, ep, ep.path ?? this.mkvPath(job, ep));
        return;
      case 'package-failed':
        this.appendLog(job, `Episode ${e.episode}: packaging failed: ${e.message}`);
        if (ep) {
          ep.state = 'packaging-failed';
          ep.error = e.message;
          this.persist();
        }
        return;
    }
  }

  private onProgress(job: Job, ep: JobEpisode | undefined, e: EncodeEvent): void {
    const framesDone = e.framesDone ?? 0;
    const frames = e.frames ?? 0;
    const now = this.deps.now();
    const key = `${job.id}:${e.episode}`;
    if (!this.episodeStarts.has(key)) this.episodeStarts.set(key, now);
    if (ep) {
      ep.framesDone = framesDone;
      ep.frames = frames;
      // A test's sample is done only once it is packaged, which its `episode-done` says.
      if (frames > 0 && framesDone >= frames && !ep.encoded && job.kind === 'encode') {
        // The closing event comes after the rename: the MKV is complete.
        ep.encoded = true;
        ep.path ??= this.mkvPath(job, ep);
        if (job.settings.web) {
          this.appendLog(job, `Episode ${ep.index}: encoded; packaging.`);
          this.persist();
        } else {
          this.markDone(job, ep, ep.path);
        }
      }
    }
    // Paced per episode; an episode's first report and its closing 100% always go out.
    const complete = frames > 0 && framesDone >= frames;
    const last = this.lastProgress.get(key);
    if (last !== undefined && !complete && now - last < PROGRESS_INTERVAL_MS) return;
    if (complete) this.lastProgress.delete(key);
    else this.lastProgress.set(key, now);
    const elapsed = (now - this.episodeStarts.get(key)!) / 1000;
    const fps = elapsed > 0 ? framesDone / elapsed : null;
    const etaSeconds = fps !== null && fps > 0 ? Math.round((frames - framesDone) / fps) : null;
    const progress: JobProgress = { jobId: job.id, episode: e.episode, framesDone, frames, fps, etaSeconds };
    this.events.emit('progress', progress);
  }
}

const runners = new WeakMap<AppContext, JobRunner>();

/**
 * Makes the job runner of `app` with `deps`, starts it (see `JobRunner.start`) and keeps it as the app's runner.
 * `lock` is the data folder's queue lock when the caller took it already.
 */
export function startJobRunner(app: AppContext, deps: Partial<JobRunnerDeps> = {}, lock: JobsLock | null = null): JobRunner {
  const runner = new JobRunner(app, deps, lock);
  runners.set(app, runner);
  void runner.start();
  return runner;
}

/** The job runner of `app`: the one `startJobRunner` made, else a new one with the default tools, started now. */
export function jobRunnerOf(app: AppContext): JobRunner {
  return runners.get(app) ?? startJobRunner(app);
}
