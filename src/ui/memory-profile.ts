import type { MemoryProfileName } from '@seikou/engine/memory-profile';

export interface MemoryProfileEnv {
  readonly search: string;
  readonly coarsePointer: boolean;
  readonly maxTouchPoints: number;
  readonly platform: string;
}

/** `?memory=desktop|constrained` wins. Otherwise touch devices are constrained; iPadOS reports a Mac, so it is told apart by its touch points (the one place the platform string is read). */
export function chooseMemoryProfile(env: MemoryProfileEnv): MemoryProfileName {
  const forced = new URLSearchParams(env.search).get('memory');
  if (forced === 'desktop' || forced === 'constrained') return forced;
  if (env.coarsePointer || (env.maxTouchPoints > 1 && env.platform === 'MacIntel')) return 'constrained';
  return 'desktop';
}
