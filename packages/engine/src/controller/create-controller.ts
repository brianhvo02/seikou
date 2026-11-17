import type { MemoryProfileName } from '../memory-profile';
import type { EngineCommand, EngineEvent, Telemetry } from '../protocol';
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
  /** Test-only (E2E): every append to the video element's source buffer fails, so the element path falls back to the canvas. */
  readonly failElementAppends?: boolean;
}

/**
 * Builds a `PlayerController` on the main thread: starts the engine worker, creates the audio output, sends the memory
 * profile, and hooks `pagehide` and `visibilitychange` so the engine flushes a BD-J disc's saved data and learns when
 * the page is hidden. It touches `window` and `document`, so call it only in a page, once per player.
 * @example ../../examples/create-controller.browser.ts
 */
export function createController(options: CreateControllerOptions): PlayerController {
  const worker = options.worker();
  const controller = new PlayerController(worker, new AudioOutput(), options.failElementAppends ? { failElementAppends: true } : {});
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
    exposeVideoCapture(worker);
  }
  return controller;
}

/** The engine's answer to captureVideo, as window.__blurayCaptureVideo resolves it (test-only). */
type VideoCapture = Omit<Extract<EngineEvent, { type: 'videoCapture' }>, 'type'>;

/**
 * Test-only (E2E): window.__blurayCaptureVideo(atUs) asks the engine for the first video picture drawn at or after
 * playlist time `atUs` and resolves with it (captureVideo); a second call before the answer replaces the first.
 */
function exposeVideoCapture(worker: Worker): void {
  let waiting: ((capture: VideoCapture) => void) | null = null;
  worker.addEventListener('message', (event: MessageEvent<EngineEvent>) => {
    const e = event.data;
    if (e.type !== 'videoCapture' || !waiting) return;
    const { type: _, ...capture } = e;
    waiting(capture);
    waiting = null;
  });
  (window as unknown as { __blurayCaptureVideo?: (atUs: number) => Promise<VideoCapture> }).__blurayCaptureVideo = (atUs) =>
    new Promise((resolve) => {
      waiting = resolve;
      worker.postMessage({ type: 'captureVideo', atUs } satisfies EngineCommand);
    });
}
