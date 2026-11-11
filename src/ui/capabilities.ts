import { bdjMissing } from '../bdj/requirements';

/** What this browser can do, from feature checks on its globals (never its user agent), for gating features and explaining what is missing. */
export interface CapabilityReport {
  readonly core: { readonly ok: boolean; readonly missing: readonly string[] };
  /**
   * What BD-J menus need (`bdjMissing` in `src/bdj/requirements.ts`), as far as the page can see: whether a worker may start workers
   * is known only inside the engine worker, which checks again before it runs BD-J and names what it lacks.
   */
  readonly bdj: { readonly ok: boolean; readonly missing: readonly string[] };
  /** showDirectoryPicker */
  readonly canPickDirectory: boolean;
  /** webkitdirectory on a file input */
  readonly canPickFolderInput: boolean;
  /** FileSystemHandle permissions (recent discs) */
  readonly canRememberDiscs: boolean;
  /** Which fullscreen API the document offers: the standard one, the WebKit-prefixed one, or none (iPhone Safari). */
  readonly fullscreen: 'standard' | 'webkit' | null;
  /** `navigator.audioSession` exists (Safari), so the page can mark its audio as playback. */
  readonly audioSession: boolean;
  /** The Screen Wake Lock API exists. */
  readonly wakeLock: boolean;
  /** The Media Session API exists (lock-screen and media-key controls). */
  readonly mediaSession: boolean;
}

type Bag = Record<string, unknown>;

function obj(v: unknown): Bag | undefined {
  return (typeof v === 'object' || typeof v === 'function') && v !== null ? (v as Bag) : undefined;
}

/**
 * Builds the capability report from `g`, the global scope (the real one by default; tests pass a stand-in). It only reads
 * properties and never throws. `core` lists what playback cannot start without; `bdj` what BD-J menus need on top.
 */
export function checkCapabilities(g: Bag = globalThis as unknown as Bag): CapabilityReport {
  const missing: string[] = [];
  if (!('VideoDecoder' in g)) missing.push('WebCodecs video decoding');
  if (!('AudioWorkletNode' in g)) missing.push('AudioWorklet');
  if (!('OffscreenCanvas' in g)) missing.push('OffscreenCanvas');
  if (!('SharedArrayBuffer' in g) || g.crossOriginIsolated !== true) missing.push('cross-origin isolation (SharedArrayBuffer)');

  const doc = obj(g.document);
  const fullscreen = doc?.fullscreenEnabled === true ? 'standard' : doc?.webkitFullscreenEnabled === true ? 'webkit' : null;
  const inputProto = obj(obj(g.HTMLInputElement)?.prototype);
  const handleProto = obj(obj(g.FileSystemHandle)?.prototype);
  const nav = obj(g.navigator);

  const bdj = bdjMissing(g);
  return {
    core: { ok: missing.length === 0, missing },
    bdj: { ok: bdj.length === 0, missing: bdj },
    canPickDirectory: typeof g.showDirectoryPicker === 'function',
    canPickFolderInput: inputProto !== undefined && 'webkitdirectory' in inputProto,
    canRememberDiscs: handleProto !== undefined && 'queryPermission' in handleProto,
    fullscreen,
    audioSession: nav !== undefined && 'audioSession' in nav,
    wakeLock: nav !== undefined && 'wakeLock' in nav,
    mediaSession: nav !== undefined && 'mediaSession' in nav,
  };
}

/**
 * Whether the landing screen warns that Safari clears site data after 7 days without a visit: only in a browser tab of a
 * browser without FileSystemHandle permissions (non-Chromium). An installed app (standalone) is exempt.
 */
export function showStorageHint(
  canRememberDiscs: boolean,
  win: { matchMedia(query: string): { readonly matches: boolean } } = window,
): boolean {
  if (canRememberDiscs) return false;
  try {
    return !win.matchMedia('(display-mode: standalone)').matches;
  } catch {
    return true;
  }
}
