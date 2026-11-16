import { expect, type Page } from '@playwright/test';

/** Widens both sync bounds on slow machines (e.g. SYNC_TOLERANCE_SCALE=2 on CI); the default keeps them tight. */
const SYNC_SCALE = Number(process.env.SYNC_TOLERANCE_SCALE ?? 1);
if (!(SYNC_SCALE >= 1)) throw new Error(`SYNC_TOLERANCE_SCALE must be a number >= 1, got ${process.env.SYNC_TOLERANCE_SCALE}`);
export const SYNC_TOLERANCE_US = 20_000 * SYNC_SCALE;
export const MAX_ABS_TOLERANCE_US = 50_000 * SYNC_SCALE;

/** Widens the share of ASS draws allowed over the engine's 8 ms budget on machines without a GPU (e.g. ASS_BUDGET_SCALE=8 on CI); the default keeps the spec's 5%. */
const ASS_BUDGET_SCALE = Number(process.env.ASS_BUDGET_SCALE ?? 1);
if (!(ASS_BUDGET_SCALE >= 1)) throw new Error(`ASS_BUDGET_SCALE must be a number >= 1, got ${process.env.ASS_BUDGET_SCALE}`);
export const ASS_OVER_BUDGET_SHARE = Math.min(1, 0.05 * ASS_BUDGET_SCALE);

export interface TelemetrySample {
  clockUs: number;
  clockMode: string;
  /** How video is presented: 'element' (a <video> element fed by MSE), 'canvas' (WebCodecs onto the canvas), null with no session. */
  videoPath?: 'canvas' | 'element' | null;
  /** On the element path, the catch-ups the page has run since its media source opened. */
  elementCatchUps?: number;
  /** Why the video element failed on this disc (the disc then plays on the canvas); null while it hasn't. */
  elementFailure?: string | null;
  /** An HDR stream plays on the element path. */
  videoHdr?: boolean;
  avOffsetMeanUs: number | null;
  avOffsetMaxAbsUs: number | null;
  framesInWindow: number;
  framesPresented?: number;
  decoderErrors?: number;
  openGopStarts?: number;
  leadingPicturesSkipped?: number;
  audioUnderruns?: number;
  audioCodec?: string | null;
  audioDecodeErrors?: number;
}

export async function telemetry(page: Page): Promise<TelemetrySample | null> {
  return page.evaluate(() => (window as unknown as { __blurayTelemetry?: TelemetrySample | null }).__blurayTelemetry ?? null);
}

type SampleLog = { __telemetrySamples?: TelemetrySample[] };

/**
 * Records every telemetry sample the page receives (call before page.goto). The latest sample can be up to one 500 ms
 * interval old, so right after a pause or a seek it may still be one taken before it.
 */
export async function recordTelemetrySamples(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const w = window as unknown as SampleLog & { __blurayTelemetry?: TelemetrySample | null };
    const samples: TelemetrySample[] = [];
    let latest: TelemetrySample | null = null;
    w.__telemetrySamples = samples;
    Object.defineProperty(w, '__blurayTelemetry', {
      configurable: true,
      get: () => latest,
      set: (t: TelemetrySample | null) => {
        if (t && t !== latest) samples.push(t);
        latest = t;
      },
    });
  });
}

/** The samples recorded so far (recordTelemetrySamples), from index `start` on. */
export const telemetrySamples = (page: Page, start = 0): Promise<TelemetrySample[]> =>
  page.evaluate((i) => ((window as unknown as SampleLog).__telemetrySamples ?? []).slice(i), start);

/**
 * The clock where playback stopped, once the page is paused (recordTelemetrySamples): the first two consecutive samples
 * from index `start` on with the same clock, i.e. both taken while paused. A sample taken while playing differs from the next.
 */
export async function pausedClockUs(page: Page, start: number): Promise<number> {
  let paused: number | null = null;
  await expect
    .poll(async () => {
      const samples = await telemetrySamples(page, start);
      const i = samples.findIndex((t, k) => k > 0 && t.clockUs === samples[k - 1]!.clockUs);
      paused = i > 0 ? samples[i]!.clockUs : null;
      return paused;
    }, { timeout: 5_000, intervals: [50] })
    .not.toBeNull();
  return paused!;
}

/** Telemetry windows that presented frames, polled until the clock passes `untilUs`. */
export async function collectWindows(page: Page, untilUs: number, deadlineMs = 20_000): Promise<TelemetrySample[]> {
  const windows: TelemetrySample[] = [];
  let lastClock = -1;
  const deadline = Date.now() + deadlineMs;
  for (;;) {
    const t = await telemetry(page);
    if (t && t.clockUs !== lastClock) {
      lastClock = t.clockUs;
      if (t.framesInWindow > 0) windows.push(t);
      if (t.clockUs >= untilUs) return windows;
    }
    if (Date.now() > deadline) throw new Error(`clock stalled at ${lastClock} us (wanted ${untilUs} us)`);
    await page.waitForTimeout(250);
  }
}

/** Every window must report real offsets (null is not zero) within the mean and jitter bounds. */
export function expectInSync(windows: TelemetrySample[]): void {
  let worstMean = 0;
  let worstMax = 0;
  for (const w of windows) {
    expect(w.avOffsetMeanUs).not.toBeNull();
    expect(w.avOffsetMaxAbsUs).not.toBeNull();
    expect(Math.abs(w.avOffsetMeanUs as number)).toBeLessThanOrEqual(SYNC_TOLERANCE_US);
    expect(w.avOffsetMaxAbsUs as number).toBeLessThanOrEqual(MAX_ABS_TOLERANCE_US);
    worstMean = Math.max(worstMean, Math.abs(w.avOffsetMeanUs as number));
    worstMax = Math.max(worstMax, w.avOffsetMaxAbsUs as number);
  }
  console.log(`sync stats: windows=${windows.length} worst|mean|=${worstMean}us worstMaxAbs=${worstMax}us (bounds ${SYNC_TOLERANCE_US}/${MAX_ABS_TOLERANCE_US}us)`);
}

/** Telemetry's BD-J start-up times (ms since the open command), or null when no BD-J title has run. */
export interface BdjStartupSample { bootMs: number | null; firstPlaylistMs: number | null; firstFrameMs: number | null }

export async function bdjStartup(page: Page): Promise<BdjStartupSample | null> {
  return page.evaluate(() => (window as unknown as { __blurayTelemetry?: { bdj?: BdjStartupSample | null } | null }).__blurayTelemetry?.bdj ?? null);
}
