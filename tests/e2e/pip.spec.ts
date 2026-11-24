// SPDX-License-Identifier: LGPL-3.0-or-later
import { expect, test, type Page } from '@playwright/test';
import { LINUX_WEBKIT_REALTIME, isLinuxWebKit, setFolder } from './support';
import { telemetry } from './telemetry';

/**
 * Picture in Picture and the video's own fullscreen through the element path (spec
 * docs/superpowers/specs/2026-11-24-iphone-fullscreen-pip-design.md). disc3 is 12 s of 640-wide H.264, which every
 * browser's canvas decodes, so under the Auto video output it starts on the canvas and the button moves it.
 */

const H264_HIGH = 'video/mp4; codecs="avc1.640028"';

async function mseSupports(page: Page, type: string): Promise<boolean> {
  return page.evaluate((t) => {
    const mse = (globalThis as { ManagedMediaSource?: typeof MediaSource }).ManagedMediaSource ?? globalThis.MediaSource;
    return mse?.isTypeSupported(t) ?? false;
  }, type);
}

async function openDisc(page: Page, query = ''): Promise<void> {
  await page.goto(`/?telemetry=1${query}`);
  const browser = page.context().browser()?.browserType().name() ?? '';
  test.skip(isLinuxWebKit(browser), LINUX_WEBKIT_REALTIME);
  test.skip(!(await mseSupports(page, H264_HIGH)), `MSE in this browser does not play ${H264_HIGH}`);
  await setFolder(page.getByTestId('folder-input'), 'fixtures/synthetic/disc3');
  await page.getByTestId('playlist-00000').click();
  await expect(page.getByTestId('player')).toHaveAttribute('data-state', 'playing', { timeout: 10_000 });
  await expect.poll(async () => (await telemetry(page))?.videoPath, { timeout: 10_000 }).toBe('canvas');
}

/** Clicks a control bar button, waking the bar first. */
async function clickControl(page: Page, name: string): Promise<void> {
  await page.mouse.move(640, 600);
  await page.getByRole('button', { name, exact: true }).click();
}

/** How the system shows the page's video now: Picture in Picture, its own fullscreen, or not at all. */
function presentation(page: Page): Promise<'pip' | 'fullscreen' | null> {
  return page.getByTestId('video-element').evaluate((v: HTMLVideoElement) => {
    const w = v as HTMLVideoElement & { webkitPresentationMode?: string; webkitDisplayingFullscreen?: boolean };
    if (document.pictureInPictureElement === v || w.webkitPresentationMode === 'picture-in-picture') return 'pip';
    if (w.webkitDisplayingFullscreen === true || w.webkitPresentationMode === 'fullscreen') return 'fullscreen';
    return null;
  });
}

const notices = (page: Page): Promise<string[]> => page.getByRole('status').allInnerTexts();

test('Picture in Picture moves a canvas playlist to the element path, and the system controls drive the player', async ({ page }) => {
  await openDisc(page);
  const pip = await page.evaluate(() => document.pictureInPictureEnabled === true || 'webkitSetPresentationMode' in HTMLVideoElement.prototype);
  test.skip(!pip, 'This browser has no Picture in Picture for a video element');

  // a text subtitle file covering the whole playlist, which the video's own text track carries in Picture in Picture
  const srt = Array.from({ length: 6 }, (_, i) => `${i + 1}\n00:00:${String(i * 2).padStart(2, '0')},000 --> 00:00:${String(i * 2 + 2).padStart(2, '0')},000\nLine ${i + 1}\n`).join('\n');
  await page.getByTestId('subtitle-file-input').setInputFiles({ name: 'lines.srt', mimeType: 'text/plain', buffer: Buffer.from(srt) });
  await expect.poll(() => page.evaluate(() => (window as unknown as { __blurayTelemetry?: { textFile?: number | null } }).__blurayTelemetry?.textFile ?? null)).toBe(0);

  await clickControl(page, 'Picture in Picture');
  await expect.poll(async () => (await telemetry(page))?.videoPath, { timeout: 10_000 }).toBe('element');
  // the browser may refuse once the move took longer than the click's activation: the player asks for one more tap
  await expect.poll(async () => (await presentation(page)) ?? (await notices(page)).join('|'), { timeout: 10_000 }).toMatch(/^pip$|Picture in Picture/);
  if ((await presentation(page)) !== 'pip') {
    const said = (await notices(page)).join('|');
    test.skip(!said.includes('tap Picture in Picture again'), `the browser refused Picture in Picture: ${said}`);
    await clickControl(page, 'Picture in Picture');
    await expect.poll(async () => (await presentation(page)) ?? (await notices(page)).join('|'), { timeout: 5_000 }).toMatch(/^pip$|didn['’]t start/);
    test.skip((await presentation(page)) !== 'pip', `the browser refused Picture in Picture: ${(await notices(page)).join('|')}`);
  }

  // the subtitles come along as the element's own text track, one cue at a time, and the page says how
  const video = page.getByTestId('video-element');
  await expect
    .poll(() => video.evaluate((v: HTMLVideoElement) => (v.textTracks[0]?.mode === 'showing' ? (v.textTracks[0].cues?.[0] as VTTCue | undefined)?.text ?? '' : 'not showing')))
    .toMatch(/^Line \d$/);
  expect((await notices(page)).join('|')).toContain('Subtitles show as plain text in Picture in Picture');

  // the system's controls act on the element itself: a pause, a play and a seek there reach the player
  await video.evaluate((v: HTMLVideoElement) => v.pause());
  await expect(page.getByTestId('player')).toHaveAttribute('data-state', 'paused', { timeout: 5_000 });
  await video.evaluate((v: HTMLVideoElement) => void v.play());
  await expect(page.getByTestId('player')).toHaveAttribute('data-state', 'playing', { timeout: 5_000 });
  expect(await video.evaluate((v: HTMLVideoElement) => v.duration)).toBeGreaterThan(21.9); // the playlist, plus the 10 s offset
  // a seek to a playlist time well away from where it plays (the telemetry sample may be up to 500 ms old)
  const now = (await telemetry(page))?.clockUs ?? 0;
  const targetS = now < 5_000_000 ? 8 : 1;
  await video.evaluate((v: HTMLVideoElement, t: number) => {
    v.currentTime = 10 + t;
  }, targetS);
  await expect
    .poll(async () => {
      const c = (await telemetry(page))?.clockUs ?? -1;
      return c >= targetS * 1e6 - 300_000 && c <= targetS * 1e6 + 2_000_000;
    }, { timeout: 10_000 })
    .toBe(true);

  // a second click leaves Picture in Picture, and the playlist plays on in the page
  await clickControl(page, 'Picture in Picture');
  await expect.poll(() => presentation(page)).toBeNull();
  await expect(page.getByTestId('player')).toHaveAttribute('data-state', 'playing');
  expect(await video.evaluate((v: HTMLVideoElement) => v.textTracks[0]?.mode)).toBe('disabled');
});

test('Picture in Picture says why a disc with MPEG-2 video stays on the canvas', async ({ page }) => {
  await page.goto('/?telemetry=1');
  const pip = await page.evaluate(() => document.pictureInPictureEnabled === true || 'webkitSetPresentationMode' in HTMLVideoElement.prototype);
  test.skip(!pip, 'This browser has no Picture in Picture for a video element');
  await setFolder(page.getByTestId('folder-input'), 'fixtures/synthetic/disc-mpeg2');
  await page.getByTestId('playlist-00000').click();
  await expect(page.getByTestId('player')).toHaveAttribute('data-state', /playing|buffering/, { timeout: 10_000 });
  await clickControl(page, 'Picture in Picture');
  await expect.poll(async () => (await notices(page)).join('|')).toContain("Picture in Picture isn't available for this video: it needs H.264 or HEVC");
  expect(await presentation(page)).toBeNull();
});

test('?fullscreen=video: Fullscreen uses the video’s own fullscreen where the browser has it', async ({ page }) => {
  await openDisc(page, '&fullscreen=video');
  const has = await page.evaluate(() => 'webkitEnterFullscreen' in HTMLVideoElement.prototype);
  test.skip(!has, 'This browser has no video fullscreen (webkitEnterFullscreen)');
  await clickControl(page, 'Fullscreen');
  await expect.poll(async () => (await telemetry(page))?.videoPath, { timeout: 10_000 }).toBe('element');
  await expect.poll(async () => (await presentation(page)) ?? (await notices(page)).join('|'), { timeout: 10_000 }).toMatch(/^fullscreen$|Fullscreen/);
  if ((await presentation(page)) !== 'fullscreen') {
    const said = (await notices(page)).join('|');
    test.skip(!said.includes('tap Fullscreen again'), `the browser refused video fullscreen: ${said}`);
    await clickControl(page, 'Fullscreen');
    await expect.poll(async () => (await presentation(page)) ?? (await notices(page)).join('|'), { timeout: 5_000 }).toMatch(/^fullscreen$|didn['’]t start/);
    test.skip((await presentation(page)) !== 'fullscreen', `the browser refused video fullscreen: ${(await notices(page)).join('|')}`);
  }
  await page.getByTestId('video-element').evaluate((v: HTMLVideoElement) => v.pause());
  await expect(page.getByTestId('player')).toHaveAttribute('data-state', 'paused', { timeout: 5_000 });
  await page.getByTestId('video-element').evaluate((v: HTMLVideoElement & { webkitExitFullscreen?: () => void }) => v.webkitExitFullscreen?.());
  await expect.poll(() => presentation(page)).toBeNull();
});
