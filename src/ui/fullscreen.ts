/** Which fullscreen API the page uses: the standard one or the WebKit-prefixed one. */
export type FullscreenKind = 'standard' | 'webkit';

interface WebkitDocument {
  webkitFullscreenElement?: Element | null;
  webkitExitFullscreen?(): void;
}
interface WebkitElement {
  webkitRequestFullscreen?(): void;
}

/** Enters or leaves fullscreen with the standard API, or the WebKit-prefixed one (Safari on macOS and iPadOS). */
export function toggleFullscreen(doc: Document, element: HTMLElement, kind: FullscreenKind): void {
  if (kind === 'webkit') {
    const d = doc as unknown as WebkitDocument;
    if (d.webkitFullscreenElement) d.webkitExitFullscreen?.();
    else (element as unknown as WebkitElement).webkitRequestFullscreen?.();
    return;
  }
  if (doc.fullscreenElement) void doc.exitFullscreen();
  else void element.requestFullscreen();
}

/** `localStorage` key (a kept `bluray-web` name) that remembers the hint was dismissed. */
export const FULLSCREEN_HINT_KEY = 'bluray-web.fullscreen-hint-dismissed';
/** The hint shown on a touch device whose browser has no fullscreen API. */
export const FULLSCREEN_HINT_TEXT = 'Add to Home Screen to watch fullscreen.';

/** What decides whether the Add to Home Screen hint shows. */
export interface FullscreenHintInput {
  readonly fullscreen: FullscreenKind | null;
  readonly coarsePointer: boolean;
  readonly standalone: boolean;
  readonly dismissed: boolean;
}

/** The hint shows only where there is no fullscreen API, on a touch device, outside an installed app, until dismissed. */
export function shouldShowFullscreenHint({ fullscreen, coarsePointer, standalone, dismissed }: FullscreenHintInput): boolean {
  return fullscreen === null && coarsePointer && !standalone && !dismissed;
}

/** The part of `Storage` the hint uses. */
export interface HintStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

/** Storage can throw in private modes; then the hint simply shows again next time. */
export function isFullscreenHintDismissed(storage: HintStorage): boolean {
  try {
    return storage.getItem(FULLSCREEN_HINT_KEY) !== null;
  } catch {
    return false;
  }
}

/** Remembers the dismissal; a storage that throws is ignored. */
export function markFullscreenHintDismissed(storage: HintStorage): void {
  try {
    storage.setItem(FULLSCREEN_HINT_KEY, '1');
  } catch {
    // ignored
  }
}

/** `window.localStorage` itself throws SecurityError in some modes. */
export function safeLocalStorage(win: { readonly localStorage: HintStorage } = window): HintStorage | null {
  try {
    return win.localStorage;
  } catch {
    return null;
  }
}

/** The parts of `window` `evaluateFullscreenHint` reads. */
export interface HintEnvironment {
  matchMedia(query: string): { readonly matches: boolean };
  readonly localStorage: HintStorage;
}

/**
 * Whether to show the hint now. Unusable storage counts as "not dismissed" (the hint shows again next time); a missing or
 * throwing matchMedia means we can't tell the device, so no hint.
 */
export function evaluateFullscreenHint(fullscreen: FullscreenKind | null, win: HintEnvironment = window): boolean {
  let coarsePointer: boolean;
  let standalone: boolean;
  try {
    coarsePointer = win.matchMedia('(pointer: coarse)').matches;
    standalone = win.matchMedia('(display-mode: standalone)').matches;
  } catch {
    return false;
  }
  const storage = safeLocalStorage(win);
  const dismissed = storage !== null && isFullscreenHintDismissed(storage);
  return shouldShowFullscreenHint({ fullscreen, coarsePointer, standalone, dismissed });
}
