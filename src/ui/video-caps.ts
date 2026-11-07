import type { MemoryProfileName } from '@seikou/engine/memory-profile';
import { chooseMemoryProfile } from './memory-profile';

export interface VideoCaps {
  hevc: boolean;
  hevc10: boolean;
  hdrDisplay: boolean;
  phone: boolean;
}

export interface VideoCapsEnv {
  isConfigSupported?: (c: { codec: string; codedWidth: number; codedHeight: number }) => Promise<{ supported?: boolean }>;
  matchMedia: (q: string) => { matches: boolean };
  screen: { width: number; height: number };
  memoryProfile: 'desktop' | 'constrained';
}

const HEVC_MAIN = 'hvc1.1.6.L120.90';
const HEVC_MAIN10 = 'hvc1.2.4.L120.90';
/** Phones are 320-440 CSS px on the shorter side; laptops start well above this. */
const PHONE_SHORT_SIDE = 600;

async function probe(env: VideoCapsEnv, codec: string): Promise<boolean> {
  if (!env.isConfigSupported) return false;
  try {
    return (await env.isConfigSupported({ codec, codedWidth: 1920, codedHeight: 1080 })).supported === true;
  } catch {
    return false;
  }
}

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
