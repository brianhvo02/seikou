import type { MemoryProfileName } from '@seikou/engine/memory-profile';
import { chooseMemoryProfile } from './memory-profile';

/** What this device can play and show, used to pick and enable quality levels. */
export interface VideoCaps {
  /** WebCodecs decodes HEVC Main (8-bit) at 1080p. */
  hevc: boolean;
  /** WebCodecs decodes HEVC Main 10. */
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
  matchMedia: (q: string) => { matches: boolean };
  /** The screen size in CSS px. */
  screen: { width: number; height: number };
  /** The memory profile in force. */
  memoryProfile: 'desktop' | 'constrained';
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

/** Probes the device once: HEVC Main and Main 10 through `isConfigSupported` (false for a probe that throws or is missing), the display's dynamic range and the phone test. */
export async function detectVideoCaps(env: VideoCapsEnv): Promise<VideoCaps> {
  const [hevc, hevc10] = await Promise.all([probe(env, HEVC_MAIN), probe(env, HEVC_MAIN10)]);
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

/** The real browser's `VideoCapsEnv`. */
export function browserVideoCapsEnv(): VideoCapsEnv {
  return {
    isConfigSupported: typeof VideoDecoder !== 'undefined' && typeof VideoDecoder.isConfigSupported === 'function'
      ? (c) => VideoDecoder.isConfigSupported(c)
      : undefined,
    matchMedia: (q) => window.matchMedia(q),
    screen: { width: window.screen.width, height: window.screen.height },
    memoryProfile: browserMemoryProfile(),
  };
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
