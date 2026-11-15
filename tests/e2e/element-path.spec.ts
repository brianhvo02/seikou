// SPDX-License-Identifier: LGPL-3.0-or-later
import { expect, test, type Page } from '@playwright/test';
import { CHROME_ONLY, setFolder, skipWithoutH264 } from './support';
import { collectWindows, expectInSync, pausedClockUs, recordTelemetrySamples, telemetry, telemetrySamples, type TelemetrySample } from './telemetry';

/** The element plays at media time = playlist time + this (ELEMENT_TIME_OFFSET_US in the engine's element/fmp4.ts). */
const ELEMENT_TIME_OFFSET_S = 10;

const HEVC_MAIN10 = 'video/mp4; codecs="hvc1.2.4.L120.90"';

async function openDisc(page: Page, folder = 'fixtures/synthetic/disc1', query = '?telemetry=1&videopath=element'): Promise<void> {
  await page.goto(`/${query}`);
  await setFolder(page.getByTestId('folder-input'), folder);
  await expect(page.getByTestId('playlist-00000')).toBeVisible();
}

async function startPlaylist(page: Page, id = '00000'): Promise<void> {
  await page.getByTestId(`playlist-${id}`).click();
  await expect(page.getByTestId('player')).toHaveAttribute('data-state', 'playing', { timeout: 10_000 });
}

/** The page's video element, as the browser sees it: for the logs when a test fails, and for the paused-seek check. */
async function elementState(page: Page): Promise<Record<string, unknown>> {
  return page.getByTestId('video-element').evaluate((v: HTMLVideoElement) => {
    const ranges: [number, number][] = [];
    for (let i = 0; i < v.buffered.length; i++) ranges.push([v.buffered.start(i), v.buffered.end(i)]);
    const q = v.getVideoPlaybackQuality?.();
    return {
      readyState: v.readyState,
      currentTime: v.currentTime,
      playbackRate: v.playbackRate,
      paused: v.paused,
      seeking: v.seeking,
      ended: v.ended,
      buffered: ranges,
      error: v.error?.message ?? null,
      frames: q ? { total: q.totalVideoFrames, dropped: q.droppedVideoFrames } : null,
    };
  });
}

/**
 * Clicks Open folder (its picker cancelled, see the HDR test's init script) and waits until the audio output's worklet has
 * loaded: the engine gets the audio ring before a disc opened after this.
 */
async function startAudioAsOpenFolderDoes(page: Page): Promise<void> {
  await page.getByTestId('open-folder').click();
  await expect.poll(() => page.evaluate(() => (window as unknown as { __audioWorkletReady?: boolean }).__audioWorkletReady === true)).toBe(true);
}

/**
 * The windows after the first: sync settles within the second after a start (spec §5.5: the element starts a display
 * frame or more late, and the start catch-up removes it within about 0.2 s), and the canvas path's sync tests leave the
 * first window after a start out the same way (audio.spec.ts and local-discs.spec.ts, `windows.slice(1)`). The first
 * window still has to show element frames on the audio clock (expectElementWindows).
 */
function afterStart(windows: TelemetrySample[]): TelemetrySample[] {
  return windows.slice(1);
}

function expectElementWindows(windows: TelemetrySample[]): void {
  const w0 = windows[0];
  // each window's mean and max (ms), for reading a failure; and the catch-ups run so far
  console.log(`element windows: ${windows.map((w) => `${Math.round((w.avOffsetMeanUs ?? NaN) / 1000)}/${Math.round((w.avOffsetMaxAbsUs ?? NaN) / 1000)}`).join(' ')} catch-ups=${windows.at(-1)?.elementCatchUps ?? w0?.elementCatchUps}`);
  for (const w of windows) {
    expect(w.videoPath).toBe('element');
    // 'wall' here means the browser has no running audio output (run headed or use a machine with audio).
    expect(w.clockMode).toBe('audio');
  }
}

test('disc1 plays on the element path in sync across the play-item boundary to the end', async ({ page, browserName, isMobile }) => {
  test.skip(browserName !== 'chromium' || isMobile, CHROME_ONLY);
  await openDisc(page);
  await skipWithoutH264(page);
  await startPlaylist(page);
  await expect(page.getByTestId('video-element')).toBeVisible();
  const windows = await collectWindows(page, 7_000_000);
  console.log(`element: ${JSON.stringify(await elementState(page))}`);
  expect(windows.length).toBeGreaterThan(5);
  expectElementWindows(windows);
  expectInSync(afterStart(windows));
  await expect(page.getByTestId('player')).toHaveAttribute('data-state', 'ended', { timeout: 10_000 });
});

test('skips to the next chapter and is back in sync within a second', async ({ page, browserName, isMobile }) => {
  test.skip(browserName !== 'chromium' || isMobile, CHROME_ONLY);
  await openDisc(page);
  await startPlaylist(page);
  const before = await telemetry(page);
  expect(before).not.toBeNull();
  expect(before?.clockUs).toBeLessThan(1_500_000);
  await page.getByTestId('player').hover();
  await page.getByTestId('next-chapter').click();
  // Ordinary playback would need >1.5 s more to get here, so this proves a jump.
  await expect.poll(async () => (await telemetry(page))?.clockUs ?? 0, { timeout: 1000 }).toBeGreaterThanOrEqual(2_000_000);
  await page.waitForTimeout(1000);
  const windows = await collectWindows(page, 3_500_000);
  console.log(`element: ${JSON.stringify(await elementState(page))}`);
  expectElementWindows(windows);
  expectInSync(windows);
});

test('pauses and resumes in sync', async ({ page, browserName, isMobile }) => {
  test.skip(browserName !== 'chromium' || isMobile, CHROME_ONLY);
  await recordTelemetrySamples(page);
  await openDisc(page);
  await startPlaylist(page);
  await expect.poll(async () => (await telemetry(page))?.clockUs ?? 0, { timeout: 5000 }).toBeGreaterThan(1_000_000);
  const beforePause = (await telemetrySamples(page)).length;
  await page.keyboard.press('Space');
  await expect(page.getByTestId('player')).toHaveAttribute('data-state', 'paused');
  const paused = await pausedClockUs(page, beforePause);
  await page.waitForTimeout(1000);
  expect(Math.abs(((await telemetry(page)) as TelemetrySample).clockUs - paused)).toBeLessThan(50_000);
  const video = await elementState(page);
  expect(video.paused).toBe(true);
  // the picture stopped where the sound did
  expect(Math.abs((video.currentTime as number) - ELEMENT_TIME_OFFSET_S - paused / 1e6)).toBeLessThan(0.05);
  await page.keyboard.press('Space');
  await expect(page.getByTestId('player')).toHaveAttribute('data-state', 'playing');
  const windows = await collectWindows(page, paused + 2_000_000);
  console.log(`element: ${JSON.stringify(await elementState(page))}`);
  // the first window after the resume may hold frames from before the pause
  const after = windows.filter((w) => w.clockUs > paused + 600_000);
  expect(after.length).toBeGreaterThan(0);
  expectElementWindows(after);
  expectInSync(after);
});

test('paused seek shows the target frame', async ({ page, browserName, isMobile }) => {
  test.skip(browserName !== 'chromium' || isMobile, CHROME_ONLY);
  await openDisc(page);
  await startPlaylist(page);
  await expect.poll(async () => (await telemetry(page))?.clockUs ?? 0, { timeout: 5000 }).toBeGreaterThan(500_000);
  await page.keyboard.press('Space');
  await expect(page.getByTestId('player')).toHaveAttribute('data-state', 'paused');
  await page.getByTestId('player').hover();
  await page.getByTestId('seek').fill('5000000');
  // the element is placed once the engine's reset and the target's first segment reach the page
  await expect
    .poll(async () => {
      const v = await elementState(page);
      return !v.seeking && (v.readyState as number) >= 2 && Math.abs((v.currentTime as number) - ELEMENT_TIME_OFFSET_S - 5) < 0.05;
    }, { timeout: 5000 })
    .toBe(true);
  const video = await elementState(page);
  console.log(`element: ${JSON.stringify(video)}`);
  expect(video.paused).toBe(true);
  await expect(page.getByTestId('player')).toHaveAttribute('data-state', 'paused');
});

test('a B-frame disc plays on the element path in sync', async ({ page, browserName, isMobile }) => {
  test.skip(browserName !== 'chromium' || isMobile, CHROME_ONLY);
  await openDisc(page, 'fixtures/synthetic/disc2');
  await startPlaylist(page);
  const windows = await collectWindows(page, 3_500_000);
  console.log(`element: ${JSON.stringify(await elementState(page))}`);
  expect(windows.length).toBeGreaterThan(3);
  expectElementWindows(windows);
  expectInSync(afterStart(windows));
});

test('the HDR disc plays on the element path where MSE plays HEVC Main10', async ({ page, browserName, isMobile }) => {
  test.skip(browserName !== 'chromium' || isMobile, CHROME_ONLY);
  await page.addInitScript(() => {
    // Chrome's Open folder: the person cancels the picker, and the click has started the audio output meanwhile
    (window as unknown as { showDirectoryPicker: () => Promise<never> }).showDirectoryPicker = () => Promise.reject(new DOMException('cancelled', 'AbortError'));
    const add = AudioWorklet.prototype.addModule;
    AudioWorklet.prototype.addModule = function (this: AudioWorklet, ...args: Parameters<typeof add>) {
      return add.apply(this, args).then(() => {
        (window as unknown as { __audioWorkletReady?: boolean }).__audioWorkletReady = true;
      });
    };
  });
  await page.goto('/?telemetry=1&videopath=element');
  const supported = await page.evaluate((type) => {
    const mse = (globalThis as { ManagedMediaSource?: typeof MediaSource }).ManagedMediaSource ?? globalThis.MediaSource;
    return mse?.isTypeSupported(type) ?? false;
  }, HEVC_MAIN10);
  test.skip(!supported, `MSE in this browser does not play HEVC Main10 (${HEVC_MAIN10})`);
  // One playlist: the disc plays it from First Play as it opens, with no list to pick from, so the audio output must be up
  // before the open, as it is for a person, whose click on Open folder starts it before the folder is chosen.
  await startAudioAsOpenFolderDoes(page);
  await setFolder(page.getByTestId('folder-input'), 'fixtures/synthetic/disc-hdr');
  await expect(page.getByTestId('player')).toHaveAttribute('data-state', 'playing', { timeout: 10_000 });
  await expect(page.getByTestId('video-element')).toBeVisible();
  const windows = await collectWindows(page, 3_000_000);
  console.log(`element: ${JSON.stringify(await elementState(page))}`);
  expect(windows.length).toBeGreaterThan(2);
  expectElementWindows(windows);
  expectInSync(afterStart(windows));
});

test('without the flag the canvas path plays', async ({ page }) => {
  await openDisc(page, 'fixtures/synthetic/disc1', '?telemetry=1');
  await skipWithoutH264(page);
  await startPlaylist(page);
  await expect.poll(async () => (await telemetry(page))?.videoPath ?? null, { timeout: 5000 }).toBe('canvas');
  await expect(page.getByTestId('video-element')).toBeHidden();
  await expect.poll(async () => (await telemetry(page))?.framesPresented ?? 0, { timeout: 5000 }).toBeGreaterThan(0);
});
