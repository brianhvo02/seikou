// SPDX-License-Identifier: LGPL-3.0-or-later
import type { ElementPreference, ElementPreferenceReason } from '@seikou/engine';

/**
 * How the system can show the page's `<video>` itself: Picture in Picture (`pip`) or the video's own fullscreen
 * (`fullscreen`, WebKit's `webkitEnterFullscreen`, for a browser whose page elements can't go fullscreen).
 */
export type PresentationMode = 'pip' | 'fullscreen';

/** Which Picture in Picture API the browser has: the standard one, or WebKit's presentation mode. */
export type PipApi = 'standard' | 'webkit';

/** The parts of an `HTMLVideoElement` the presentation uses, so tests can fake it. */
export interface PresentableVideo {
  readonly readyState: number;
  requestPictureInPicture?(): Promise<unknown>;
  webkitSetPresentationMode?(mode: string): void;
  readonly webkitPresentationMode?: string;
  webkitEnterFullscreen?(): void;
  webkitExitFullscreen?(): void;
  readonly webkitDisplayingFullscreen?: boolean;
}

/** The parts of `Document` the presentation uses. */
export interface PresentableDocument {
  readonly pictureInPictureElement?: unknown;
  exitPictureInPicture?(): Promise<void>;
}

/**
 * The Picture in Picture API the globals `g` offer, or null: the standard one when `document.pictureInPictureEnabled`
 * is true (Chrome, Safari), else WebKit's presentation mode when video elements have it (older Safari). Firefox has
 * neither (its own toggle is the browser's).
 */
export function pipApi(g: Record<string, unknown> = globalThis as unknown as Record<string, unknown>): PipApi | null {
  const doc = g.document as { pictureInPictureEnabled?: unknown } | undefined;
  if (doc?.pictureInPictureEnabled === true) return 'standard';
  const proto = (g.HTMLVideoElement as { prototype?: object } | undefined)?.prototype;
  if (proto && 'webkitSetPresentationMode' in proto) return 'webkit';
  return null;
}

/** Whether video elements have WebKit's own fullscreen (`webkitEnterFullscreen`: Safari on iPhone, iPad and Mac). */
export function hasVideoFullscreen(g: Record<string, unknown> = globalThis as unknown as Record<string, unknown>): boolean {
  const proto = (g.HTMLVideoElement as { prototype?: object } | undefined)?.prototype;
  return proto !== undefined && 'webkitEnterFullscreen' in proto;
}

/** How the system shows `video` now: in Picture in Picture, in its own fullscreen, or not at all (null). */
export function presentedAs(video: PresentableVideo, doc: PresentableDocument): PresentationMode | null {
  if (doc.pictureInPictureElement === video || video.webkitPresentationMode === 'picture-in-picture') return 'pip';
  if (video.webkitDisplayingFullscreen === true || video.webkitPresentationMode === 'fullscreen') return 'fullscreen';
  return null;
}

/** Asks the system to show `video` in `mode`; rejects when the browser refuses (no user activation, no picture yet). */
export async function enterPresentation(mode: PresentationMode, video: PresentableVideo, api: PipApi | null): Promise<void> {
  if (mode === 'fullscreen') {
    if (!video.webkitEnterFullscreen) throw new Error('This browser has no video fullscreen.');
    video.webkitEnterFullscreen();
    return;
  }
  if (api === 'standard' && video.requestPictureInPicture) {
    await video.requestPictureInPicture();
    return;
  }
  if (video.webkitSetPresentationMode) {
    video.webkitSetPresentationMode('picture-in-picture');
    return;
  }
  throw new Error('This browser has no Picture in Picture.');
}

/** Ends whatever presentation shows `video` (no user activation needed); nothing when it isn't presented. */
export function exitPresentation(video: PresentableVideo, doc: PresentableDocument): void {
  const mode = presentedAs(video, doc);
  try {
    if (mode === 'pip') {
      if (doc.pictureInPictureElement === video && doc.exitPictureInPicture) void doc.exitPictureInPicture().catch(() => undefined);
      else video.webkitSetPresentationMode?.('inline');
    } else if (mode === 'fullscreen') {
      if (video.webkitExitFullscreen) video.webkitExitFullscreen();
      else video.webkitSetPresentationMode?.('inline');
    }
  } catch {
    // already leaving
  }
}

/** What a tap on Picture in Picture or video fullscreen came to. */
export type PresentResult =
  | { readonly kind: 'entered' }
  /** The playlist moved to the element path after the browser's activation ran out: one more tap enters. */
  | { readonly kind: 'again' }
  | { readonly kind: 'unavailable'; readonly reason: ElementPreferenceReason | 'no-picture' }
  | { readonly kind: 'failed'; readonly message: string };

/** What {@link present} needs from the player and the page. */
export interface PresentDeps {
  /** Whether the element path shows the playing playlist now (`snapshot.videoElement`, with the element's metadata loaded). */
  elementReady(): boolean;
  /** The controller's preferElement. */
  preferElement(): Promise<ElementPreference>;
  /** Resolves true once elementReady(), false after `timeoutMs`. */
  waitForElement(timeoutMs: number): Promise<boolean>;
  /** enterPresentation for the mode. */
  enter(): Promise<void>;
}

/** How long a tap waits for the element path to show a playlist it moved there. */
export const PRESENT_WAIT_MS = 8000;

function errorText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/**
 * A tap on Picture in Picture or video fullscreen: on the element path it enters at once; on the canvas it asks the
 * engine to move the playlist to the element path, waits for the element to show it, and tries to enter, which the
 * browser refuses once the tap's activation has run out (about a second in Safari on iPhone): then `again`, and the
 * next tap enters at once.
 */
export async function present(deps: PresentDeps): Promise<PresentResult> {
  if (deps.elementReady()) {
    try {
      await deps.enter();
      return { kind: 'entered' };
    } catch (e) {
      return { kind: 'failed', message: errorText(e) };
    }
  }
  const preference = await deps.preferElement();
  if (preference.outcome === 'unavailable') return { kind: 'unavailable', reason: preference.reason };
  if (!(await deps.waitForElement(PRESENT_WAIT_MS))) return { kind: 'unavailable', reason: 'no-picture' };
  try {
    await deps.enter();
    return { kind: 'entered' };
  } catch {
    return { kind: 'again' };
  }
}

/** The notice for a tap that didn't enter, or null for one that did. */
export function presentMessage(mode: PresentationMode, result: PresentResult): string | null {
  const what = mode === 'pip' ? 'Picture in Picture' : 'Fullscreen';
  switch (result.kind) {
    case 'entered':
      return null;
    case 'again':
      return `${what} is ready: tap ${what} again.`;
    case 'failed':
      return `${what} didn't start: ${result.message}`;
    case 'unavailable':
      return `${what} isn't available for this video: ${unavailableReason(result.reason)}`;
  }
}

function unavailableReason(reason: ElementPreferenceReason | 'no-picture'): string {
  switch (reason) {
    case 'no-playlist':
      return 'nothing is playing.';
    case 'canvas':
      return 'Video output is set to Canvas.';
    case 'codec':
      return 'it needs H.264 or HEVC video, and this disc’s video is drawn by the player itself.';
    case 'encode':
      return 'encoded episodes are drawn by the player itself.';
    case 'shaders':
      return 'turn the video shaders off first.';
    case 'element-failed':
      return 'this browser couldn’t play this disc’s video in a video element.';
    case 'refused':
    case 'no-picture':
      return 'this browser can’t play this video in a video element.';
    case 'no-element':
      return 'the player has no video element.';
  }
}

/** The notice shown once per disc when Picture in Picture starts while subtitles show or a menu is up. */
export const PIP_OVERLAYS_MESSAGE = 'Subtitles and disc menus don’t show in Picture in Picture; they stay on the page.';

/** Resolves true once `check()` holds (looked at every `intervalMs`), false after `timeoutMs`. */
export function pollUntil(check: () => boolean, timeoutMs: number, intervalMs = 50): Promise<boolean> {
  return new Promise((resolve) => {
    if (check()) {
      resolve(true);
      return;
    }
    const started = Date.now();
    const id = setInterval(() => {
      if (check()) {
        clearInterval(id);
        resolve(true);
      } else if (Date.now() - started >= timeoutMs) {
        clearInterval(id);
        resolve(false);
      }
    }, intervalMs);
  });
}

/** How long the element path may stay off while presented before the presentation ends (a playlist change reopens it). */
export const PRESENTATION_GRACE_MS = 1500;
