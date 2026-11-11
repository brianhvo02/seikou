import type { MemoryProfileName } from '../memory-profile';
import type { Telemetry } from '../protocol';
import { AudioOutput } from './audio-output';
import { PlayerController } from './player-controller';

/** What `createController` needs from the host page. */
export interface CreateControllerOptions {
  /** Starts the engine worker: createEngineWorker, or a host's own entry that calls startEngineWorker. */
  readonly worker: () => Worker;
  /** The memory profile the engine runs under. */
  readonly profile: MemoryProfileName;
  /** Test-only (E2E): keep the latest telemetry on window.__blurayTelemetry. */
  readonly exposeTelemetry?: boolean;
}

/**
 * Builds a `PlayerController` on the main thread: starts the engine worker, creates the audio output, sends the memory
 * profile, and hooks `pagehide` and `visibilitychange` so the engine flushes a BD-J disc's saved data and learns when
 * the page is hidden. It touches `window` and `document`, so call it only in a page, once per player.
 * @example ../../examples/create-controller.browser.ts
 */
export function createController(options: CreateControllerOptions): PlayerController {
  const controller = new PlayerController(options.worker(), new AudioOutput());
  controller.setMemoryProfile(options.profile);
  // what a BD-J disc saved in its last seconds is stored before the page goes (iOS often skips pagehide: hidden too)
  addEventListener('pagehide', () => controller.flushSaves());
  controller.setVisibility(document.hidden);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') controller.flushSaves();
    controller.setVisibility(document.hidden);
  });
  if (options.exposeTelemetry) {
    const target = window as unknown as { __blurayTelemetry?: Telemetry | null };
    controller.subscribe(() => {
      target.__blurayTelemetry = controller.getSnapshot().telemetry;
    });
  }
  return controller;
}
