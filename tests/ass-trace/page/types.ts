/** What tests/ass-trace/page exposes on window.assTrace for the Playwright specs. */
export interface AssTraceRun {
  /** Our layout in the trace format (formatTrace), all times. */
  readonly trace: string;
  /** Per time, when pixels were asked for: the 1920×1080 frame as base64 RGBA on #808080. */
  readonly frames: readonly string[];
  readonly missingFamilies: readonly string[];
  /** Per time with pixels: AssRenderer's draw time (ms) and whether an animated event was on screen. */
  readonly renderMs: readonly { readonly ms: number; readonly animated: boolean }[];
}

export interface AssTracePage {
  run(scriptUrl: string, fontUrls: readonly string[], times: readonly number[], pixels: boolean, storage: readonly [number, number] | null): Promise<AssTraceRun>;
}

/** One compared frame of a session step: libass's golden against ours. `actual` (base64 RGBA) only for failures. */
export interface FrameResult { readonly t: number; readonly differing: number; readonly budget: number; readonly pass: boolean; readonly actual?: string }

/** A long script compared in steps (window.assSession): layout and collision memory carry over between steps. */
export interface AssSessionPage {
  open(scriptUrl: string, fontUrls: readonly string[], storage: readonly [number, number] | null): Promise<{ readonly missingFamilies: readonly string[] }>;
  /**
   * Lays out and draws `times`; when `goldenBase` is given, compares each frame with `${goldenBase}/${t}.png` using
   * `boxes[t]` for the budget, skipping the times in `skip`.
   */
  step(times: readonly number[], goldenBase: string | null, boxes: Readonly<Record<number, readonly (readonly [number, number, number, number])[]>>, skip: readonly number[]): Promise<{
    readonly trace: string;
    readonly results: readonly FrameResult[];
    readonly renderMs: readonly { readonly t: number; readonly ms: number; readonly animated: boolean }[];
  }>;
}

/** What the device-font worker reports for one family (window.deviceCheck.inWorker). */
export interface DeviceWorkerResult {
  /** The default font drew the family (no supplied or installed face). */
  readonly fallback: boolean;
  readonly missingFamilies: readonly string[];
  /** Width of the test line at 100px in the face chosen, and in DejaVu Sans. */
  readonly advance: number;
  readonly defaultAdvance: number;
  readonly ascender: number;
  readonly descender: number;
}

export interface DeviceCheckPage {
  /** Whether `local(family)` loads on the page itself (the device has the font and the browser allows it). */
  localOnPage(family: string): Promise<boolean>;
  inWorker(family: string): Promise<DeviceWorkerResult>;
}
