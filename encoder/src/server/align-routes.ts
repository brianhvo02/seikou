// SPDX-License-Identifier: LGPL-3.0-or-later
import type { IncomingMessage, ServerResponse } from 'node:http';
import { join } from 'node:path';
import { alignAudio } from '@seikou/fansubs/align';
import { dialogueIntervals } from '@seikou/fansubs/dialogue';
import { retime } from '@seikou/fansubs/retime';
import { speechMask } from '@seikou/fansubs/speech';
import { mostDialogue } from '@seikou/fansubs/tracks';
import type { FansubAlignment } from '@seikou/nas/nas-api';
import { readBody } from '../../../server/src/http';
import { EpisodeAudioCache } from '../audio/episode-audio-cache';
import { decodeEpisodeAudio16k, episodeReader } from '../audio/episode-audio';
import type { EpisodePlan } from '../plan/episodes';
import type { CachedTrack } from '../subs/release-cache';
import { DiscRequestError, episodePlans } from './disc-routes';
import { releaseCacheOf } from './fansub-routes';
import { httpError, json, type HelperContext, type RouteTable } from './http';

// The line-up half of the helper's API: an episode's chosen track is lined up against the disc's own audio, decoded
// through vspipe as the encode decodes it, and the page then fetches the track retimed with what was found.

/** A stretch of episode time in milliseconds from the episode's first frame. */
export interface Span {
  readonly fromMs: number;
  readonly toMs: number;
}

/** The answer of `POST /api/episodes/<n>/align`. */
export interface AlignAnswer {
  /** The timing found for the episode's tracks, or why there is none. */
  readonly alignment: FansubAlignment;
  /** The track it was found on: the file's track with the most dialogue (its tracks share one timing). */
  readonly trackId: string;
  /** Where the disc's audio holds speech, over the whole episode. */
  readonly speech: readonly Span[];
  /** The chosen track's dialogue lines, at the track's own timing. */
  readonly dialogue: readonly Span[];
}

/** Length of a speech mask frame. */
const FRAME_MS = 10;
/** Speech runs closer than this are drawn as one span. */
const JOIN_GAP_MS = 200;
/** Episode decodes kept in memory; one 24-minute episode is about 46 MB. */
const KEEP_EPISODES = 2;

const TOOLS_MISSING = 'Alignment needs VapourSynth with BestSource (vspipe)';

const audioCaches = new WeakMap<HelperContext, EpisodeAudioCache>();

/** The run's decoded episodes, decoded through vspipe with BestSource's index kept under `<data>/bestsource`. */
function audioCacheOf(ctx: HelperContext, plans: readonly EpisodePlan[]): EpisodeAudioCache {
  let cache = audioCaches.get(ctx);
  if (!cache) {
    const tools = ctx.tools;
    if (tools === null) throw new Error('no tools to decode with');
    // The encode keeps its index in the same folder, so the line-up's indexing is not done twice.
    const cacheDir = join(ctx.dataDir, 'bestsource');
    cache = new EpisodeAudioCache((episode, signal) => decodeEpisodeAudio16k(plans[episode - 1]!, tools, cacheDir, signal), KEEP_EPISODES);
    audioCaches.set(ctx, cache);
  }
  return cache;
}

/** The runs of a speech mask (one value per 10 ms frame from 0 ms) as spans, runs less than 200 ms apart joined. */
export function speechSpans(mask: Uint8Array): Span[] {
  const spans: { fromMs: number; toMs: number }[] = [];
  let f = 0;
  while (f < mask.length) {
    if (mask[f] === 0) {
      f++;
      continue;
    }
    let end = f;
    while (end < mask.length && mask[end] === 1) end++;
    const fromMs = f * FRAME_MS;
    const toMs = end * FRAME_MS;
    const last = spans[spans.length - 1];
    if (last && fromMs - last.toMs < JOIN_GAP_MS) last.toMs = toMs;
    else spans.push({ fromMs, toMs });
    f = end;
  }
  return spans;
}

/** The request's query parameters. */
function queryOf(req: IncomingMessage): URLSearchParams {
  return new URL(req.url ?? '/', 'http://helper.invalid').searchParams;
}

/** An AbortSignal that aborts when the client goes away before its answer is sent. */
function clientGone(res: ServerResponse): AbortSignal {
  const controller = new AbortController();
  res.on('close', () => {
    if (!res.writableFinished) controller.abort(new Error('the client went away'));
  });
  return controller.signal;
}

/** The plan of episode `raw` (1-based, as captured), or null after answering 404 when the run has no such episode. */
async function planOf(res: ServerResponse, ctx: HelperContext, raw: string): Promise<{ plans: readonly EpisodePlan[]; episode: number } | null> {
  let plans: readonly EpisodePlan[];
  try {
    plans = await episodePlans(ctx);
  } catch (e) {
    if (e instanceof DiscRequestError) {
      httpError(res, e.status, e.code, e.message);
      return null;
    }
    throw e;
  }
  const episode = Number(raw);
  if (!Number.isSafeInteger(episode) || episode < 1 || episode > plans.length) {
    httpError(res, 404, 'not-found', 'This run has no such episode.');
    return null;
  }
  return { plans, episode };
}

/** The tracks of a cached release's file, or null after answering 404 when the release or file is not cached. */
async function tracksOf(res: ServerResponse, ctx: HelperContext, releaseKey: string, fileId: string): Promise<readonly CachedTrack[] | null> {
  const release = await releaseCacheOf(ctx).get(releaseKey);
  const file = release?.files.find((f) => f.id === fileId);
  if (!file) {
    httpError(res, 404, 'not-found', 'No such release or file.');
    return null;
  }
  return file.tracks;
}

const isFiniteNumber = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

/** `value` as a `FansubAlignment` when it is one, checked field by field; null otherwise. */
export function parseAlignment(value: unknown): FansubAlignment | null {
  if (typeof value !== 'object' || value === null) return null;
  const v = value as Record<string, unknown>;
  switch (v.kind) {
    case 'original':
      return { kind: 'original' };
    case 'none':
      return v.reason === 'no-speech' || v.reason === 'low-confidence' ? { kind: 'none', reason: v.reason } : null;
    case 'offset':
      return isFiniteNumber(v.offsetMs) && isFiniteNumber(v.confidence) ? { kind: 'offset', offsetMs: v.offsetMs, confidence: v.confidence } : null;
    case 'split': {
      if (!Array.isArray(v.parts) || !isFiniteNumber(v.confidence)) return null;
      const parts: { fromMs: number; offsetMs: number }[] = [];
      for (const p of v.parts as unknown[]) {
        const part = p as Record<string, unknown> | null;
        if (typeof part !== 'object' || part === null || !isFiniteNumber(part.fromMs) || !isFiniteNumber(part.offsetMs)) return null;
        parts.push({ fromMs: part.fromMs, offsetMs: part.offsetMs });
      }
      return { kind: 'split', parts, confidence: v.confidence };
    }
    default:
      return null;
  }
}

/** The `timing` query parameter (base64url JSON) as an alignment; `original` when absent, null when malformed. */
function timingOf(raw: string | null): FansubAlignment | null {
  if (raw === null || raw === '') return { kind: 'original' };
  if (!/^[A-Za-z0-9_-]+$/.test(raw)) return null;
  try {
    return parseAlignment(JSON.parse(Buffer.from(raw, 'base64url').toString('utf8')));
  } catch {
    return null;
  }
}

/**
 * The line-up routes:
 *
 *   POST /api/episodes/<n>/align       body `{ release, fileId }`: lines the file's track with the most dialogue up
 *                                      against episode n's disc audio and answers `AlignAnswer`
 *   GET  /api/episodes/<n>/subtitle?release=&file=&track=&timing=
 *                                      the track as `text/plain; charset=utf-8`, retimed with `timing` (base64url
 *                                      JSON of a `FansubAlignment`; absent means the track's own timing)
 *
 * Episodes are numbered from 1 in the run's episode list. The first align of an episode decodes its audio through
 * vspipe (tens of seconds; BestSource indexes the clips on the very first run); the last two decodes are kept. A client
 * that goes away stops a decode nobody else waits for. Errors: 400 `bad-request`, 404 `not-found` (episode, release,
 * file or track), 422 as `GET /api/episodes`, 503 `tools-missing` when vspipe or BestSource is missing.
 */
export const alignRoutes: RouteTable = [
  [
    'POST',
    /^\/api\/episodes\/(\d{1,4})\/align$/,
    async (req, res, match, ctx) => {
      if (ctx.tools === null) return httpError(res, 503, 'tools-missing', TOOLS_MISSING);
      const signal = clientGone(res);
      const bytes = await readBody(req, 16 * 1024);
      let body: unknown = null;
      try {
        if (bytes !== null) body = JSON.parse(bytes.toString('utf8'));
      } catch {
        body = null;
      }
      const { release, fileId } = (typeof body === 'object' && body !== null ? body : {}) as { release?: unknown; fileId?: unknown };
      if (typeof release !== 'string' || typeof fileId !== 'string') {
        return httpError(res, 400, 'bad-request', 'The body must be { "release": <key>, "fileId": <id> }.');
      }
      const found = await planOf(res, ctx, match[1]!);
      if (!found) return;
      const tracks = await tracksOf(res, ctx, release, fileId);
      if (!tracks) return;
      if (tracks.length === 0) return httpError(res, 404, 'not-found', 'That file has no subtitle tracks.');
      const cache = releaseCacheOf(ctx);
      const texts = await Promise.all(tracks.map(async (t) => ({ id: t.id, text: Buffer.from(await cache.read(t.path)).toString('utf8') })));
      const chosen = mostDialogue(texts);

      const { plans, episode } = found;
      const durationMs = Number(plans[episode - 1]!.durationNs / 1_000_000n);
      let pcm16k: Int16Array;
      let alignment: FansubAlignment;
      try {
        pcm16k = await audioCacheOf(ctx, plans).get(episode, signal);
        alignment = await alignAudio(episodeReader(pcm16k), durationMs, chosen.text, signal, { label: `episode ${episode}` });
      } catch (e) {
        if (signal.aborted) return; // nobody to answer
        throw e;
      }
      const answer: AlignAnswer = {
        alignment,
        trackId: chosen.id,
        speech: speechSpans(speechMask({ startMs: 0, pcm: pcm16k })),
        dialogue: dialogueIntervals(chosen.text),
      };
      json(res, 200, answer);
    },
  ],
  [
    'GET',
    /^\/api\/episodes\/(\d{1,4})\/subtitle$/,
    async (req, res, match, ctx) => {
      const query = queryOf(req);
      const releaseKey = query.get('release');
      const fileId = query.get('file');
      const trackId = query.get('track');
      const timing = timingOf(query.get('timing'));
      if (releaseKey === null || fileId === null || trackId === null) {
        return httpError(res, 400, 'bad-request', 'release, file and track are needed.');
      }
      if (timing === null) return httpError(res, 400, 'bad-request', 'timing must be base64url JSON of an alignment.');
      if (!(await planOf(res, ctx, match[1]!))) return;
      const tracks = await tracksOf(res, ctx, releaseKey, fileId);
      if (!tracks) return;
      const track = tracks.find((t) => t.id === trackId);
      if (!track) return httpError(res, 404, 'not-found', 'No such track.');
      const bytes = await releaseCacheOf(ctx).read(track.path);
      const body = timing.kind === 'original' ? Buffer.from(bytes) : Buffer.from(retime(Buffer.from(bytes).toString('utf8'), timing), 'utf8');
      res.writeHead(200, {
        'Content-Type': 'text/plain; charset=utf-8',
        'Content-Length': String(body.length),
        'Cache-Control': 'no-store',
      });
      res.end(body);
    },
  ],
];
