// SPDX-License-Identifier: LGPL-3.0-or-later
import { mkdir, readdir, rename, rm, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { loadPlaylist, type Playlist } from '../disc/playlist';
import { readPlaylistPmts } from '../disc/pmt';
import { probeClip, type ClipProbe } from '../disc/probe';
import { encodePlan, opusArgs, type EncodeEvent, type PlanEncodeOptions } from '../encode';
import { type ParsedMkv } from '@seikou/matroska';
import { readMkv } from '../mux/mkv-file';
import { writeWebm } from '../package/webm';
import { selectAudio } from '../plan/audio-streams';
import { parseEpisodeSpec, planRanges, type TimeRange } from '../plan/episodes';
import type { ToolPaths } from '../pipeline/chain';
import { loadEncodeRecord } from '../subs/encode-record';
import { parseSettings, ProfileError, type EncodeSettings } from './profiles';

// A test encode: short stretches of a playlist's first episode, each encoded with one to three settings profiles, so
// the person can watch the samples side by side and compare each profile's projected size before a long encode. The
// video is encoded once per profile and stretch; the first audio stream once per stretch, shared by every profile's
// sample, since the audio is not what is compared.

/** How many stretches a test takes from an episode of a minute or more. */
export const STRETCH_COUNT = 5;
/** The longest a stretch is, in milliseconds. */
export const STRETCH_MS = 10_000;
/** The share of the episode kept clear of stretches at its start and at its end. */
const EDGE_SHARE = 0.05;
/** The most profiles one test compares. */
export const MAX_TEST_PROFILES = 3;

/** One profile a test encodes with: its id (a folder name of the samples), its name and its settings. */
export interface TestProfile {
  /** The profile's id: lower-case letters and digits, at most 32. */
  readonly id: string;
  /** The profile's name, for the page. */
  readonly name: string;
  /** The settings the samples are encoded with (only the video and Opus ones count). */
  readonly settings: EncodeSettings;
}

/** What one profile's samples measured. */
export interface TestProfileResult {
  /** The profile's id. */
  readonly id: string;
  /** The video bytes of every sample of the profile over the samples' length in seconds. */
  readonly videoBytesPerSecond: number;
  /**
   * Bytes per second of one audio stream at this profile's Opus bitrate: the shared audio sample's rate (encoded once,
   * at the first profile's bitrate) scaled by this profile's effective bitrate over the first profile's.
   */
  readonly audioBytesPerSecond: number;
}

/** Everything a test job keeps besides what every job has. */
export interface TestPlan {
  /** The profiles compared, in the order the page shows them. */
  readonly profiles: readonly TestProfile[];
  /** The stretches of playlist time the samples cover, in order; sample `n` is stretch `n` (from 1). */
  readonly stretches: readonly TimeRange[];
  /** The length in seconds of each episode of the job's episode list, for the projected sizes. */
  readonly episodeSeconds: readonly number[];
  /** How many audio streams an encode of the job's episodes would write; null until the test has run. */
  audioStreams: number | null;
  /** Each profile's measurements, in the order of `profiles`; null until the test is done. */
  results: TestProfileResult[] | null;
}

/** What a test run reports when it is done. */
export interface TestOutcome {
  /** How many audio streams an encode of the episodes would write: the saved subtitle record's, else every stream of the playlist. */
  readonly audioStreams: number;
  /** Each profile's measurements, in profile order. */
  readonly results: TestProfileResult[];
}

/** Thrown for a test's profiles that cannot be used; `field` names the setting at fault when there is one. */
export class TestInputError extends Error {
  override name = 'TestInputError';
  constructor(
    message: string,
    /** The setting at fault, when it is one. */
    readonly field?: string,
  ) {
    super(message);
  }
}

/**
 * The bytes an episode of `episodeSeconds` would take with the profile `result` measured: its video bytes per second
 * plus the shared audio's bytes per second once for each of the `audioStreams` streams the encode writes, times the
 * length. Container overhead is left out.
 */
export function projectedBytes(episodeSeconds: number, result: Pick<TestProfileResult, 'videoBytesPerSecond' | 'audioBytesPerSecond'>, audioStreams: number): number {
  return (result.videoBytesPerSecond + result.audioBytesPerSecond * audioStreams) * episodeSeconds;
}

/**
 * The stretches a test samples from an episode spanning `range` of playlist time: five, spread evenly over the
 * episode with its first and last 5% left out, each 10 s long or a sixth of the episode when that is shorter, so a
 * short episode's stretches never overlap or run past it. Times are whole milliseconds. Throws `RangeError` for an
 * empty range.
 */
export function testStretches(range: TimeRange): TimeRange[] {
  const length = range.endMs - range.startMs;
  if (!(length > 0)) throw new RangeError('An episode to sample must have a length');
  const stretch = Math.min(STRETCH_MS, length / 6);
  const first = range.startMs + length * EDGE_SHARE;
  const lastStart = range.endMs - length * EDGE_SHARE - stretch;
  const step = (lastStart - first) / (STRETCH_COUNT - 1);
  const out: TimeRange[] = [];
  for (let i = 0; i < STRETCH_COUNT; i++) {
    const startMs = Math.max(Math.round(first + i * step), out.at(-1)?.endMs ?? range.startMs);
    const endMs = Math.min(Math.round(first + i * step + stretch), range.endMs);
    if (endMs > startMs) out.push({ startMs, endMs });
  }
  // Only an episode of a few milliseconds leaves nothing; it is then sampled whole.
  return out.length > 0 ? out : [{ startMs: range.startMs, endMs: range.endMs }];
}

/** The playlist time each episode of `episodeSpec` spans, in whole milliseconds, as `planEpisodes` cuts them. Throws `EpisodeSpecError`. */
export function episodeRanges(playlist: Pick<Playlist, 'chapters' | 'duration45'>, episodeSpec: string): TimeRange[] {
  const count = playlist.chapters.length;
  return parseEpisodeSpec(episodeSpec, count).map((spec) => {
    const last = spec.to ?? count;
    const start45 = playlist.chapters[spec.from - 1]!.start45;
    const end45 = last < count ? playlist.chapters[last]!.start45 : playlist.duration45;
    return { startMs: Math.round(start45 / 45), endMs: Math.floor(end45 / 45) };
  });
}

/**
 * Plans a test of `episodeSpec` on `playlist`: the stretches of its first episode (`testStretches`) and every
 * episode's length in seconds. Throws `EpisodeSpecError` for a bad list.
 */
export function planTest(playlist: Pick<Playlist, 'chapters' | 'duration45'>, episodeSpec: string): { stretches: TimeRange[]; episodeSeconds: number[] } {
  const ranges = episodeRanges(playlist, episodeSpec);
  return { stretches: testStretches(ranges[0]!), episodeSeconds: ranges.map((r) => (r.endMs - r.startMs) / 1000) };
}

/** Checks a test's profiles: a list of one to three `{ id, name, settings }` with distinct ids. Throws `TestInputError`. */
export function parseTestProfiles(value: unknown): TestProfile[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > MAX_TEST_PROFILES) {
    throw new TestInputError(`A test compares one to ${MAX_TEST_PROFILES} profiles.`, 'profiles');
  }
  const seen = new Set<string>();
  return value.map((raw: unknown): TestProfile => {
    const p = raw as Record<string, unknown> | null;
    if (typeof p !== 'object' || p === null) throw new TestInputError('Each profile of a test is an object.', 'profiles');
    if (typeof p.id !== 'string' || !/^[a-z0-9]{1,32}$/.test(p.id)) throw new TestInputError('A profile id is lower-case letters and digits.', 'profiles');
    if (seen.has(p.id)) throw new TestInputError('A test names each profile once.', 'profiles');
    seen.add(p.id);
    if (typeof p.name !== 'string' || p.name.trim() === '' || p.name.length > 80) throw new TestInputError('Each profile of a test needs a name.', 'profiles');
    try {
      return { id: p.id, name: p.name.trim(), settings: parseSettings(p.settings) };
    } catch (e) {
      if (e instanceof ProfileError) throw new TestInputError(`${p.name.trim()}: ${e.message}`, e.field);
      throw e;
    }
  });
}

/** The Opus bitrate in kb/s an encode uses for a stream of `channels` channels: `bitrate`, else the encoder's default (160 up to stereo, 320 above). */
export function effectiveOpusBitrate(bitrate: number | null, channels: number): number {
  return Number(opusArgs(channels, bitrate ?? undefined)[1]);
}

/** The folder a test job's samples are written to: `<dataDir>/tests/<jobId>`. */
export function testDirOf(dataDir: string, jobId: string): string {
  return join(dataDir, 'tests', jobId);
}

/** The test job fields a run reads. */
export interface TestJob {
  /** The job's id; its samples go to `<dataDir>/tests/<id>`. */
  readonly id: string;
  /** The disc; `dir` is the folder holding BDMV. */
  readonly disc: { readonly dir: string };
  /** Five-digit playlist name. */
  readonly playlist: string;
  /** The episode list, for the saved subtitle record's audio streams. */
  readonly episodeSpec: string;
  /** Whether an encode of the episodes would leave the saved subtitle record out. */
  readonly noSubtitles: boolean;
  /** The profiles and stretches. */
  readonly test: Pick<TestPlan, 'profiles' | 'stretches'>;
}

/** What a test run is done with. */
export interface TestContext {
  /** The app's data folder: the samples, BestSource's index cache and the subtitle records live here. */
  readonly dataDir: string;
  /** The encoding tools, or null when they were not found. */
  readonly tools: ToolPaths | null;
}

/** What a test run does its work with; tests replace it. */
export interface TestDeps {
  /** Encodes one plan into one MKV. Default `encodePlan`. */
  readonly encodePlan: (options: PlanEncodeOptions, onEvent: (e: EncodeEvent) => void) => Promise<void>;
}

function abortError(): Error {
  return new DOMException('The test encode was aborted', 'AbortError');
}

/** The bytes of every block of each track of `mkv`, by track number. */
async function trackBytes(mkv: ParsedMkv): Promise<Map<number, number>> {
  const bytes = new Map<number, number>();
  for await (const b of mkv.blocks()) bytes.set(b.track, (bytes.get(b.track) ?? 0) + b.data.length);
  return bytes;
}

/** The bytes of the tracks of `mkv` with `codecId`. */
async function bytesOf(mkv: ParsedMkv, codecId: string): Promise<number> {
  const counts = await trackBytes(mkv);
  return mkv.tracks.filter((t) => t.codecId === codecId).reduce((sum, t) => sum + (counts.get(t.number) ?? 0), 0);
}

/** Removes every `*.webm.partial` in the profile folders of a test folder. */
async function removePartialSamples(dir: string, profiles: readonly TestProfile[]): Promise<void> {
  for (const p of profiles) {
    let names: string[];
    try {
      names = await readdir(join(dir, p.id));
    } catch {
      continue;
    }
    for (const name of names) if (name.endsWith('.webm.partial')) await unlink(join(dir, p.id, name)).catch(() => undefined);
  }
}

/**
 * Runs a test job. Each stretch is planned frame-exactly (`planRanges`) and encoded once per profile, in profile order,
 * with that profile's video settings (`encodePlan`); the first profile's encode also carries the playlist's first audio
 * stream, as Opus at the first profile's bitrate (the encoder's default when it has none). Each sample is packaged as
 * `<dataDir>/tests/<jobId>/<profileId>/<n>.webm` (stretch `n` from 1) holding that profile's AV1 video and the shared
 * Opus track, written as `<n>.webm.partial` and renamed when complete; the intermediate MKVs live in the folder's
 * `work/`, which is removed at the end, whatever happened. Every sample encode is one unit of progress: events carry
 * the unit's number, `(n - 1) × profiles + k` for the k-th profile (from 1), as their `episode`, with an
 * `episode-start` before and an `episode-done` (its `path` the WebM) after. Resolves with each profile's video bytes
 * per second and the shared audio's, measured from the encoded blocks, and how many audio streams an encode of the
 * episodes would write. `signal` stops every tool; the run then rejects with an `AbortError`, leaving no partial sample.
 */
export async function runTestEncode(
  job: TestJob,
  ctx: TestContext,
  signal: AbortSignal,
  onEvent: (e: EncodeEvent) => void,
  deps: TestDeps = { encodePlan },
): Promise<TestOutcome> {
  const checkAbort = (): void => {
    if (signal.aborted) throw abortError();
  };
  checkAbort();
  const tools = ctx.tools;
  if (tools === null) throw new Error('The encoding tools (vspipe with BestSource, SvtAv1EncApp and opusenc) were not found when the app started.');
  const { profiles, stretches } = job.test;
  const playlist = await loadPlaylist(job.disc.dir, job.playlist);
  const probes = new Map<string, ClipProbe>();
  for (const item of playlist.items) {
    if (!probes.has(item.clipId)) probes.set(item.clipId, await probeClip(item));
  }
  const pmts = await readPlaylistPmts(playlist);
  const log = (message: string): void => onEvent({ kind: 'log', episode: 0, message });
  const every = selectAudio(playlist, null, 1, log);
  const shared = every.slice(0, 1);
  let audioStreams = every.length;
  if (!job.noSubtitles) {
    try {
      const record = await loadEncodeRecord({ discDir: job.disc.dir, playlistId: job.playlist, episodeSpec: job.episodeSpec, dataDir: ctx.dataDir, noSubtitles: false });
      if (record !== null) audioStreams = selectAudio(playlist, record, 1, () => undefined).length;
    } catch (e) {
      log(`The saved subtitle choices cannot be used for the audio stream count (${e instanceof Error ? e.message : String(e)}); counting every audio stream.`);
    }
  }
  const plans = planRanges(playlist, probes, stretches, shared, pmts);
  const dir = testDirOf(ctx.dataDir, job.id);
  const work = join(dir, 'work');
  const cacheDir = join(ctx.dataDir, 'bestsource');
  await mkdir(cacheDir, { recursive: true });
  await mkdir(work, { recursive: true });
  const videoBytes = profiles.map(() => 0);
  let audioBytes = 0;
  let seconds = 0;
  const audioSettings = profiles[0]!.settings;
  try {
    for (const plan of plans) {
      const n = plan.index;
      seconds += Number(plan.durationNs) / 1e9;
      let audioMkv: ParsedMkv | undefined;
      for (const [k, profile] of profiles.entries()) {
        checkAbort();
        const unit = (n - 1) * profiles.length + k + 1;
        const mkvPath = join(work, `${n}-${profile.id}.mkv`);
        const s = profile.settings;
        onEvent({ kind: 'episode-start', episode: unit, message: `Sample ${n} with ${profile.name}` });
        await deps.encodePlan(
          {
            plan,
            audio: k === 0 ? shared : [],
            outPath: mkvPath,
            crf: s.crf,
            preset: s.preset,
            filmGrain: s.filmGrain,
            extraSvtArgs: [...s.extraSvtArgs],
            opusBitrate: audioSettings.opusBitrate ?? undefined,
            cacheDir,
            tools,
            signal,
            title: `Sample ${n}`,
          },
          (e) => onEvent({ ...e, episode: unit }),
        );
        checkAbort();
        const mkv = await readMkv(mkvPath);
        videoBytes[k]! += await bytesOf(mkv, 'V_AV1');
        if (k === 0) {
          audioMkv = mkv;
          audioBytes += await bytesOf(mkv, 'A_OPUS');
        }
        const out = join(dir, profile.id, `${n}.webm`);
        await mkdir(join(dir, profile.id), { recursive: true });
        await writeWebm(mkv, `${out}.partial`, k === 0 || audioMkv === undefined ? {} : { audioFrom: audioMkv });
        await rename(`${out}.partial`, out);
        onEvent({ kind: 'episode-done', episode: unit, message: `Sample ${n} with ${profile.name} done`, path: out });
      }
    }
  } catch (e) {
    await removePartialSamples(dir, profiles);
    throw signal.aborted ? abortError() : e;
  } finally {
    await rm(work, { recursive: true, force: true });
  }
  const audioBytesPerSecond = seconds > 0 ? audioBytes / seconds : 0;
  // Opus at a set bitrate spends close to it, so the shared sample's rate scales to another profile's bitrate.
  const channels = shared[0]?.channels ?? 2;
  const firstRate = effectiveOpusBitrate(audioSettings.opusBitrate, channels);
  return {
    audioStreams,
    results: profiles.map((p, k) => ({
      id: p.id,
      videoBytesPerSecond: seconds > 0 ? videoBytes[k]! / seconds : 0,
      audioBytesPerSecond: (audioBytesPerSecond * effectiveOpusBitrate(p.settings.opusBitrate, channels)) / firstRate,
    })),
  };
}
