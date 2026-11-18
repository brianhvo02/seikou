import mpeg2BenchUrl from '@seikou/engine/bench/mpeg2-1080i.m2v?url';
import vc1BenchUrl from '@seikou/engine/bench/vc1-1080i.vc1?url';
import videoWasmUrl from '@seikou/engine/video.wasm?url';
import type { MemoryProfileName } from '@seikou/engine/memory-profile';
import type { VideoDecoderSpeed } from '@seikou/engine/protocol';
import { chooseMemoryProfile } from './memory-profile';

/** What this device can play and show, used to pick and enable quality levels. */
export interface VideoCaps {
  /** WebCodecs decodes HEVC Main (8-bit) at 1080p, or the browser's video player plays it through Media Source Extensions. */
  hevc: boolean;
  /** WebCodecs decodes HEVC Main 10, or the browser's video player plays it through Media Source Extensions. */
  hevc10: boolean;
  /** The display reports `(dynamic-range: high)`. */
  hdrDisplay: boolean;
  /** A phone-sized device: the constrained memory profile or a screen under 600 CSS px on its shorter side. */
  phone: boolean;
}

/** What the caps probes read, injectable for tests. */
export interface VideoCapsEnv {
  /** `VideoDecoder.isConfigSupported`; absent when WebCodecs is. */
  isConfigSupported?: (c: { codec: string; codedWidth: number; codedHeight: number }) => Promise<{ supported?: boolean }>;
  /** The media source class's `isTypeSupported` (`ManagedMediaSource` where there is one, else `MediaSource`); absent without Media Source Extensions. */
  isTypeSupported?: (type: string) => boolean;
  matchMedia: (q: string) => { matches: boolean };
  /** The screen size in CSS px. */
  screen: { width: number; height: number };
  /** The memory profile in force. */
  memoryProfile: 'desktop' | 'constrained';
}

/**
 * The decode rates, in pictures per second, from which a 1080i disc plays. MPEG-2: 1.5 times 29.97, the margin for a busy
 * device (the probe's clip is coded at a disc's rate, about 25 Mb/s). VC-1: 2 times, because its clip can only be the
 * CC BY sample, at about 5 Mb/s against a disc's 25 to 35, so the same speed on the clip means a slower decode of a disc.
 */
const MPEG2_PLAYABLE_FPS = (1.5 * 30000) / 1001;
const VC1_PLAYABLE_FPS = (2 * 30000) / 1001;

/** What the probe says of one coding: `fast` (plays a disc at Original), `slow` (measured, too slow), `unknown` (not measured: not probed, or the probe could not run). */
export type WasmSpeedClass = 'fast' | 'slow' | 'unknown';

/** Which of MPEG-2 and VC-1 the WASM decoder decodes fast enough to play (MPEG-2 at 1.5 times 29.97 pictures per second, VC-1 at 2 times); both `unknown` for no measurement (null). */
export function wasmVideoPlayable(speed: { mpeg2Fps: number; vc1Fps: number } | null): { mpeg2: WasmSpeedClass; vc1: WasmSpeedClass } {
  if (speed === null) return { mpeg2: 'unknown', vc1: 'unknown' };
  return { mpeg2: speed.mpeg2Fps >= MPEG2_PLAYABLE_FPS ? 'fast' : 'slow', vc1: speed.vc1Fps >= VC1_PLAYABLE_FPS ? 'fast' : 'slow' };
}

/** The localStorage key of the stored decode speed: `{ moduleUrl, clips, mpeg2Fps, vc1Fps, measuredAt }`. */
export const WASM_VIDEO_SPEED_KEY = 'bluray-web:wasm-video-speed';

/** A stored speed is measured again after this long (30 days): a device's speed changes with its hardware, load and browser. */
export const WASM_VIDEO_SPEED_TTL_MS = 30 * 24 * 3600 * 1000;

/** The part of `Storage` the speed cache uses. */
export interface SpeedStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

/**
 * The stored speed when it was measured for this module and these clips, no more than 30 days before `nowMs`; null for
 * none, another build's, an old one or a damaged value. Never throws.
 */
export function readStoredWasmSpeed(storage: () => SpeedStorage | null, moduleUrl: string, clips: string, nowMs: number): { mpeg2Fps: number; vc1Fps: number } | null {
  try {
    const raw = storage()?.getItem(WASM_VIDEO_SPEED_KEY);
    if (!raw) return null;
    const v = JSON.parse(raw) as { moduleUrl?: unknown; clips?: unknown; mpeg2Fps?: unknown; vc1Fps?: unknown; measuredAt?: unknown } | null;
    if (!v || v.moduleUrl !== moduleUrl || v.clips !== clips) return null;
    if (typeof v.mpeg2Fps !== 'number' || typeof v.vc1Fps !== 'number' || !Number.isFinite(v.mpeg2Fps) || !Number.isFinite(v.vc1Fps)) return null;
    if (typeof v.measuredAt !== 'number') return null;
    const age = nowMs - v.measuredAt;
    if (!(age >= 0 && age <= WASM_VIDEO_SPEED_TTL_MS)) return null;
    return { mpeg2Fps: v.mpeg2Fps, vc1Fps: v.vc1Fps };
  } catch {
    return null;
  }
}

/** What measureWasmVideo reads and runs. */
export interface WasmSpeedEnv {
  /** The URL of the video.wasm this build loads. */
  readonly moduleUrl: string;
  /** This build's two bench clip URLs joined by `|` (MPEG-2's, then VC-1's), as the engine reports them. */
  readonly clips: string;
  /** localStorage, or null where it is missing (it may throw: private browsing). */
  storage(): SpeedStorage | null;
  /** The time in milliseconds since the epoch. */
  now(): number;
  /** The page is hidden: nothing is measured then, since a hidden page's timers and threads are throttled. */
  hidden(): boolean;
  /** Runs the engine's decode speed probe (null when it could not run). */
  probe(): Promise<VideoDecoderSpeed | null>;
  /** Test-only (`?wasmfast=1`): both codings answer `fast` at once, with nothing probed or stored. */
  readonly forceFast?: boolean;
}

const UNKNOWN = { mpeg2: 'unknown', vc1: 'unknown' } as const;

/**
 * Which of MPEG-2 and VC-1 the WASM decoder plays on this device: the speed stored for this module and these clips when
 * it is under 30 days old, else a probe, whose clean answer is stored. `unknown` for both, with nothing stored, when
 * the page is hidden or the probe fails, answers null (the engine would not run it: a disc is playing; or it timed
 * out) or throws. Never rejects.
 */
export async function measureWasmVideo(env: WasmSpeedEnv): Promise<{ mpeg2: WasmSpeedClass; vc1: WasmSpeedClass }> {
  if (env.forceFast) return { mpeg2: 'fast', vc1: 'fast' };
  const now = env.now();
  const stored = readStoredWasmSpeed(env.storage, env.moduleUrl, env.clips, now);
  if (stored) return wasmVideoPlayable(stored);
  let hidden = false;
  try {
    hidden = env.hidden();
  } catch {
    // unreadable: measure
  }
  if (hidden) return UNKNOWN;
  let speed: VideoDecoderSpeed | null = null;
  try {
    speed = await env.probe();
  } catch {
    speed = null;
  }
  if (!speed) return UNKNOWN;
  try {
    env.storage()?.setItem(WASM_VIDEO_SPEED_KEY, JSON.stringify({ moduleUrl: env.moduleUrl, clips: env.clips, mpeg2Fps: speed.mpeg2Fps, vc1Fps: speed.vc1Fps, measuredAt: now }));
  } catch {
    // private mode: the result still counts for this page
  }
  return wasmVideoPlayable(speed);
}

const HEVC_MAIN = 'hvc1.1.6.L120.90';
const HEVC_MAIN10 = 'hvc1.2.4.L120.90';
/** Phones are 320-440 CSS px on the shorter side; laptops start well above this. */
const PHONE_SHORT_SIDE = 600;

/** The AV1 probe without the encode's own codec string: Main profile, level 4.0, 8-bit (what Seikou's encoder writes). */
export const AV1_PROBE_CODEC = 'av01.0.08M.08';

/**
 * Whether this browser decodes an encode's AV1 video: its codec string when the entry carries one (`av01.…`; a
 * Matroska codec id such as `V_AV1` is none), else AV1_PROBE_CODEC, at 1080p. False without WebCodecs or on a failed probe.
 */
export function detectAv1(env: Pick<VideoCapsEnv, 'isConfigSupported'>, codec?: string): Promise<boolean> {
  return probe(env, codec !== undefined && codec.startsWith('av01.') ? codec : AV1_PROBE_CODEC);
}

/** Whether a page address's query carries the test-only `noav1` flag, which makes the AV1 check say unsupported. */
export function noAv1Flag(search: string): boolean {
  return new URLSearchParams(search).has('noav1');
}

/**
 * `?noav1=1` (test-only), read once as the app loads (as the other test flags are, since the address bar changes as the app
 * navigates): the AV1 check then says unsupported, so an encode's pre-flight shows its AV1 warning in any browser.
 */
const NO_AV1 = typeof location !== 'undefined' && noAv1Flag(location.search);

/** Whether a page address's query carries the test-only `wasmfast` flag, which makes the decode speed probe answer `fast`. */
export function wasmFastFlag(search: string): boolean {
  return new URLSearchParams(search).has('wasmfast');
}

/**
 * `?wasmfast=1` (test-only), read once as the app loads: wasmVideoPlayability answers `fast` for MPEG-2 and VC-1 without
 * measuring, so the NAS offers and preselects Original for such a disc on any runner, however fast it decodes.
 */
const WASM_FAST = typeof location !== 'undefined' && wasmFastFlag(location.search);

/** detectAv1 in this browser; never rejects. `?noav1=1` (test-only) makes it false. */
export function av1Playable(codec?: string): Promise<boolean> {
  if (NO_AV1) return Promise.resolve(false);
  try {
    return detectAv1(browserVideoCapsEnv(), codec);
  } catch {
    return Promise.resolve(false);
  }
}

async function probe(env: Pick<VideoCapsEnv, 'isConfigSupported'>, codec: string): Promise<boolean> {
  if (!env.isConfigSupported) return false;
  try {
    return (await env.isConfigSupported({ codec, codedWidth: 1920, codedHeight: 1080 })).supported === true;
  } catch {
    return false;
  }
}

/** Whether the media source class plays `codec` as fragmented MP4; false when it is missing or throws. */
function mseProbe(env: Pick<VideoCapsEnv, 'isTypeSupported'>, codec: string): boolean {
  if (!env.isTypeSupported) return false;
  try {
    return env.isTypeSupported(`video/mp4; codecs="${codec}"`) === true;
  } catch {
    return false;
  }
}

/** Probes the device once: HEVC Main and Main 10 through `isConfigSupported` or the media source's `isTypeSupported` (false for a probe that throws or is missing), the display's dynamic range and the phone test. */
export async function detectVideoCaps(env: VideoCapsEnv): Promise<VideoCaps> {
  const [codecs, codecs10] = await Promise.all([probe(env, HEVC_MAIN), probe(env, HEVC_MAIN10)]);
  const hevc = codecs || mseProbe(env, HEVC_MAIN);
  const hevc10 = codecs10 || mseProbe(env, HEVC_MAIN10);
  return {
    hevc,
    hevc10,
    hdrDisplay: env.matchMedia('(dynamic-range: high)').matches,
    phone: env.memoryProfile === 'constrained' || Math.min(env.screen.width, env.screen.height) < PHONE_SHORT_SIDE,
  };
}

/** The browser's memory profile (the one place it is read for the caps). */
function browserMemoryProfile(): MemoryProfileName {
  return chooseMemoryProfile({
    search: location.search,
    coarsePointer: matchMedia('(pointer: coarse)').matches,
    maxTouchPoints: navigator.maxTouchPoints,
    platform: navigator.platform,
  });
}

/** The page's media source class's `isTypeSupported`, `ManagedMediaSource` first; undefined without either. */
export function browserIsTypeSupported(): ((type: string) => boolean) | undefined {
  const g = globalThis as { ManagedMediaSource?: { isTypeSupported(t: string): boolean }; MediaSource?: { isTypeSupported(t: string): boolean } };
  const source = g.ManagedMediaSource ?? g.MediaSource;
  return source && typeof source.isTypeSupported === 'function' ? (t) => source.isTypeSupported(t) : undefined;
}

/** The real browser's `VideoCapsEnv`. */
export function browserVideoCapsEnv(): VideoCapsEnv {
  return {
    isConfigSupported: typeof VideoDecoder !== 'undefined' && typeof VideoDecoder.isConfigSupported === 'function'
      ? (c) => VideoDecoder.isConfigSupported(c)
      : undefined,
    isTypeSupported: browserIsTypeSupported(),
    matchMedia: (q) => window.matchMedia(q),
    screen: { width: window.screen.width, height: window.screen.height },
    memoryProfile: browserMemoryProfile(),
  };
}

/** localStorage, or null where reading the property throws (private browsing, blocked site data). */
function browserStorage(): SpeedStorage | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage;
  } catch {
    return null;
  }
}

/**
 * The caps, never failing: when the environment can't be read or the probe fails, no HEVC or HDR, and "phone" from the
 * memory profile alone (a computer when even that can't be told).
 */
export async function loadVideoCaps(makeEnv: () => VideoCapsEnv, profile: () => MemoryProfileName): Promise<VideoCaps> {
  try {
    return await detectVideoCaps(makeEnv());
  } catch {
    let phone = false;
    try {
      phone = profile() === 'constrained';
    } catch {
      // no profile either: a computer, as the desktop profile is the default
    }
    return { hevc: false, hevc10: false, hdrDisplay: false, phone };
  }
}

let cached: Promise<VideoCaps> | null = null;

/** One probe per page; it never rejects. */
export function videoCaps(): Promise<VideoCaps> {
  cached ??= loadVideoCaps(browserVideoCapsEnv, browserMemoryProfile);
  return cached;
}

let wasmPlayability: Promise<{ mpeg2: WasmSpeedClass; vc1: WasmSpeedClass }> | null = null;

/**
 * Which of MPEG-2 and VC-1 play through the WASM decoder on this device (`fast`, `slow` or `unknown` each): the stored
 * speed for this build when it is under 30 days old, else `probe` (the controller's probeVideoDecoder) runs and its clean
 * answer is stored. Once measured, the answer is kept for the page's life; an `unknown` (hidden page, a disc playing, a
 * failed probe) is asked again on the next call. Never rejects.
 */
export function wasmVideoPlayability(probe: () => Promise<VideoDecoderSpeed | null>): Promise<{ mpeg2: WasmSpeedClass; vc1: WasmSpeedClass }> {
  if (wasmPlayability) return wasmPlayability;
  const run = measureWasmVideo({
    moduleUrl: videoWasmUrl,
    clips: `${mpeg2BenchUrl}|${vc1BenchUrl}`,
    storage: browserStorage,
    now: () => Date.now(),
    hidden: () => typeof document !== 'undefined' && document.visibilityState === 'hidden',
    probe,
    forceFast: WASM_FAST,
  });
  const result = run.then((r) => {
    if (r.mpeg2 === 'unknown' && r.vc1 === 'unknown' && wasmPlayability === result) wasmPlayability = null;
    return r;
  });
  wasmPlayability = result;
  return result;
}
