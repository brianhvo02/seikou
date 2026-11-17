// SPDX-License-Identifier: LGPL-3.0-or-later
import type { DeinterlaceMode, VideoPath } from '@seikou/engine/protocol';

/** `localStorage` key (a kept `bluray-web` name) of the device's Video output choice. */
export const VIDEO_OUTPUT_KEY = 'bluray-web:video-output';

/** The Video output options with the words the menu shows. */
export const VIDEO_OUTPUT_OPTIONS: readonly { readonly path: VideoPath; readonly label: string }[] = [
  { path: 'auto', label: "Auto (HDR through the browser's video player)" },
  { path: 'element', label: 'Always the video player' },
  { path: 'canvas', label: 'Always the canvas' },
];

function isVideoPath(v: string | null | undefined): v is VideoPath {
  return v === 'auto' || v === 'element' || v === 'canvas';
}

/** What `VideoOutputSetting` reads from the page, injectable for tests. */
export interface VideoOutputDeps {
  /** `localStorage`, or null when it is unavailable (it can throw in some privacy modes). */
  readonly storage: () => Storage | null;
  /** The page's query: `?videopath=element|canvas|auto` overrides the saved choice for the page's life. */
  readonly params: URLSearchParams;
}

/**
 * The device's Video output choice as a small store (for `useSyncExternalStore`): the saved choice, else `auto` (HDR
 * streams through the page's video element, the rest on the canvas). A `?videopath=` flag stands in for the saved choice
 * without saving; a pick in the menu replaces it and is saved.
 */
export class VideoOutputSetting {
  private value: VideoPath;
  private readonly listeners = new Set<() => void>();

  /** Reads the flag, else the saved choice. */
  constructor(private readonly deps: VideoOutputDeps) {
    const flag = deps.params.get('videopath');
    this.value = isVideoPath(flag) ? flag : this.saved();
  }

  /** The choice in force. */
  get = (): VideoPath => this.value;

  /** Makes `path` the choice and saves it; a storage that fails still lets it hold for this page. */
  choose(path: VideoPath): void {
    this.value = path;
    try {
      this.deps.storage()?.setItem(VIDEO_OUTPUT_KEY, path);
    } catch {
      // not saved: the choice holds until the page closes
    }
    for (const l of [...this.listeners]) l();
  }

  /** Calls `listener` after each `choose`; returns the function that stops it. */
  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => void this.listeners.delete(listener);
  };

  private saved(): VideoPath {
    try {
      const v = this.deps.storage()?.getItem(VIDEO_OUTPUT_KEY);
      return isVideoPath(v) ? v : 'auto';
    } catch {
      return 'auto';
    }
  }
}

let shared: VideoOutputSetting | null = null;

/** The page's one setting, read from `localStorage` and `location.search` the first time it is asked for. */
export function videoOutputSetting(): VideoOutputSetting {
  shared ??= new VideoOutputSetting({
    storage: () => {
      try {
        return window.localStorage;
      } catch {
        return null;
      }
    },
    params: new URLSearchParams(location.search),
  });
  return shared;
}

/** The video path the app asks the engine for as it loads: the setting's. The engine's own default is the canvas, for hosts with no video element. */
export function initialVideoPath(setting: VideoOutputSetting = videoOutputSetting()): VideoPath {
  return setting.get();
}

/** `localStorage` key (a kept `bluray-web` name) of the device's Deinterlacing choice. */
export const DEINTERLACE_KEY = 'bluray-web:deinterlace';

/** The Deinterlacing options with the words the menu shows. */
export const DEINTERLACE_OPTIONS: readonly { readonly mode: DeinterlaceMode; readonly label: string }[] = [
  { mode: 'auto', label: 'Auto' },
  { mode: 'off', label: 'Off' },
];

function isDeinterlaceMode(v: string | null | undefined): v is DeinterlaceMode {
  return v === 'auto' || v === 'off';
}

/** What `DeinterlaceSetting` reads from the page, injectable for tests. */
export interface DeinterlaceDeps {
  /** `localStorage`, or null when it is unavailable (it can throw in some privacy modes). */
  readonly storage: () => Storage | null;
}

/** The device's Deinterlacing choice as a small store (for `useSyncExternalStore`): the saved choice, else `auto`. */
export class DeinterlaceSetting {
  private value: DeinterlaceMode;
  private readonly listeners = new Set<() => void>();

  /** Reads the saved choice. */
  constructor(private readonly deps: DeinterlaceDeps) {
    this.value = this.saved();
  }

  /** The choice in force. */
  get = (): DeinterlaceMode => this.value;

  /** Makes `mode` the choice and saves it; a storage that fails still lets it hold for this page. */
  choose(mode: DeinterlaceMode): void {
    this.value = mode;
    try {
      this.deps.storage()?.setItem(DEINTERLACE_KEY, mode);
    } catch {
      // not saved: the choice holds until the page closes
    }
    for (const l of [...this.listeners]) l();
  }

  /** Calls `listener` after each `choose`; returns the function that stops it. */
  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => void this.listeners.delete(listener);
  };

  private saved(): DeinterlaceMode {
    try {
      const v = this.deps.storage()?.getItem(DEINTERLACE_KEY);
      return isDeinterlaceMode(v) ? v : 'auto';
    } catch {
      return 'auto';
    }
  }
}

let sharedDeinterlace: DeinterlaceSetting | null = null;

/** The page's one deinterlacing setting, read from `localStorage` the first time it is asked for. */
export function deinterlaceSetting(): DeinterlaceSetting {
  sharedDeinterlace ??= new DeinterlaceSetting({
    storage: () => {
      try {
        return window.localStorage;
      } catch {
        return null;
      }
    },
  });
  return sharedDeinterlace;
}
