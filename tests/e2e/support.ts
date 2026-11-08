import { expect, test, type ElementHandle, type Locator, type Page } from '@playwright/test';

/** Why a test runs in desktop Chrome only (the A/V sync bounds, audio output, shaders, ASS budgets and real discs are measured there). */
export const CHROME_ONLY = 'measured against desktop Chrome only (A/V sync, audio output, shaders, ASS budgets, real discs)';

/** Why tests that need real-time playback skip in WebKit on Linux: on CI it misses timing windows run after run. */
export const LINUX_WEBKIT_REALTIME = "Linux WebKit (CI, no GPU) can't sustain real-time playback; real Safari is covered by the device test";

/** True in WebKit on Linux, where tests that need real-time playback skip (LINUX_WEBKIT_REALTIME). */
export const isLinuxWebKit = (browserName: string): boolean => browserName === 'webkit' && process.platform === 'linux';

/**
 * Skips the running test in Firefox or WebKit when the browser reports no H.264 WebCodecs decoder, and in WebKit on
 * Linux unless `realtime` is false (the test only needs playback to start). Call it with the app loaded, before
 * decoding starts.
 */
export async function skipWithoutH264(page: Page, { realtime = true }: { realtime?: boolean } = {}): Promise<void> {
  const browser = page.context().browser()?.browserType().name();
  if (browser !== 'firefox' && browser !== 'webkit') return;
  test.skip(realtime && isLinuxWebKit(browser), LINUX_WEBKIT_REALTIME);
  const supported = await page.evaluate(() =>
    typeof VideoDecoder === 'undefined'
      ? false
      : VideoDecoder.isConfigSupported({ codec: 'avc1.640028' }).then((s) => s.supported === true).catch(() => false),
  );
  test.skip(!supported, `no H.264 WebCodecs in this ${browser === 'firefox' ? 'Firefox' : 'WebKit'} build`);
}

/** The control bar is hidden: its class within `timeout`, then drawn fully transparent once its 0.2 s fade has run. */
export async function expectBarHidden(bar: Locator, timeout = 5_000): Promise<void> {
  await expect(bar).toHaveClass(/hidden/, { timeout });
  await expect(bar).toHaveCSS('opacity', '0');
}

/** The control bar is shown: its class within `timeout`, then drawn opaque once its 0.2 s fade has run. */
export async function expectBarShown(bar: Locator, timeout = 5_000): Promise<void> {
  await expect(bar).not.toHaveClass(/hidden/, { timeout });
  await expect(bar).toHaveCSS('opacity', '1');
}

/** Page coordinates of a point in the 1920x1080 menu, letterboxed in the canvas as the compositor draws it. */
export async function menuPoint(page: Page, x: number, y: number): Promise<{ x: number; y: number }> {
  const box = (await page.getByTestId('video-canvas').boundingBox())!;
  const scale = Math.min(box.width / 1920, box.height / 1080);
  const width = Math.round(1920 * scale);
  const height = Math.round(1080 * scale);
  const left = box.x + Math.floor((box.width - width) / 2);
  const top = box.y + Math.floor((box.height - height) / 2);
  return { x: left + ((x + 0.5) * width) / 1920, y: top + ((y + 0.5) * height) / 1080 };
}

/**
 * Sets a folder on a `webkitdirectory` input (a locator, or a file chooser's element) and returns once the input has
 * fired its `input` event. Use it instead of setInputFiles(folder) and FileChooser.setFiles(folder).
 *
 * Playwright 1.64's setInputFiles(folder) sends the files first and attaches its listener for that event after, then
 * waits for it with no timeout of its own. Firefox reads the folder off the main thread and can fire the event before
 * the listener is in place; the call then hangs until the test times out (CI run 39082456589: the disc played to its
 * end while setInputFiles was still pending). Playwright 1.65 attaches its listener first; this does the same from
 * outside, so the event is seen whether or not Playwright's call ever returns. Drop it once Playwright is at 1.65.
 *
 * Chrome 157 suppresses the file chooser of a window smaller than 400x300 ("File chooser dialog was suppressed because
 * the top-level window size is smaller than the minimum required size"), and Playwright sets a folder in Chromium
 * through that chooser, so at a 390x844 viewport nothing is set and no event fires (CI run 42464130005, Linux; macOS
 * Chrome 157 lets 390 wide through). The viewport is widened to at least 400x300 while the folder is set and put back
 * after, before the page has done more than start opening the disc.
 */
export async function setFolder(target: Locator | ElementHandle, folder: string): Promise<void> {
  const input = 'elementHandle' in target ? await target.elementHandle() : target;
  const page = 'elementHandle' in target ? target.page() : (await target.ownerFrame())?.page();
  const viewport = page?.viewportSize() ?? null;
  const restore = page && viewport && (viewport.width < MIN_CHOOSER_WINDOW.width || viewport.height < MIN_CHOOSER_WINDOW.height)
    ? () => page.setViewportSize(viewport)
    : null;
  const fired = await input.evaluateHandle((el) => ({
    promise: new Promise<void>((resolve) => el.addEventListener('input', () => resolve(), { once: true })),
  }));
  if (page && viewport && restore) {
    await page.setViewportSize({ width: Math.max(viewport.width, MIN_CHOOSER_WINDOW.width), height: Math.max(viewport.height, MIN_CHOOSER_WINDOW.height) });
  }
  try {
    const set = input.setInputFiles(folder);
    set.catch(() => undefined); // left pending when Playwright missed the event: it settles when the page closes
    const event = fired.evaluate((f) => f.promise);
    event.catch(() => undefined); // only raced: disposing the handle below may cut it short
    await Promise.race([set, event]);
  } finally {
    await fired.dispose();
    if (restore) await restore();
  }
}

/** The smallest window Chrome (157 and later) shows a file chooser in. */
const MIN_CHOOSER_WINDOW = { width: 400, height: 300 } as const;
