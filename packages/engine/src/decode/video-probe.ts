// SPDX-License-Identifier: LGPL-3.0-or-later
// The decode speed probe: 1080i MPEG-2 and VC-1 clips decoded through the WASM video decoder, timed.
import { CodingType } from '@seikou/bdmv/stream-types';
import { ASSET_FETCH_TIMEOUT_MS } from '../asset-fetch';
import type { WorkerLike } from '../bdj-types';
import { VIDEO_PROBE_DEADLINE_MS, type VideoDecoderSpeed } from '../protocol';
import type { FromVideoWorker, ToVideoWorker } from './video-worker-protocol';
import { WasmVideoDecoder } from './wasm-video-decoder';

/** Where the probe's clips are and how to read them (the bench clips shipped with the engine). */
export interface VideoBench {
  /** The MPEG-2 clip (`wasm/video/bench/mpeg2-1080i.m2v`): 1080i, an elementary stream. */
  readonly mpeg2Url: string;
  /** The VC-1 clip (`wasm/video/bench/vc1-1080i.vc1`): 1080i, an Annex E elementary stream. */
  readonly vc1Url: string;
  /** Reads a clip (default: fetch, within the asset fetch limit). */
  fetchBytes?(url: string): Promise<Uint8Array>;
}

/** What probeVideoDecoder runs on: the decoder worker, the module's URL, the clips and a monotonic clock. */
export interface VideoProbeDeps {
  readonly videoWasm: { createWorker(): WorkerLike<ToVideoWorker, FromVideoWorker>; readonly wasmUrl: string; readonly bench?: VideoBench };
  /** A monotonic clock in milliseconds (the Player's nowMs). */
  nowMs(): number;
  /** Starts a timer and returns its cancel, for the decoder's watchdog (default setTimeout). */
  readonly setTimer?: (ms: number, fn: () => void) => () => void;
}

/** Reads a clip with fetch, within the asset fetch limit. */
async function fetchClip(url: string): Promise<Uint8Array> {
  const response = await fetch(url, { signal: AbortSignal.timeout(ASSET_FETCH_TIMEOUT_MS) });
  if (!response.ok) throw new Error(`${url}: HTTP ${response.status}`);
  return new Uint8Array(await response.arrayBuffer());
}

/** The clips' rate: both are 29.97 pictures a second, and carry no timing of their own. */
const FRAME_US = Math.round(1_000_000 * 1001 / 30000);

/** The start code byte that begins a picture: MPEG-2's picture header, VC-1 Advanced Profile's frame header. */
const MPEG2_PICTURE = 0x00;
const VC1_FRAME = 0x0d;

/**
 * An elementary stream cut into one unit per picture, each starting at the picture's start code (`00 00 01 <code>`);
 * what comes before the first one (the sequence headers) goes with it, and headers between pictures go with the picture
 * before. A stream with no start code of `code` is one unit; an empty stream has none.
 */
export function splitPictures(data: Uint8Array, code: number): Uint8Array[] {
  const starts: number[] = [];
  for (let i = 0; i + 3 < data.length; i++) {
    if (data[i] === 0 && data[i + 1] === 0 && data[i + 2] === 1 && data[i + 3] === code) starts.push(i);
  }
  if (data.length === 0) return [];
  if (starts.length === 0) return [data];
  const units: Uint8Array[] = [];
  for (let k = 0; k < starts.length; k++) units.push(data.subarray(k === 0 ? 0 : starts[k]!, k + 1 < starts.length ? starts[k + 1] : data.length));
  return units;
}

/** The probe as a whole gives up after this long (20 s) and answers null: a hung worker or fetch can't hold it. */
export const PROBE_DEADLINE_MS = VIDEO_PROBE_DEADLINE_MS;

/** How many timed passes over a clip follow its untimed warm-up pass; the best of them counts. */
const TIMED_PASSES = 2;

const defaultSetTimer = (ms: number, fn: () => void): (() => void) => {
  const id = setTimeout(fn, ms);
  return () => clearTimeout(id);
};

/**
 * Decodes one clip, no clock and no skipping, and returns the best of its timed passes: pictures per second of `nowMs`
 * time for the whole clip. The module's load is not timed, and one untimed pass first warms it up (the JIT compiles the
 * decoder's code during it), so only steady-state decoding is measured. A pass is a rate of the clip's units (one a
 * picture) over the time from the first unit sent to the flush's answer. Throws when it can't decode.
 */
async function clipFps(deps: VideoProbeDeps, active: Set<WasmVideoDecoder>, cancelled: () => boolean, codingType: number, code: number, clip: Uint8Array): Promise<number> {
  // past the deadline (the clip arrived late): no worker is started
  if (cancelled()) throw new Error('the probe was cancelled');
  const decoder = new WasmVideoDecoder({
    createWorker: () => deps.videoWasm.createWorker(),
    wasmUrl: deps.videoWasm.wasmUrl,
    // the pictures are counted and dropped: a stand-in frame, so no VideoFrame is made
    makeFrame: () => ({ close: () => undefined }) as unknown as VideoFrame,
    ...(deps.setTimer ? { setTimer: deps.setTimer } : {}),
  });
  active.add(decoder);
  let pictures = 0;
  let failure: Error | null = null;
  decoder.onOutput = (frame) => {
    pictures++;
    frame.close();
  };
  decoder.onFieldInput = () => {
    pictures++;
  };
  decoder.onError = (err) => {
    failure = err;
  };
  try {
    await decoder.configure({ codingType, interlaced: true });
    if (cancelled()) throw new Error('the probe was cancelled');
    const units = splitPictures(clip, code);
    let best = 0;
    for (let pass = 0; pass <= TIMED_PASSES; pass++) {
      if (pass > 0) decoder.reset();
      pictures = 0;
      const start = deps.nowMs();
      units.forEach((data, i) => decoder.decode({ data, ptsUs: i * FRAME_US, discard: false }));
      await decoder.flush();
      const seconds = Math.max(deps.nowMs() - start, 0.001) / 1000;
      if (cancelled()) throw new Error('the probe was cancelled');
      if (failure) throw failure;
      if (pictures === 0) throw new Error('the clip decoded to no picture');
      if (pass > 0) best = Math.max(best, units.length / seconds);
    }
    return best;
  } finally {
    active.delete(decoder);
    decoder.close();
  }
}

/**
 * How fast the WASM decoder runs here: the MPEG-2 clip, then the VC-1 clip, each decoded through one WasmVideoDecoder
 * (no clock, no skipping) as an untimed warm-up and then two timed passes, the better of which is its pictures per second.
 * Null when there is no bench, a clip can't be read or decoded, or the whole takes over PROBE_DEADLINE_MS (the decoder's
 * workers are stopped then); never rejects.
 */
export async function probeVideoDecoderSpeed(deps: VideoProbeDeps): Promise<VideoDecoderSpeed | null> {
  const bench = deps.videoWasm.bench;
  if (!bench) return null;
  const read = bench.fetchBytes ?? fetchClip;
  const active = new Set<WasmVideoDecoder>();
  let over = false;
  const work = (async (): Promise<VideoDecoderSpeed | null> => {
    const mpeg2Fps = await clipFps(deps, active, () => over, CodingType.MPEG2_VIDEO, MPEG2_PICTURE, await read(bench.mpeg2Url));
    const vc1Fps = await clipFps(deps, active, () => over, CodingType.VC1, VC1_FRAME, await read(bench.vc1Url));
    return { mpeg2Fps, vc1Fps, moduleUrl: deps.videoWasm.wasmUrl, clips: `${bench.mpeg2Url}|${bench.vc1Url}` };
  })().catch(() => null);
  let cancelTimer = (): void => undefined;
  const deadline = new Promise<null>((resolve) => {
    cancelTimer = (deps.setTimer ?? defaultSetTimer)(PROBE_DEADLINE_MS, () => resolve(null));
  });
  const speed = await Promise.race([work, deadline]);
  cancelTimer();
  if (speed === null) {
    over = true;
    for (const decoder of [...active]) decoder.close();
  }
  return speed;
}
