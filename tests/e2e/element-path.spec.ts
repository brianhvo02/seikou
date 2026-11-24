// SPDX-License-Identifier: LGPL-3.0-or-later
import { expect, test, type Page } from '@playwright/test';
import { LINUX_WEBKIT_REALTIME, isLinuxWebKit, setFolder, skipWithoutH264 } from './support';
import { collectWindows, expectInSync, pausedClockUs, recordTelemetrySamples, telemetry, telemetrySamples, type TelemetrySample } from './telemetry';

/** The element plays at media time = playlist time + this (ELEMENT_TIME_OFFSET_US in the engine's element/fmp4.ts). */
const ELEMENT_TIME_OFFSET_S = 10;

const HEVC_MAIN10 = 'video/mp4; codecs="hvc1.2.4.L120.90"';
/** H.264 High profile, what the synthetic discs carry. */
const H264_HIGH = 'video/mp4; codecs="avc1.640028"';

/** Whether this browser's Media Source Extensions (ManagedMediaSource where there is one, as the player picks) take `type`. */
async function mseSupports(page: Page, type: string): Promise<boolean> {
  return page.evaluate((t) => {
    const mse = (globalThis as { ManagedMediaSource?: typeof MediaSource }).ManagedMediaSource ?? globalThis.MediaSource;
    return mse?.isTypeSupported(t) ?? false;
  }, type);
}

/**
 * Skips the running test where the element path can't play `type` (the browser's MSE says no) and in WebKit on Linux,
 * which can't keep up with real-time playback. A test that checks A/V sync (`sync`) also skips in Firefox, which the
 * sync check doesn't cover. Call it with the app loaded.
 */
async function skipWithoutElementPath(page: Page, type = H264_HIGH, { sync = false }: { sync?: boolean } = {}): Promise<void> {
  const browser = page.context().browser()?.browserType().name() ?? '';
  test.skip(isLinuxWebKit(browser), LINUX_WEBKIT_REALTIME);
  // The design's sync check covers Chrome and WebKit, as the canvas path's does Chrome; Firefox on CI has no running
  // audio output and its HEVC timing there is unmeasured (docs/known-issues.md).
  test.skip(sync && browser === 'firefox', 'The element path is sync-checked in Chrome and WebKit only');
  test.skip(!(await mseSupports(page, type)), `MSE in this browser does not play ${type}`);
}

/** Skips the running test where WebCodecs can't decode HEVC Main10, so disc-hdr can't play on the canvas. */
async function skipWithoutCanvasHevc(page: Page): Promise<void> {
  const supported = await page.evaluate(() =>
    typeof VideoDecoder === 'undefined'
      ? false
      : VideoDecoder.isConfigSupported({ codec: 'hvc1.2.4.L120.90' }).then((s) => s.supported === true).catch(() => false),
  );
  test.skip(!supported, 'WebCodecs in this browser does not decode HEVC Main10, so the canvas cannot play disc-hdr');
}

async function openDisc(page: Page, folder = 'fixtures/synthetic/disc1', query = '?telemetry=1&videopath=element'): Promise<void> {
  await page.goto(`/${query}`);
  await setFolder(page.getByTestId('folder-input'), folder);
  await expect(page.getByTestId('playlist-00000')).toBeVisible();
  if (query.includes('videopath=element')) await skipWithoutElementPath(page, H264_HIGH, { sync: true });
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
 * Makes the page's `matchMedia('(dynamic-range: high)')` answer `hdr`, as a display that can (or can't) show HDR would:
 * Playwright's `emulateMedia` has no dynamic-range feature, so the page's own query is replaced for that one feature.
 * Call it before the page loads.
 */
async function emulateHdrDisplay(page: Page, hdr: boolean): Promise<void> {
  await page.addInitScript((matches: boolean) => {
    const real = window.matchMedia.bind(window);
    window.matchMedia = (q: string): MediaQueryList => {
      if (q.replace(/\s/g, '') !== '(dynamic-range:high)') return real(q);
      const none = (): void => {};
      return { matches, media: q, onchange: null, addEventListener: none, removeEventListener: none, addListener: none, removeListener: none, dispatchEvent: () => false } as MediaQueryList;
    };
  }, hdr);
}

/**
 * Opens disc-hdr at `query` and waits until it plays, skipping where MSE can't play HEVC Main10 (and, for a test that
 * checks sync, `sync`, where skipWithoutElementPath says so). It has one playlist, which
 * it plays from First Play as it opens with no list to pick from, so the audio output must be up before the open, as it is
 * for a person, whose click on Open folder starts it before the folder is chosen.
 */
async function openHdrDisc(page: Page, query: string, { sync = false }: { sync?: boolean } = {}): Promise<void> {
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
  await page.goto(`/${query}`);
  await skipWithoutElementPath(page, HEVC_MAIN10, { sync });
  await startAudioAsOpenFolderDoes(page);
  await setFolder(page.getByTestId('folder-input'), 'fixtures/synthetic/disc-hdr');
  await expect(page.getByTestId('player')).toHaveAttribute('data-state', 'playing', { timeout: 10_000 });
}

function expectElementWindows(windows: TelemetrySample[]): void {
  const w0 = windows[0];
  // each window's mean and max (ms), for reading a failure; and the catch-ups run so far
  console.log(`element windows: ${windows.map((w) => `${Math.round((w.avOffsetMeanUs ?? NaN) / 1000)}/${Math.round((w.avOffsetMaxAbsUs ?? NaN) / 1000)}`).join(' ')} catch-ups=${windows.at(-1)?.elementCatchUps ?? w0?.elementCatchUps}`);
  for (const w of windows) {
    // a failed element says why (and the disc fell back to the canvas)
    expect(w.elementFailure ?? null).toBeNull();
    expect(w.videoPath).toBe('element');
    // 'wall' here means the browser has no running audio output (run headed or use a machine with audio).
    expect(w.clockMode).toBe('audio');
  }
}

test('disc1 plays on the element path in sync across the play-item boundary to the end', async ({ page }) => {
  await openDisc(page);
  await startPlaylist(page);
  await expect(page.getByTestId('video-element')).toBeVisible();
  const windows = await collectWindows(page, 7_000_000);
  console.log(`element: ${JSON.stringify(await elementState(page))}`);
  expect(windows.length).toBeGreaterThan(5);
  expectElementWindows(windows);
  expectInSync(windows);
  await expect(page.getByTestId('player')).toHaveAttribute('data-state', 'ended', { timeout: 10_000 });
});

test('skips to the next chapter and is back in sync within a second', async ({ page }) => {
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

test('pauses and resumes in sync', async ({ page }) => {
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
  console.log(`paused: element minus clock ${Math.round((((video.currentTime as number) - ELEMENT_TIME_OFFSET_S) * 1e6 - paused) / 100) / 10} ms`);
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

test('paused seek shows the target frame', async ({ page }) => {
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

test('a B-frame disc plays on the element path in sync', async ({ page }) => {
  await openDisc(page, 'fixtures/synthetic/disc2');
  await startPlaylist(page);
  const windows = await collectWindows(page, 3_500_000);
  console.log(`element: ${JSON.stringify(await elementState(page))}`);
  expect(windows.length).toBeGreaterThan(3);
  expectElementWindows(windows);
  expectInSync(windows);
});

test('without any flag the HDR disc plays on the element path where MSE plays HEVC Main10', async ({ page }) => {
  await openHdrDisc(page, '?telemetry=1', { sync: true });
  await expect(page.getByTestId('video-element')).toBeVisible();
  const windows = await collectWindows(page, 3_000_000);
  console.log(`element: ${JSON.stringify(await elementState(page))}`);
  expect(windows.length).toBeGreaterThan(2);
  expectElementWindows(windows);
  expectInSync(windows);
});

test('the HDR badge shows over HDR video only when the display can show HDR', async ({ page }) => {
  await emulateHdrDisplay(page, true);
  await openHdrDisc(page, '?telemetry=1');
  await expect.poll(async () => (await telemetry(page))?.videoPath ?? null, { timeout: 5000 }).toBe('element');
  await expect(page.getByTestId('hdr-badge')).toHaveText('HDR');
});

test('subtitles over HDR video on an HDR display go through the HDR overlay canvas', async ({ page }, testInfo) => {
  await emulateHdrDisplay(page, true);
  await openHdrDisc(page, '?telemetry=1');
  await expect.poll(async () => (await telemetry(page))?.videoPath ?? null, { timeout: 5000 }).toBe('element');
  // the engine worker's WebGPU, as the page sees it (a browser without an adapter keeps the overlays SDR)
  const gpu = await page.evaluate(async () => {
    const g = (navigator as Navigator & { gpu?: { requestAdapter(): Promise<unknown> } }).gpu;
    return g ? (await g.requestAdapter().catch(() => null)) !== null : false;
  });
  const expected = gpu ? { displayHdr: true, presenter: 'webgpu', active: true } : { displayHdr: true, presenter: 'unavailable', active: false };
  await expect.poll(async () => (await telemetry(page))?.hdrOverlay ?? null, { timeout: 5000 }).toMatchObject(expected);
  expect((await telemetry(page))?.hdrOverlay?.gain).toBeCloseTo(2.03, 5);
  // the PG subtitle shows from 1 s to 5 s: presented through WebGPU without losing it
  await expect.poll(async () => (await telemetry(page))?.clockUs ?? 0, { timeout: 5000 }).toBeGreaterThan(2_000_000);
  expect((await telemetry(page))?.hdrOverlay).toMatchObject(expected);
  await expect(page.getByTestId('hdr-overlay-canvas')).toHaveCSS('pointer-events', 'none');
  await testInfo.attach('hdr-overlay', { body: await page.getByTestId('player').screenshot(), contentType: 'image/png' });
});

test('over HDR video on a display without HDR the overlays stay SDR, and ?hdrgain= tunes the gain', async ({ page }) => {
  await emulateHdrDisplay(page, false);
  await openHdrDisc(page, '?telemetry=1&hdrgain=3');
  await expect.poll(async () => (await telemetry(page))?.clockUs ?? 0, { timeout: 5000 }).toBeGreaterThan(1_500_000);
  await expect.poll(async () => (await telemetry(page))?.hdrOverlay ?? null, { timeout: 5000 }).toEqual({ displayHdr: false, presenter: 'none', reason: null, active: false, gain: 3 });
});

test('no HDR badge over HDR video on a display without HDR', async ({ page }) => {
  await emulateHdrDisplay(page, false);
  await openHdrDisc(page, '?telemetry=1');
  await expect.poll(async () => (await telemetry(page))?.videoPath ?? null, { timeout: 5000 }).toBe('element');
  await expect.poll(async () => (await telemetry(page))?.clockUs ?? 0, { timeout: 5000 }).toBeGreaterThan(1_000_000);
  await expect(page.getByTestId('hdr-badge')).toHaveCount(0);
});

test('without the flag the canvas path plays', async ({ page }) => {
  await openDisc(page, 'fixtures/synthetic/disc1', '?telemetry=1');
  await skipWithoutH264(page);
  await startPlaylist(page);
  await expect.poll(async () => (await telemetry(page))?.videoPath ?? null, { timeout: 5000 }).toBe('canvas');
  await expect(page.getByTestId('video-element')).toBeHidden();
  await expect.poll(async () => (await telemetry(page))?.framesPresented ?? 0, { timeout: 5000 }).toBeGreaterThan(0);
});

test('without any flag an SDR disc WebCodecs cannot configure plays on the element path', async ({ page }) => {
  // ?nodecoder=1: WebCodecs supports no video decoder configuration, so under Auto disc1's H.264 goes to the element
  await openDisc(page, 'fixtures/synthetic/disc1', '?telemetry=1&nodecoder=1');
  await skipWithoutElementPath(page);
  await startPlaylist(page);
  await expect.poll(async () => (await telemetry(page))?.videoPath ?? null, { timeout: 5000 }).toBe('element');
  await expect(page.getByTestId('video-element')).toBeVisible();
  await expect(page.getByTestId('picker-error')).toHaveCount(0);
});

test('no HDR badge over an SDR disc on a display that can show HDR', async ({ page }) => {
  await emulateHdrDisplay(page, true);
  await openDisc(page, 'fixtures/synthetic/disc1', '?telemetry=1');
  await skipWithoutH264(page);
  await startPlaylist(page);
  await expect.poll(async () => (await telemetry(page))?.framesPresented ?? 0, { timeout: 5000 }).toBeGreaterThan(0);
  await expect(page.getByTestId('hdr-badge')).toHaveCount(0);
});

test('Video output switches an SDR disc to the video element from the next playlist, and is kept', async ({ page }) => {
  await openDisc(page, 'fixtures/synthetic/disc1', '?telemetry=1');
  await skipWithoutH264(page);
  await skipWithoutElementPath(page);
  await startPlaylist(page);
  await expect.poll(async () => (await telemetry(page))?.videoPath ?? null, { timeout: 5000 }).toBe('canvas');
  await page.getByTestId('player').hover();
  await page.getByTestId('video-output-menu').click();
  await expect(page.locator('[role="menuitemradio"][data-path="auto"]')).toHaveAttribute('aria-checked', 'true');
  await expect(page.getByText('A Video output change applies from the next playlist.')).toBeVisible();
  await page.locator('[role="menuitemradio"][data-path="element"]').click();
  // the playlist playing keeps its path
  await page.waitForTimeout(1000);
  expect((await telemetry(page))?.videoPath).toBe('canvas');
  await expect(page.getByTestId('video-element')).toBeHidden();
  // the next one takes the element
  await page.getByTestId('player').hover();
  await page.getByRole('button', { name: /^(Playlists|Titles)$/ }).click();
  await page.getByTestId('playlist-00000').click();
  await expect(page.getByTestId('player')).toHaveAttribute('data-state', 'playing', { timeout: 10_000 });
  await expect.poll(async () => (await telemetry(page))?.videoPath ?? null, { timeout: 5000 }).toBe('element');
  await expect(page.getByTestId('video-element')).toBeVisible();
  // the choice is saved for the next visit
  expect(await page.evaluate(() => localStorage.getItem('bluray-web:video-output'))).toBe('element');
});

test.describe('with shaders on a GPU', () => {
  test.skip(process.env.SHADERS_GPU !== '1', 'set SHADERS_GPU=1 to run the shader tests that need a GPU');

  test('turning a shader set on during HDR video reopens it on the canvas, and off returns it to the element', async ({ page }) => {
    await openHdrDisc(page, '?telemetry=1');
    await skipWithoutCanvasHevc(page);
    await expect.poll(async () => (await telemetry(page))?.videoPath ?? null, { timeout: 5000 }).toBe('element');
    await expect.poll(async () => (await telemetry(page))?.clockUs ?? 0, { timeout: 5000 }).toBeGreaterThan(1_000_000);
    await page.getByTestId('player').hover();
    await page.getByTestId('shader-menu').click();
    await page.getByTestId('shader-set-Anime4K: Mode A (Fast)').click();
    await expect.poll(async () => (await telemetry(page))?.videoPath ?? null, { timeout: 10_000 }).toBe('canvas');
    await expect.poll(async () => ((await telemetry(page)) as { shader?: { set: string } | null } | null)?.shader?.set ?? null, { timeout: 15_000 }).toBe('Anime4K: Mode A (Fast)');
    await expect(page.getByTestId('video-element')).toBeHidden();
    await page.getByTestId('player').hover();
    await page.getByTestId('shader-menu').click();
    await page.getByTestId('shader-set-off').click();
    await expect.poll(async () => (await telemetry(page))?.videoPath ?? null, { timeout: 10_000 }).toBe('element');
    await expect(page.getByTestId('video-element')).toBeVisible();
  });
});

test('an HDR disc whose element fails falls back to the canvas once, with the notice once', async ({ page }) => {
  await page.addInitScript(() => {
    (window as unknown as { showDirectoryPicker: () => Promise<never> }).showDirectoryPicker = () => Promise.reject(new DOMException('cancelled', 'AbortError'));
    const add = AudioWorklet.prototype.addModule;
    AudioWorklet.prototype.addModule = function (this: AudioWorklet, ...args: Parameters<typeof add>) {
      return add.apply(this, args).then(() => {
        (window as unknown as { __audioWorkletReady?: boolean }).__audioWorkletReady = true;
      });
    };
  });
  await page.goto('/?telemetry=1&videopath=element&elementfail=1');
  await skipWithoutElementPath(page, HEVC_MAIN10);
  await skipWithoutCanvasHevc(page);
  await startAudioAsOpenFolderDoes(page);
  await setFolder(page.getByTestId('folder-input'), 'fixtures/synthetic/disc-hdr');
  const notice = page.locator('.notice', { hasText: "HDR video couldn't play in this browser, so it shows without HDR and its colours may look flat" });
  await expect(notice).toHaveCount(1, { timeout: 10_000 });
  await expect.poll(async () => (await telemetry(page))?.elementFailure ?? null, { timeout: 10_000 }).not.toBeNull();
  expect((await telemetry(page))?.videoPath).toBe('canvas');
  await expect(page.getByTestId('player')).toHaveAttribute('data-state', 'playing', { timeout: 10_000 });
  // reopening the playlist stays on the canvas and says nothing again
  await page.getByTestId('player').hover();
  await page.getByRole('button', { name: /^(Playlists|Titles)$/ }).click();
  await page.getByTestId('playlist-00000').click();
  await expect(page.getByTestId('player')).toHaveAttribute('data-state', 'playing', { timeout: 10_000 });
  await page.waitForTimeout(1500);
  await expect(notice).toHaveCount(1);
  expect((await telemetry(page))?.videoPath).toBe('canvas');
});
