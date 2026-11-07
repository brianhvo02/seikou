import type { PlaybackState } from '@seikou/engine/protocol';

/**
 * Whether to offer the waiting service worker's new version. A reload would stop playback,
 * so the prompt waits until the engine is neither playing nor buffering.
 */
export function shouldPromptUpdate(state: { waiting: boolean; engineState: PlaybackState }): boolean {
  return state.waiting && state.engineState !== 'playing' && state.engineState !== 'buffering';
}

/** A new worker waits while it is `installed`; it stops waiting once it activates (here or in another tab) or fails. */
export function isWaitingWorker(state: ServiceWorkerState): boolean {
  return state === 'installed';
}

/**
 * What the Reload button does. A worker another tab already let take over has changed this page's controller,
 * so no `controllerchange` will follow: reload at once.
 */
export function reloadAction(state: ServiceWorkerState): 'reload' | 'skip-waiting' {
  return state === 'activating' || state === 'activated' ? 'reload' : 'skip-waiting';
}
