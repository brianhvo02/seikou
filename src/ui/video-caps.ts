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
  /**
   * The WASM decoder keeps up with 1080i MPEG-2 on this device, going by the speed the last probe stored for this build
   * (false until a probe has run: `wasmVideoPlayability` runs it).
   */
  mpeg2: boolean;
  /** As `mpeg2`, for VC-1. */
  vc1: boolean;
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
  /** The decode speed a probe stored for the current video.wasm, if any; absent or null when none (no probe is run here). */
  cachedWasmSpeed?: () => { mpeg2Fps: number; vc1Fps: number } | null;
}

/** The decode rate, in pictures per second, from which a 1080i disc plays: 1.5 times its 29.97, the margin for a busy device. */
const WASM_PLAYABLE_FPS = (1.5 * 30000) / 1001;

/** Which of MPEG-2 and VC-1 the WASM decoder decodes fast enough to play (1.5 times 29.97 pictures per second); neither when the probe failed (null). */
export function wasmVideoPlayable(speed: { mpeg2Fps: number; vc1Fps: number } | null): { mpeg2: boolean; vc1: boolean } {
  return { mpeg2: speed !== null && speed.mpeg2Fps >= WASM_PLAYABLE_FPS, vc1: speed !== null && speed.vc1Fps >= WASM_PLAYABLE_FPS };
}

/** The localStorage key of the stored decode speed: `{ moduleUrl, mpeg2Fps, vc1Fps }`. */
export const WASM_VIDEO_SPEED_KEY = 'bluray-web:wasm-video-speed';

/** The part of `Storage` the speed cache uses. */
export interface SpeedStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

/** The stored speed when it was measured for `moduleUrl`; null for none, another module's or a damaged value. Never throws. */
export function readStoredWasmSpeed(storage: () => SpeedStorage | null, moduleUrl: string): { mpeg2Fps: number; vc1Fps: number } | null {
  try {
    const raw = storage()?.getItem(WASM_VIDEO_SPEED_KEY);
    if (!raw) return null;
    const v = JSON.parse(raw) as Partial<VideoDecoderSpeed> | null;
    if (!v || v.moduleUrl !== moduleUrl || typeof v.mpeg2Fps !== 'number' || typeof v.vc1Fps !== 'number' || !Number.isFinite(v.mpeg2Fps) || !Number.isFinite(v.vc1Fps)) return null;
    return { mpeg2Fps: v.mpeg2Fps, vc1Fps: v.vc1Fps };
  } catch {
    return null;
  }
}

/** What measureWasmVideo reads and runs. */
export interface WasmSpeedEnv {
  /** The URL of the video.wasm this build loads. */
  readonly moduleUrl: string;
  /** localStorage, or null where it is missing (it may throw: private browsing). */
  storage(): SpeedStorage | null;
  /** Runs the engine's decode speed probe. */
  probe(): Promise<VideoDecoderSpeed | null>;
}

/**
 * Which of MPEG-2 and VC-1 the WASM decoder plays on this device: the speed stored for the current module when there is
 * one, else a probe (stored when it answers). A probe that fails or answers null makes both unplayable and stores
 * nothing. Never rejects.
 */
export async function measureWasmVideo(env: WasmSpeedEnv): Promise<{ mpeg2: boolean; vc1: boolean }> {
  const stored = readStoredWasmSpeed(env.storage, env.moduleUrl);
  if (stored) return wasmVideoPlayable(stored);
  let speed: VideoDecoderSpeed | null = null;
  try {
    speed = await env.probe();
  } catch {
    speed = null;
  }
  if (speed) {
    try {
      env.storage()?.setItem(WASM_VIDEO_SPEED_KEY, JSON.stringify({ moduleUrl: env.moduleUrl, mpeg2Fps: speed.mpeg2Fps, vc1Fps: speed.vc1Fps }));
    } catch {
      // private mode: the result still counts for this page
    }
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

function readCachedSpeed(env: Pick<VideoCapsEnv, 'cachedWasmSpeed'>): { mpeg2Fps: number; vc1Fps: number } | null {
  try {
    return env.cachedWasmSpeed?.() ?? null;
  } catch {
    return null;
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
    ...wasmVideoPlayable(readCachedSpeed(env)),
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
    cachedWasmSpeed: () => readStoredWasmSpeed(browserStorage, videoWasmUrl),
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
    return { hevc: false, hevc10: false, hdrDisplay: false, phone, mpeg2: false, vc1: false };
  }
}

let cached: Promise<VideoCaps> | null = null;

/** One probe per page; it never rejects. */
export function videoCaps(): Promise<VideoCaps> {
  cached ??= loadVideoCaps(browserVideoCapsEnv, browserMemoryProfile);
  return cached;
}

let wasmPlayability: Promise<{ mpeg2: boolean; vc1: boolean }> | null = null;

/**
 * Which of MPEG-2 and VC-1 play through the WASM decoder on this device: the stored speed for this build's module, else
 * `probe` (the controller's probeVideoDecoder) runs once, at most once per page load, and its answer is stored. Never
 * rejects; a failed probe says neither plays.
 */
export function wasmVideoPlayability(probe: () => Promise<VideoDecoderSpeed | null>): Promise<{ mpeg2: boolean; vc1: boolean }> {
  wasmPlayability ??= measureWasmVideo({ moduleUrl: videoWasmUrl, storage: browserStorage, probe });
  return wasmPlayability;
}
