// SPDX-License-Identifier: LGPL-3.0-or-later
import { randomBytes } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { appendFileSync, mkdirSync } from 'node:fs';
import { readFile, realpath, rm, stat, unlink, mkdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, dirname, isAbsolute, join, resolve, sep } from 'node:path';
import { replaceAtomically } from '@seikou/titles';
import { loadPlaylist } from '../disc/playlist';
import { NasError, type NasClient } from '../nas/client';
import { aniListPairs, checkNasDestination, NasDestinationError, uploadNameOf, type AniListPair } from '../nas/destination';
import { ClipFetcher, clipsOfEpisode, releaseHolder, sweepUnheld } from '../nas/fetch';
import { defaultSleep, FetchError, isMirror } from '../nas/mirror';
import { abandonUpload, UPLOAD_CHUNK_BYTES, uploadEpisode, UploadError, type UploadState } from '../nas/upload';
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

/**
 * Where one episode of a job is. `packaging-failed`: the MKV is complete but the web package is not.
 * `upload-failed`: the MKV is complete and kept, but the NAS has not taken it; a retry uploads it again.
 */
export type EpisodeState = 'queued' | 'running' | 'done' | 'packaging-failed' | 'upload-failed' | 'failed';

/** What a running episode is doing: fetching its clips from the NAS, encoding, or uploading to the NAS. */
export type EpisodeStep = 'fetching' | 'encoding' | 'uploading';

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
  /** What the running episode is doing; null otherwise. */
  step: EpisodeStep | null;
  /** Bytes fetched or uploaded so far in the current step (0 while encoding). */
  stepDone: number;
  /** Bytes the current fetch or upload moves in all; 0 until known, and while encoding. */
  stepTotal: number;
  /** A NAS episode's upload, kept so a retry resumes it; gone once the NAS has filed the episode. */
  upload?: UploadState;
  /** The NAS's id of the uploaded episode (`<anilistId>-<episode>`). */
  encodeId?: string;
}

/** One queued encode or test, as `jobs.json` keeps it and the job routes answer it. */
export interface Job {
  /** 16 lower-case hex digits. */
  readonly id: string;
  /** What the job does. */
  readonly kind: JobKind;
  /**
   * The disc: its key, its folder's name and the real path of the folder holding BDMV. A retry moves `dir` to where the
   * disc is found by its key when the folder no longer holds the disc.
   */
  disc: { readonly key: string; readonly label: string; readonly dir: string };
  /** Five-digit playlist name. */
  readonly playlist: string;
  /** The episode list as it was given. */
  readonly episodeSpec: string;
  /** The job's own copy of the settings it was queued with. */
  readonly settings: EncodeSettings;
  /** The absolute folder the episodes are written to (for a test, `<data>/tests/<id>`; for the NAS, `<data>/nas-out/<id>`). */
  readonly outDir: string;
  /** Whether the encode leaves the saved subtitle record out. */
  readonly noSubtitles: boolean;
  /** Where the job is. */
  state: JobState;
  /** `Waiting for the NAS` while a step waits for the NAS to answer again (tried every minute); null otherwise. */
  waiting: string | null;
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
  cli: string;
  /** A test job's profiles, stretches, episode lengths and, once it is done, its measurements; absent on an encode job. */
  test?: TestPlan;
}

/**
 * A job as `JobRunner.add` answers it. `warning: 'replaces-files'` says the job re-encodes the same disc, playlist and
 * episodes into a folder where another job wrote (or will write) the same file names, so its files replace those.
 */
export type QueuedJob = Job & { readonly warning?: 'replaces-files' };

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
  /** How long a step waits before trying the NAS again after it stopped answering. Default 60 s. */
  readonly nasRetryMs: number;
  /** The waits between one NAS request's own retries (1, 2, 4 and 8 s). Default the timer. */
  readonly nasSleep: (ms: number) => Promise<void>;
  /** Bytes per upload request. Default `UPLOAD_CHUNK_BYTES` (8 MiB). */
  readonly uploadChunkBytes: number;
}

/** What a job shows while it waits for the NAS. */
export const WAITING_FOR_NAS = 'Waiting for the NAS';
/** Why a NAS job fails when the app was unpaired or the NAS no longer knows it. */
const UNPAIRED = 'This app is no longer paired with the NAS; pair again and retry.';

const PROGRESS_INTERVAL_MS = 1000;
/** The most lines the log route answers. */
export const MAX_LOG_TAIL = 2000;

const FINISHED: ReadonlySet<JobState> = new Set(['done', 'failed', 'interrupted', 'cancelled']);
const RETRYABLE: ReadonlySet<JobState> = new Set(['failed', 'interrupted', 'cancelled']);
const JOB_STATES: ReadonlySet<string> = new Set(['queued', 'running', ...FINISHED]);
const EPISODE_STATES: ReadonlySet<string> = new Set(['queued', 'running', 'done', 'packaging-failed', 'upload-failed', 'failed']);
const EPISODE_STEPS: ReadonlySet<string> = new Set(['fetching', 'encoding', 'uploading']);

const message = (e: unknown): string => (e instanceof Error ? e.message : String(e));

/** A refusal of the NAS checks as the 409 the queue answers; anything else as it is. */
function asJobError(e: unknown): unknown {
  if (!(e instanceof NasDestinationError)) return e;
  return new JobError(409, e.code, e.message, e.episodes === undefined ? {} : { episodes: [...e.episodes] });
}

/** `sameEpisodeList`, with a list that no longer fits the playlist counted as different. */
function sameListOrFalse(a: string, b: string, chapters: number): boolean {
  try {
    return sameEpisodeList(a, b, chapters);
  } catch {
    return false;
  }
}

/** `text` as one POSIX shell word: as it is when it holds only safe characters, else in single quotes. */
function shellWord(text: string): string {
  if (/^[A-Za-z0-9_/.,:=+@%-]+$/.test(text)) return text;
  return `'${text.replaceAll("'", `'\\''`)}'`;
}

/**
 * The `seikou-encode encode …` command that encodes what a job with these values does: the disc folder (`nas:<key>`
 * for a NAS disc, given its key as `nasKey`), playlist, episode list and output folder (`--nas` instead for the NAS
 * destination), then the name pattern, CRF, preset and film grain, and the flags the other settings imply
 * (`--svt-args`, `--opus-bitrate`, `--no-subtitles`, `--no-pgs`, `--web <outDir>/web`). Every word is quoted for a
 * POSIX shell, so the command can be pasted.
 */
export function jobCli(o: {
  discDir: string;
  nasKey?: string | null;
  playlistId: string;
  episodeSpec: string;
  outDir: string;
  noSubtitles: boolean;
  settings: EncodeSettings;
}): string {
  const s = o.settings;
  const nas = s.destination === 'nas';
  const disc = o.nasKey ? `nas:${o.nasKey}` : o.discDir;
  const words = ['seikou-encode', 'encode', disc, '--playlist', o.playlistId, '--episodes', o.episodeSpec, ...(nas ? ['--nas'] : ['--out', o.outDir])];
  words.push('--name', s.namePattern, '--crf', String(s.crf), '--preset', String(s.preset), '--film-grain', String(s.filmGrain));
  if (s.extraSvtArgs.length > 0) words.push('--svt-args', s.extraSvtArgs.join(' '));
  if (s.opusBitrate !== null) words.push('--opus-bitrate', String(s.opusBitrate));
  if (o.noSubtitles) words.push('--no-subtitles');
  if (!s.pgs) words.push('--no-pgs');
  if (s.web && !nas) words.push('--web', webDirOf(o.outDir));
  return words.map(shellWord).join(' ');
}

/** The folder a NAS job's episodes are written to until the NAS has them: `<data>/nas-out/<jobId>`. */
export function nasOutDirOf(dataDir: string, jobId: string): string {
  return join(dataDir, 'nas-out', jobId);
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

/** How many episode numbers two name patterns are compared over. */
const NAME_CHECK_EPISODES = 99;

/**
 * Whether two name patterns can give the same file name: the same pattern does, and different ones are compared over
 * episodes 1 to 99, ignoring case, since a case-insensitive disk (the default on macOS) takes `EP-01` and `ep-01` for
 * one file.
 */
export function namesCollide(a: string, b: string): boolean {
  if (a === b) return true;
  const names = new Set<string>();
  for (let n = 1; n <= NAME_CHECK_EPISODES; n++) names.add(episodeName(a, n).toLowerCase());
  for (let n = 1; n <= NAME_CHECK_EPISODES; n++) if (names.has(episodeName(b, n).toLowerCase())) return true;
  return false;
}

/** Whether `dir` holds a disc: a `BDMV/index.bdmv` file. */
async function holdsDisc(dir: string): Promise<boolean> {
  try {
    return (await stat(join(dir, 'BDMV', 'index.bdmv'))).isFile();
  } catch {
    return false;
  }
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
    // Jobs written before the NAS destination have no step, step bytes, upload or encode id.
    const step = ep.step === undefined || ep.step === null ? null : str(ep.step, 'episode step');
    if (step !== null && !EPISODE_STEPS.has(step)) throw new Error('bad episode step');
    const count = (v: unknown, name: string): number => {
      if (v === undefined) return 0;
      if (typeof v !== 'number' || !Number.isSafeInteger(v) || v < 0) throw new Error(`bad episode ${name}`);
      return v;
    };
    const out: JobEpisode = {
      index: ep.index,
      state: ep.state as EpisodeState,
      framesDone: ep.framesDone,
      frames: ep.frames,
      encoded: ep.encoded === true,
      step: step as EpisodeStep | null,
      stepDone: count(ep.stepDone, 'stepDone'),
      stepTotal: count(ep.stepTotal, 'stepTotal'),
    };
    const path = optStr(ep.path, 'episode path');
    const error = optStr(ep.error, 'episode error');
    const encodeId = optStr(ep.encodeId, 'episode encodeId');
    if (path !== undefined) out.path = path;
    if (error !== undefined) out.error = error;
    if (encodeId !== undefined) out.encodeId = encodeId;
    if (ep.upload !== undefined) out.upload = parseUploadState(ep.upload);
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
    waiting: j.waiting === undefined || j.waiting === null ? null : str(j.waiting, 'waiting'),
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

/** Checks a stored upload state; throws on anything this runner did not write. */
function parseUploadState(value: unknown): UploadState {
  if (typeof value !== 'object' || value === null) throw new Error('episode upload is not an object');
  const u = value as Record<string, unknown>;
  const id = u.id === null ? null : typeof u.id === 'string' && /^[0-9a-f]{16}$/.test(u.id) ? u.id : undefined;
  const sha256 = u.sha256 === null ? null : typeof u.sha256 === 'string' && /^[0-9a-f]{64}$/.test(u.sha256) ? u.sha256 : undefined;
  const whole = (v: unknown): v is number => typeof v === 'number' && Number.isSafeInteger(v) && v >= 0;
  if (id === undefined || sha256 === undefined || !whole(u.size) || !whole(u.sent)) throw new Error('bad episode upload');
  return { id, sha256, size: u.size, sent: u.sent };
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

/**
 * How many encode jobs in `dataDir`'s queue are queued or interrupted and will read the subtitle record of `discKey`'s
 * playlist `playlistId` for the episode list `episodeSpec` (written any way that cuts its `chapters` the same). Such a
 * job stops with a record mismatch once that record is replaced by one for another list. Read from `jobs.json`, so it
 * counts the queue whichever process runs it; an unreadable file counts none.
 */
export async function jobsUsingRecord(dataDir: string, discKey: string, playlistId: string, episodeSpec: string, chapters: number): Promise<number> {
  const loaded = await new JobStore(dataDir).load();
  if (loaded.jobs === null) return 0;
  return loaded.jobs.filter(
    (j) =>
      j.kind === 'encode' &&
      !j.noSubtitles &&
      (j.state === 'queued' || j.state === 'interrupted') &&
      j.disc.key === discKey &&
      j.playlist === playlistId &&
      sameListOrFalse(j.episodeSpec, episodeSpec, chapters),
  ).length;
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
      nasRetryMs: 60_000,
      nasSleep: defaultSleep,
      uploadChunkBytes: UPLOAD_CHUNK_BYTES,
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
        job.waiting = null;
        // A test interrupted by an earlier stop (Ctrl-C saves it as interrupted) loses its samples too: its retry starts over.
        if (job.kind === 'test' && job.state === 'interrupted') await this.removeTestFolder(job);
        if (job.state !== 'running') continue;
        job.state = 'interrupted';
        job.finishedAt = this.iso();
        for (const ep of job.episodes) this.settleStopped(job, ep, 'The app stopped');
        await this.removePartials(job);
        if (job.kind === 'test') await this.removeTestFolder(job);
        this.appendLog(job, 'Interrupted: the app stopped while the job was running.');
      }
      // Holders live in memory, so after a start no clip of a NAS disc is held: each goes back to its head.
      await sweepUnheld(this.app.dataDir).catch((e: unknown) => this.deps.log(`The fetched NAS clips could not be emptied: ${message(e)}`));
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
   * under `<data>/output`), 409 `output-in-use` (another job in the queue, finished or not, has the same output folder,
   * compared by real paths, and a name pattern that can make the same file names; `suggestedOutDir` names a free
   * folder), 409 `record-mismatch` (the saved subtitle record is for another episode list or misses an
   * episode; `recordEpisodeSpec` and `episodeSpec` name both lists), 409 `no-audio-chosen`, 409 `subtitle-files-missing`,
   * 409 `record-unreadable`, and 500 `jobs-unreadable`. The record is not checked with `noSubtitles` or for a test job.
   * The output folder is made when missing. With `settings.destination: 'nas'` the output folder is ignored (the job
   * writes to `<data>/nas-out/<id>`), `web` is turned off, and the NAS checks apply (see `checkNasDestination`): 409
   * `nas-not-paired`, `nas-needs-anilist` and `nas-duplicate-episodes` (each with `episodes`), `nas-encodes-off` and
   * `info-unreadable`. A disc that is a NAS mirror needs the pairing too (409 `nas-not-paired`), and a test of one is
   * refused with 409 `nas-test-unsupported`. A job for the same disc, playlist and episode list as the job whose folder
   * and names it shares is a re-encode, not a refusal: it is queued and answered with `warning: 'replaces-files'`.
   */
  async add(input: JobInput): Promise<QueuedJob> {
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
    const onNas = await isMirror(disc.root);
    if (onNas && kind === 'test') throw new JobError(409, 'nas-test-unsupported', 'Test encodes need the disc on this Mac.');
    const toNas = kind === 'encode' && settings.destination === 'nas';
    // The web package is for a folder; the NAS's Encodes library plays the MKV itself.
    if (toNas) settings = { ...settings, web: false };
    if ((onNas || toNas) && this.app.nas.client === null) {
      throw new JobError(409, 'nas-not-paired', 'This app is not paired with a NAS. Pair it in Settings first.');
    }
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
    if (toNas) await this.checkNasDestination(disc.key, playlistId, episodeSpec, chapters);
    const id = randomBytes(8).toString('hex');
    let outDir: string;
    let warning: QueuedJob['warning'];
    if (kind === 'test') {
      outDir = testDirOf(this.app.dataDir, id);
    } else if (toNas) {
      outDir = nasOutDirOf(this.app.dataDir, id);
      if (!noSubtitles) await this.checkRecord(disc.root, disc.key, playlistId, episodeSpec, chapters);
    } else {
      outDir = await this.checkOutputFolder(input.outDir, disc.root);
      warning = await this.checkOutputInUse({ outDir, discKey: disc.key, playlistId, episodeSpec, chapters, namePattern: settings.namePattern });
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
      waiting: null,
      paused: false,
      createdAt: this.iso(),
      episodes: Array.from(
        { length: test === undefined ? episodeCount : test.stretches.length * test.profiles.length },
        (_, i): JobEpisode => ({ index: i + 1, state: 'queued', framesDone: 0, frames: 0, encoded: false, step: null, stepDone: 0, stepTotal: 0 }),
      ),
      recordSavedAt: null,
      cli: kind === 'test' ? '' : jobCli({ discDir: disc.root, nasKey: onNas ? disc.key : null, playlistId, episodeSpec, outDir, noSubtitles, settings }),
    };
    if (test !== undefined) job.test = test;
    this.jobs.push(job);
    this.appendLog(job, `Queued: ${test !== undefined ? `test of ${test.profiles.map((p) => p.name).join(', ')}` : job.cli}`);
    if (warning === 'replaces-files') this.appendLog(job, `Its files replace those of an earlier encode of the same episodes in ${outDir}.`);
    this.persist();
    this.pump();
    const answer = structuredClone(job);
    return warning === undefined ? answer : { ...answer, warning };
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
      // a job paused for a test kept its clips for its next episode
      await this.releaseClips(job);
      this.persist();
    } else {
      throw new JobError(409, 'not-cancellable', 'Only a queued or running job can be cancelled.');
    }
    return structuredClone(job);
  }

  /**
   * Queues a failed, interrupted or cancelled job again. It encodes only the episodes not done (an episode whose
   * packaging failed is packaged again from its MKV, not encoded, and one whose upload failed is uploaded again,
   * resuming the NAS's upload when it still has it); when the subtitle record was saved again since the
   * job's first run, every episode is encoded again. When the job's disc folder no longer holds `BDMV/index.bdmv`, the
   * disc is looked up again by its key (in the helper sessions and the library, waiting for a running scan); found, the
   * job's folder and command move there; not found, the retry is refused with 409 `disc-missing`. 404 `not-found`; 409
   * `not-retryable` for any other state.
   */
  async retry(id: string): Promise<Job> {
    await this.ready;
    this.checkElsewhere();
    const job = this.find(id);
    if (!RETRYABLE.has(job.state)) throw new JobError(409, 'not-retryable', 'Only a failed, interrupted or cancelled job can be retried.');
    if (!this.writable) throw this.unreadable();
    await this.findMovedDisc(job);
    job.state = 'queued';
    job.paused = false;
    job.waiting = null;
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
   * deleted, and so is a NAS job's `<data>/nas-out/<id>` (with any episode the NAS never took), whose open uploads on
   * the NAS are dropped too, best effort. 404 `not-found`; 409
   * `not-finished`.
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
    if (this.toNas(job)) {
      await rm(nasOutDirOf(this.app.dataDir, job.id), { recursive: true, force: true });
      // the uploads the job leaves open on the NAS, dropped there; a NAS that does not answer drops them after 24 hours
      const client = this.app.nas.client;
      const open = job.episodes.flatMap((ep) => (ep.upload?.id ? [ep.upload.id] : []));
      if (client !== null) await Promise.all(open.map((uploadId) => abandonUpload(client, uploadId)));
    }
  }

  /**
   * Points `job` at its disc's folder again when the folder it was queued from no longer holds the disc: the folder the
   * helper sessions or the library know for its key now, or the NAS disc's mirror (made again). Throws 409 `disc-missing` when neither knows one.
   */
  private async findMovedDisc(job: Job): Promise<void> {
    if (await holdsDisc(job.disc.dir)) return;
    const sessions = sessionsOf(this.app);
    // Tried in order, each only when the one before found no folder holding the disc: a session's or the library's
    // folder (`discDirOf`, which asks the NAS only when neither knows the key), the library's own, then the NAS disc's
    // mirror made again. A NAS that fails counts as not having it.
    const nasMiss = (e: unknown): null => {
      if (e instanceof FetchError || e instanceof NasError) return null;
      throw e;
    };
    const lookups: (() => Promise<string | null>)[] = [
      () => sessions.discDirOf(job.disc.key).catch(nasMiss),
      () => Promise.resolve(libraryOf(this.app).dirOf(job.disc.key)),
      () => sessions.mirrorDirFor(job.disc.key).catch(nasMiss),
    ];
    let found: string | null = null;
    for (const lookup of lookups) {
      const dir = await lookup();
      if (dir !== null && (await holdsDisc(dir))) {
        found = dir;
        break;
      }
    }
    if (found === null) {
      throw new JobError(409, 'disc-missing', `The disc for this job isn't at ${job.disc.dir} any more and isn't in the library; rescan or queue it again.`);
    }
    const from = job.disc.dir;
    job.disc = { ...job.disc, dir: found };
    if (job.kind === 'encode') {
      const nasKey = (await isMirror(found)) ? job.disc.key : null;
      job.cli = jobCli({ discDir: found, nasKey, playlistId: job.playlist, episodeSpec: job.episodeSpec, outDir: job.outDir, noSubtitles: job.noSubtitles, settings: job.settings });
    }
    this.appendLog(job, `The disc is now at ${found} (it was at ${from}).`);
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

  /**
   * What stopping the runner now waits for: `the fetch of episode <n> from the NAS` and `the upload of episode <n> to
   * the NAS` during those steps, `packaging episode <n>` while an episode's web package is made, `the tool chain` while
   * the encoding tools run, and null when no job runs.
   */
  waitingFor(): string | null {
    const job = this.current?.job;
    if (job === undefined) return null;
    const ep = job.episodes.find((e) => e.state === 'running');
    if (ep?.step === 'fetching') return `the fetch of episode ${ep.index} from the NAS`;
    if (ep?.step === 'uploading') return `the upload of episode ${ep.index} to the NAS`;
    if (job.kind === 'encode' && ep !== undefined && ep.encoded && job.settings.web) return `packaging episode ${ep.index}`;
    return 'the tool chain';
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
   * `output-not-absolute`); not inside a library root, the disc, or the data directory other than `<data>/output`; and
   * not a folder that is or holds a library root, the disc, the data directory or the user's home folder (400
   * `output-not-allowed`, its message naming which), compared by real paths so a link cannot lead in.
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
    const holding = (what: string): JobError =>
      new JobError(400, 'output-not-allowed', `The output folder cannot be or hold ${what}; pick a folder of its own.`);
    if (within(data, real)) throw holding(`the app's data folder (${data})`);
    if (within(real, data) && !within(real, join(data, 'output'))) throw refuse('the app\'s data folder (except its "output" folder)');
    const disc = await realPathOf(discRoot);
    if (within(real, disc)) throw refuse('the disc');
    for (const root of await libraryOf(this.app).roots()) {
      const realRoot = await realPathOf(root);
      if (within(realRoot, real)) throw holding(`the disc library folder ${realRoot}`);
      if (within(real, realRoot)) throw refuse('the disc library');
    }
    const home = await realPathOf(homedir());
    if (within(home, real)) throw holding(`your home folder (${home})`);
    if (within(disc, real)) throw holding(`the disc (${disc})`);
    return outDir;
  }

  /**
   * Refuses (409 `output-in-use`) an encode whose files would land on those of another job in the queue: the same
   * output folder by real path and name patterns that can make the same names. A job for the same disc, playlist and
   * episode list is a re-encode and answers `'replaces-files'` instead; anything else answers undefined.
   */
  private async checkOutputInUse(o: {
    outDir: string;
    discKey: string;
    playlistId: string;
    episodeSpec: string;
    chapters: number;
    namePattern: string;
  }): Promise<QueuedJob['warning']> {
    const real = await realPathOf(o.outDir);
    const usedFolders = new Set<string>();
    for (const other of this.jobs) if (other.kind === 'encode') usedFolders.add(await realPathOf(other.outDir));
    if (!usedFolders.has(real)) return undefined;
    let warning: QueuedJob['warning'];
    for (const other of this.jobs) {
      if (other.kind !== 'encode' || !namesCollide(other.settings.namePattern, o.namePattern)) continue;
      if ((await realPathOf(other.outDir)) !== real) continue;
      if (other.disc.key === o.discKey && other.playlist === o.playlistId && sameListOrFalse(other.episodeSpec, o.episodeSpec, o.chapters)) {
        warning = 'replaces-files';
        continue;
      }
      let suggested = '';
      for (let n = 2; ; n++) {
        suggested = `${o.outDir.replace(/[/\\]+$/, '')}-${n}`;
        if (!usedFolders.has(await realPathOf(suggested))) break;
      }
      throw new JobError(
        409,
        'output-in-use',
        `${o.outDir} is the output folder of another encode (${other.disc.label}, playlist ${other.playlist}, ${other.state}) whose files have the same names. Choose another folder, such as ${suggested}.`,
        { suggestedOutDir: suggested, jobId: other.id },
      );
    }
    return warning;
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

  /**
   * Checks what an encode to the NAS needs before it is queued (see `checkNasDestination` in `src/nas/destination.ts`),
   * answering its refusals as 409 with their code (and `episodes`, when they name some). A NAS that does not answer is
   * no refusal: the job waits for it.
   */
  private async checkNasDestination(discKey: string, playlistId: string, episodeSpec: string, chapters: number): Promise<void> {
    try {
      await checkNasDestination({ dataDir: this.app.dataDir, client: this.app.nas.client, discKey, playlistId, episodeSpec, chapters });
    } catch (e) {
      throw asJobError(e);
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

  /** An episode as if never run; an upload the NAS still holds for it is dropped there, since its file is encoded again. */
  private resetEpisode(ep: JobEpisode): void {
    ep.state = 'queued';
    ep.framesDone = 0;
    ep.encoded = false;
    ep.step = null;
    ep.stepDone = 0;
    ep.stepTotal = 0;
    delete ep.error;
    delete ep.encodeId;
    const uploadId = ep.upload?.id;
    delete ep.upload;
    const client = this.app.nas.client;
    if (uploadId && client !== null) void abandonUpload(client, uploadId);
  }

  /** Whether `job` sends its episodes to the NAS. */
  private toNas(job: Job): boolean {
    return job.kind === 'encode' && job.settings.destination === 'nas';
  }

  /** The state of an episode that was running when its job stopped; `who` is `The app stopped` or `The job stopped`. */
  private settleStopped(job: Job, ep: JobEpisode, who: string): void {
    if (ep.state !== 'running') return;
    ep.step = null;
    if (ep.encoded && this.toNas(job)) {
      ep.state = 'upload-failed';
      ep.error = `${who} before this episode was uploaded.`;
    } else if (ep.encoded && job.settings.web) {
      ep.state = 'packaging-failed';
      ep.error = `${who} before this episode was packaged.`;
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
        // cleaned up before the job reads as done: its clips let go, and for the NAS, whose episodes are all there now,
        // the folder they were written to
        await this.releaseClips(job);
        if (this.toNas(job)) {
          await rm(nasOutDirOf(this.app.dataDir, job.id), { recursive: true, force: true }).catch((e: unknown) => this.deps.log(`The folder of job ${job.id} could not be removed: ${message(e)}`));
        }
        job.state = 'done';
        job.finishedAt = this.iso();
        this.appendLog(job, 'State: done.');
      } catch (e) {
        await this.releaseClips(job);
        for (const ep of job.episodes) this.settleStopped(job, ep, 'The job stopped');
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
        job.waiting = null;
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
    const onNas = await isMirror(job.disc.dir);
    // the fetch of the next episode's clips, which runs while an episode encodes and stops with the job
    const ahead = new AbortController();
    const stopAhead = (): void => ahead.abort();
    signal.addEventListener('abort', stopAhead, { once: true });
    const fetches = new Map<number, Promise<void>>();
    try {
      for (const ep of job.episodes) {
        if (ep.state === 'done') continue;
        if (signal.aborted) throw new DOMException('The job was cancelled', 'AbortError');
        // a pause keeps the clips the job holds for when it resumes; the fetch running ahead stops (below), its claim and
        // what it fetched staying, so the resumed job's fetch step fetches only the rest
        if (this.jobs.some((j) => j.kind === 'test' && j.state === 'queued')) return 'paused';
        if (ep.state === 'packaging-failed') {
          await this.repackage(job, ep);
          continue;
        }
        if (ep.state === 'upload-failed') {
          await this.upload(job, ep, signal);
          continue;
        }
        if (onNas) await this.fetchEpisode(job, ep, signal, ahead.signal, fetches);
        await this.encodeEpisode(job, ep, record, tools, signal);
        if (onNas) await this.releaseEncoded(job, ep);
        if (this.toNas(job)) await this.upload(job, ep, signal);
      }
    } finally {
      signal.removeEventListener('abort', stopAhead);
      ahead.abort();
      await Promise.allSettled(fetches.values());
    }
  }

  /** The NAS client to use now; a job of an app no longer paired fails. */
  private nasClient(): NasClient {
    const client = this.app.nas.client;
    if (client === null) throw new Error(UNPAIRED);
    return client;
  }

  /**
   * Runs `step` until it succeeds. While the NAS does not answer (or its encodes folder is missing) the job shows
   * `Waiting for the NAS` and tries again every `nasRetryMs`; an abort of `signal` stops the wait at once. A NAS that
   * no longer knows the app, or an app no longer paired, fails the job; anything else is the step's failure.
   */
  private async untilNas<T>(job: Job, signal: AbortSignal, step: () => Promise<T>): Promise<T> {
    for (;;) {
      try {
        const out = await step();
        if (job.waiting !== null) {
          job.waiting = null;
          this.appendLog(job, 'The NAS answers again.');
          this.persist();
        }
        return out;
      } catch (e) {
        if (signal.aborted) throw e;
        if (e instanceof NasError && e.code === 'unauthorized') throw new Error(UNPAIRED);
        const waits =
          (e instanceof FetchError && e.code === 'unreachable') ||
          (e instanceof NasError && e.code === 'unreachable') ||
          (e instanceof UploadError && (e.code === 'unreachable' || e.code === 'folder-unavailable'));
        if (!waits) throw e;
        if (job.waiting === null) {
          job.waiting = WAITING_FOR_NAS;
          this.appendLog(job, `Waiting for the NAS: ${message(e)}`);
          this.persist();
        }
        await new Promise<void>((resolve, reject) => {
          const onAbort = (): void => {
            clearTimeout(timer);
            reject(new DOMException('The job was cancelled', 'AbortError'));
          };
          const timer = setTimeout(() => {
            signal.removeEventListener('abort', onAbort);
            resolve();
          }, this.deps.nasRetryMs);
          signal.addEventListener('abort', onAbort, { once: true });
        });
      }
    }
  }

  /** Follows a fetch's or an upload's bytes: kept on the episode, and told at most once a second (and at the end). */
  private onStep(job: Job, ep: JobEpisode, done: number, total: number): void {
    ep.stepDone = done;
    ep.stepTotal = total;
    const key = `${job.id}:${ep.index}:step`;
    const now = this.deps.now();
    const last = this.lastProgress.get(key);
    if (done < total && last !== undefined && now - last < PROGRESS_INTERVAL_MS) return;
    this.lastProgress.set(key, now);
    this.persist();
  }

  /**
   * Has the clips of a NAS disc's episode here, whole, held for the job (`job:<id>`): it waits for the fetch of them
   * that ran while the episode before encoded (whose failure is this step's), then fetches what is missing, then starts
   * fetching the next episode's clips in the background.
   */
  private async fetchEpisode(job: Job, ep: JobEpisode, signal: AbortSignal, ahead: AbortSignal, fetches: Map<number, Promise<void>>): Promise<void> {
    const holder = `job:${job.id}`;
    const clips = await clipsOfEpisode(job.disc.dir, job.playlist, job.episodeSpec, ep.index);
    this.resetEpisode(ep);
    ep.state = 'running';
    ep.step = 'fetching';
    this.appendLog(job, `Episode ${ep.index}: fetching ${clips.join(', ')} from the NAS.`);
    this.persist();
    try {
      await this.untilNas(job, signal, async () => {
        const before = fetches.get(ep.index);
        if (before !== undefined) {
          fetches.delete(ep.index);
          await before;
        }
        const fetcher = new ClipFetcher({
          dataDir: this.app.dataDir,
          client: this.nasClient(),
          key: job.disc.key,
          signal,
          sleep: this.deps.nasSleep,
          onProgress: (p) => this.onStep(job, ep, p.bytesDone, p.bytes),
        });
        await fetcher.hold(holder, clips);
      });
    } catch (e) {
      if (!signal.aborted && !this.stopping) {
        ep.state = 'failed';
        ep.step = null;
        ep.error = message(e);
      }
      throw e;
    } finally {
      this.lastProgress.delete(`${job.id}:${ep.index}:step`);
    }
    const next = job.episodes.find((e) => e.index > ep.index && !e.encoded && e.state !== 'done');
    const client = this.app.nas.client;
    if (next === undefined || client === null) return;
    const nextClips = await clipsOfEpisode(job.disc.dir, job.playlist, job.episodeSpec, next.index);
    const fetching = new ClipFetcher({ dataDir: this.app.dataDir, client, key: job.disc.key, signal: ahead, sleep: this.deps.nasSleep }).hold(holder, nextClips);
    fetching.catch(() => undefined); // reported by that episode's own fetch step
    fetches.set(next.index, fetching);
  }

  /** Lets go of the clips of a NAS disc's encoded episode that no later episode of the job still needs. */
  private async releaseEncoded(job: Job, ep: JobEpisode): Promise<void> {
    const mine = await clipsOfEpisode(job.disc.dir, job.playlist, job.episodeSpec, ep.index);
    const later = new Set<string>();
    for (const e of job.episodes) {
      if (e.index <= ep.index || e.encoded || e.state === 'done') continue;
      for (const clip of await clipsOfEpisode(job.disc.dir, job.playlist, job.episodeSpec, e.index)) later.add(clip);
    }
    const free = mine.filter((c) => !later.has(c));
    if (free.length > 0) await releaseHolder(this.app.dataDir, job.disc.key, `job:${job.id}`, free);
  }

  /** Lets go of every clip the job holds (none for a job on a local disc). */
  private async releaseClips(job: Job): Promise<void> {
    if (job.kind !== 'encode') return;
    await releaseHolder(this.app.dataDir, job.disc.key, `job:${job.id}`).catch((e: unknown) => this.deps.log(`The NAS clips of job ${job.id} could not be emptied: ${message(e)}`));
  }

  /** The file name the NAS gets an episode under, `<anilistId>-<episode>.mkv`, from the episode info saved now. */
  private async uploadName(job: Job, ep: JobEpisode): Promise<string> {
    const chapters = (await loadPlaylist(job.disc.dir, job.playlist)).chapters.length;
    let pair: AniListPair | null | undefined;
    try {
      pair = (await aniListPairs(this.app.dataDir, job.disc.key, job.playlist, job.episodeSpec, chapters))[ep.index - 1];
    } catch (e) {
      throw asJobError(e);
    }
    if (pair === null || pair === undefined) throw new Error(`Episode ${ep.index} has no AniList entry and number; set one on the Episodes page and retry.`);
    return uploadNameOf(pair);
  }

  /**
   * Uploads an encoded episode's MKV to the NAS, resuming the upload kept on the episode, then deletes the MKV and
   * marks the episode done with the NAS's encode id; only the NAS's `complete` answer counts. A failed upload marks the
   * episode `upload-failed` with the MKV kept, and fails the job.
   */
  private async upload(job: Job, ep: JobEpisode, signal: AbortSignal): Promise<void> {
    const path = ep.path ?? this.mkvPath(job, ep);
    const state: UploadState = ep.upload ?? { id: null, sha256: null, size: 0, sent: 0 };
    ep.upload = state;
    ep.state = 'running';
    ep.encoded = true;
    ep.path = path;
    ep.step = 'uploading';
    ep.stepDone = state.sent;
    ep.stepTotal = state.size;
    delete ep.error;
    this.appendLog(job, `Episode ${ep.index}: uploading to the NAS${state.id === null ? '' : ', resuming its upload'}.`);
    this.persist();
    let encodeId: string;
    try {
      const name = await this.uploadName(job, ep);
      encodeId = await this.untilNas(job, signal, () =>
        uploadEpisode(this.nasClient(), path, name, state, {
          signal,
          sleep: this.deps.nasSleep,
          onProgress: (sent, size) => this.onStep(job, ep, sent, size),
          onState: () => this.persist(),
          chunkBytes: this.deps.uploadChunkBytes,
        }),
      );
    } catch (e) {
      if (!signal.aborted && !this.stopping) {
        ep.state = 'upload-failed';
        ep.step = null;
        ep.error = message(e);
      }
      throw e;
    } finally {
      this.lastProgress.delete(`${job.id}:${ep.index}:step`);
    }
    await unlink(path).catch((e: unknown) => {
      if ((e as NodeJS.ErrnoException).code !== 'ENOENT') this.deps.log(`${path} is on the NAS but could not be deleted here: ${message(e)}`);
    });
    ep.state = 'done';
    ep.step = null;
    ep.encodeId = encodeId;
    delete ep.upload;
    this.appendLog(job, `Episode ${ep.index}: on the NAS as ${encodeId}; ${path} deleted.`);
    this.persist();
  }

  private async encodeEpisode(job: Job, ep: JobEpisode, record: SubtitleRecord | null, tools: NonNullable<AppContext['tools']>, signal: AbortSignal): Promise<void> {
    this.resetEpisode(ep);
    ep.state = 'running';
    ep.step = 'encoding';
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
    if (ep.state === 'running') this.markEncoded(job, ep, ep.path ?? this.mkvPath(job, ep));
  }

  /** An episode whose MKV is complete: done, or, for the NAS, encoded and waiting for its upload. */
  private markEncoded(job: Job, ep: JobEpisode, path: string): void {
    if (!this.toNas(job)) return this.markDone(job, ep, path);
    if (ep.encoded && ep.path === path) return;
    ep.encoded = true;
    ep.path = path;
    this.appendLog(job, `Episode ${ep.index}: encoded.`);
    this.persist();
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
    ep.step = null;
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
        if (ep && ep.state !== 'done') this.markEncoded(job, ep, e.path ?? ep.path ?? this.mkvPath(job, ep));
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
          this.markEncoded(job, ep, ep.path);
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
