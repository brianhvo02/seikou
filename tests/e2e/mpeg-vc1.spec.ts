// SPDX-License-Identifier: LGPL-3.0-or-later
import { expect, test, type Page } from '@playwright/test';
import { isLinuxWebKit, LINUX_WEBKIT_REALTIME, setFolder } from './support';
import { collectWindows, expectInSync, telemetry, type TelemetrySample } from './telemetry';

// MPEG-2 and VC-1 play with a picture in every browser through the WASM decoder (video.wasm in its own worker), whose
// pictures are I420 planes wherever it runs, so interlaced ones go through the deinterlacer even in Firefox on macOS,
// whose WebCodecs decodes H.264 to RGB. No test here needs WebCodecs video, so skipWithoutH264 doesn't apply.
//
// fixtures/synthetic/disc-mpeg2-interlaced (scripts/make-mpeg2-interlaced-disc.ts): five 4 s playlists with LPCM audio,
// open GOPs with B pictures. 00000 1080i true interlaced, top field first; 00001 the same bottom field first; 00002 1080i
// hard 3:2 telecine of 23.976 film; 00003 480i soft 3:2 pulldown; 00004 1080p 23.976 progressive.
// fixtures/synthetic/disc-vc1 (scripts/make-vc1-disc.ts): one 6 s playlist, 00000, VC-1 1080i top field first.

const MPEG2_DISC = 'fixtures/synthetic/disc-mpeg2-interlaced';
const VC1_DISC = 'fixtures/synthetic/disc-vc1';
const NO_PICTURE_NOTICE = "This disc's video can't be played here yet, so it will play without a picture.";

interface Sample extends TelemetrySample {
  videoDecoder: { kind: 'webcodecs' | 'wasm'; decodeMs: number | null; skipped: number } | null;
  deinterlace: {
    setting: 'auto' | 'off';
    stats: { mode: 'progressive' | 'film' | 'video'; fieldOrder: 'tff' | 'bff'; fallback: boolean } | null;
    woven: string | null;
  } | null;
}

/** Why the A/V sync check is left out in Firefox on Linux (CI), as the deinterlacing and element path specs leave it out there. */
const NO_FIREFOX_AUDIO = 'Firefox on Linux (CI) has no running audio output; the sync check runs in Firefox on macOS';

const sample = async (page: Page): Promise<Sample | null> => (await telemetry(page)) as Sample | null;

/** Why the player draws WASM pictures woven though deinterlacing is on, where that is the machine's doing (no GPU), not a fault. */
const NO_DEINTERLACER = /^(WebGL2 is unavailable|A software WebGL renderer )/;

/** Opens `disc`'s playlist `id` on the canvas path and waits for its first presented picture. */
async function open(page: Page, disc: string, id: string, query = ''): Promise<Sample> {
  await page.goto(`/?telemetry=1&videopath=canvas${query}`);
  await setFolder(page.getByTestId('folder-input'), disc);
  await page.getByTestId(`playlist-${id}`).click();
  await expect(page.getByTestId('player')).toHaveAttribute('data-state', 'playing', { timeout: 15_000 });
  let t: Sample | null = null;
  await expect
    .poll(async () => {
      t = await sample(page);
      return t?.framesPresented ?? 0;
    }, { timeout: 15_000 })
    .toBeGreaterThan(0);
  return t!;
}

/**
 * Whether the deinterlacer runs for the interlaced playlist playing, as telemetry says once the session has started:
 * the engine decides as an interlaced session starts (`deinterlace` is null before), drawing the frames woven with
 * the reason in `woven` when it can't run. Waits for that sample, so the answer never races the first picture.
 */
async function deinterlacerDecision(page: Page): Promise<NonNullable<Sample['deinterlace']>> {
  let d: Sample['deinterlace'] = null;
  await expect
    .poll(async () => {
      d = (await sample(page))?.deinterlace ?? null;
      return d !== null;
    }, { timeout: 10_000, message: 'telemetry says whether the deinterlacer runs' })
    .toBe(true);
  return d!;
}

/** Skips where the machine can't deinterlace at all (no WebGL2, or WebGL drawn in software); telemetry says why. */
async function skipWithoutDeinterlacer(page: Page): Promise<void> {
  const woven = (await deinterlacerDecision(page)).woven ?? '';
  test.skip(NO_DEINTERLACER.test(woven), woven);
}

/** The A/V sync checks are left out in Firefox on Linux (CI): it has no running audio output there, so no audio clock to sync to. */
const skipsSync = (browserName: string): boolean => browserName === 'firefox' && process.platform === 'linux';

test('an MPEG-2 1080p playlist plays with a picture in sync', async ({ page, browserName }) => {
  test.skip(isLinuxWebKit(browserName), LINUX_WEBKIT_REALTIME);
  await open(page, MPEG2_DISC, '00004');
  const windows = await collectWindows(page, 3_800_000);
  expect(windows.length).toBeGreaterThan(3);
  if (skipsSync(browserName)) {
    // the pictures are still checked below; Firefox on CI has no running audio output, so there is no audio clock to sync to
    test.info().annotations.push({ type: 'skipped check', description: NO_FIREFOX_AUDIO });
  } else {
    for (const w of windows) expect(w.clockMode).toBe('audio');
    expectInSync(windows);
  }
  const t = (await sample(page))!;
  expect(t.videoDecoder).toMatchObject({ kind: 'wasm' });
  expect(t.decoderErrors ?? 0).toBe(0);
  // 23.976 frames a second: about 90 pictures by 3.8 s
  expect(t.framesPresented ?? 0).toBeGreaterThanOrEqual(80);
  // progressive video never goes through the deinterlacer
  expect(t.deinterlace).toBeNull();
  console.log(`${browserName}: wasm decode ${t.videoDecoder?.decodeMs} ms, skipped ${t.videoDecoder?.skipped}, ${t.framesPresented} pictures`);
  await expect(page.getByRole('status').filter({ hasText: NO_PICTURE_NOTICE })).toHaveCount(0);
});

const INTERLACED = [
  { disc: MPEG2_DISC, id: '00000', what: 'MPEG-2 1080i top field first', mode: 'video', fieldOrder: 'tff' },
  { disc: MPEG2_DISC, id: '00001', what: 'MPEG-2 1080i bottom field first', mode: 'video', fieldOrder: 'bff' },
  { disc: MPEG2_DISC, id: '00002', what: 'MPEG-2 1080i hard telecine', mode: 'film', fieldOrder: undefined },
  { disc: MPEG2_DISC, id: '00003', what: 'MPEG-2 480i soft pulldown', mode: 'film', fieldOrder: undefined },
  { disc: VC1_DISC, id: '00000', what: 'VC-1 1080i top field first', mode: 'video', fieldOrder: 'tff' },
] as const;

// Needs no GPU and no real time, so it runs on every runner: where the deinterlacer can't run, the pictures are drawn
// woven, which is still a picture from the WASM decoder.
test('interlaced MPEG-2 and VC-1 play with pictures from the WASM decoder, deinterlaced or drawn woven with a reason', async ({ page, browserName }) => {
  for (const p of INTERLACED) {
    await open(page, p.disc, p.id);
    const d = await deinterlacerDecision(page);
    expect(d.setting).toBe('auto');
    // woven only for a reason of the machine's (no GPU), never a fault
    if (d.woven !== null) expect(d.woven).toMatch(NO_DEINTERLACER);
    const from = (await sample(page))!.framesPresented ?? 0;
    await expect.poll(async () => ((await sample(page))?.framesPresented ?? 0) - from, { timeout: 15_000, message: `${p.what}: pictures keep coming` }).toBeGreaterThanOrEqual(10);
    const t = (await sample(page))!;
    expect(t.videoDecoder, p.what).toMatchObject({ kind: 'wasm' });
    expect(t.decoderErrors ?? 0, p.what).toBe(0);
    await expect(page.getByRole('status').filter({ hasText: NO_PICTURE_NOTICE })).toHaveCount(0);
    console.log(`${browserName} ${p.what}: ${t.framesPresented} pictures, ${d.woven === null ? 'deinterlaced' : `woven (${d.woven})`}, decode ${t.videoDecoder?.decodeMs} ms`);
  }
});

test('interlaced MPEG-2 is deinterlaced: video at field rate, telecine and soft pulldown as film', async ({ page, browserName }) => {
  test.skip(isLinuxWebKit(browserName), LINUX_WEBKIT_REALTIME);
  for (const p of INTERLACED.filter((p) => p.disc === MPEG2_DISC)) {
    await open(page, p.disc, p.id);
    await skipWithoutDeinterlacer(page);
    await expect.poll(async () => (await sample(page))?.deinterlace?.stats?.mode, { timeout: 10_000, message: `${p.id}'s mode` }).toBe(p.mode);
    const t = (await sample(page))!;
    expect(t.videoDecoder).toMatchObject({ kind: 'wasm' });
    expect(t.deinterlace).toMatchObject({ setting: 'auto', woven: null, stats: { mode: p.mode, fallback: false, ...(p.fieldOrder ? { fieldOrder: p.fieldOrder } : {}) } });
    console.log(`${browserName} ${p.id}: ${t.deinterlace?.stats?.mode} ${t.deinterlace?.stats?.fieldOrder}, decode ${t.videoDecoder?.decodeMs} ms`);
  }
});

test('deinterlaced MPEG-2 plays in sync at field rate', async ({ page, browserName }) => {
  test.skip(isLinuxWebKit(browserName), LINUX_WEBKIT_REALTIME);
  test.skip(skipsSync(browserName), NO_FIREFOX_AUDIO);
  await open(page, MPEG2_DISC, '00000');
  await skipWithoutDeinterlacer(page);
  const windows = await collectWindows(page, 3_800_000);
  expect(windows.length).toBeGreaterThan(3);
  for (const w of windows) expect(w.clockMode).toBe('audio');
  expectInSync(windows);
  expect((await sample(page))!.deinterlace?.stats).toMatchObject({ mode: 'video', fallback: false });
});

test('a VC-1 interlaced playlist plays with a picture and is deinterlaced', async ({ page, browserName }) => {
  test.skip(isLinuxWebKit(browserName), LINUX_WEBKIT_REALTIME);
  const first = await open(page, VC1_DISC, '00000');
  expect(first.videoDecoder).toMatchObject({ kind: 'wasm' });
  await skipWithoutDeinterlacer(page);
  await expect.poll(async () => (await sample(page))?.deinterlace?.stats?.mode, { timeout: 10_000 }).toBe('video');
  await expect.poll(async () => (await sample(page))?.clockUs ?? 0, { timeout: 15_000 }).toBeGreaterThanOrEqual(3_000_000);
  const t = (await sample(page))!;
  expect(t.decoderErrors ?? 0).toBe(0);
  // 29.97 frames, drawn at field rate: well over 100 pictures by 3 s
  expect(t.framesPresented ?? 0).toBeGreaterThanOrEqual(100);
  expect(t.deinterlace).toMatchObject({ setting: 'auto', woven: null, stats: { mode: 'video', fieldOrder: 'tff', fallback: false } });
  console.log(`${browserName} VC-1: ${t.framesPresented} pictures by ${t.clockUs} us, decode ${t.videoDecoder?.decodeMs} ms, skipped ${t.videoDecoder?.skipped}`);
  await expect(page.getByRole('status').filter({ hasText: NO_PICTURE_NOTICE })).toHaveCount(0);
});

// Off needs no GPU: it runs on every runner, and checks the deinterlacer was running first only where it can.
test('Deinterlacing Off draws MPEG-2 woven', async ({ page }) => {
  await open(page, MPEG2_DISC, '00000');
  const d = await deinterlacerDecision(page);
  if (d.woven === null) await expect.poll(async () => (await sample(page))?.deinterlace?.stats?.mode, { timeout: 10_000 }).toBe('video');
  else expect(d.woven).toMatch(NO_DEINTERLACER);

  await page.getByTestId('player').hover();
  await page.getByTestId('video-output-menu').click();
  await page.getByTestId('deinterlace-off').click();
  await expect.poll(async () => (await sample(page))?.deinterlace?.setting, { timeout: 5_000 }).toBe('off');
  expect((await sample(page))!.deinterlace).toMatchObject({ setting: 'off', stats: null, woven: 'Deinterlacing is off' });

  // the playlist reopened at the same time, still decoded by the WASM decoder, and pictures keep coming
  const from = (await sample(page))!.framesPresented ?? 0;
  await expect.poll(async () => ((await sample(page))?.framesPresented ?? 0) - from, { timeout: 10_000 }).toBeGreaterThan(10);
  expect((await sample(page))!.videoDecoder).toMatchObject({ kind: 'wasm' });
});

test('with the decoder unavailable the disc plays without a picture and says so', async ({ page }) => {
  await page.goto('/?telemetry=1&novideowasm=1');
  await setFolder(page.getByTestId('folder-input'), MPEG2_DISC);
  await page.getByTestId('playlist-00004').click();
  await expect(page.getByTestId('player')).toHaveAttribute('data-state', 'playing', { timeout: 15_000 });
  await expect(page.getByRole('status').filter({ hasText: NO_PICTURE_NOTICE })).toHaveCount(1);
  await expect(page.getByTestId('error')).toBeHidden();
  // the clock runs on the audio, with no picture
  await expect.poll(async () => (await sample(page))?.clockUs ?? 0, { timeout: 10_000 }).toBeGreaterThan(1_000_000);
  const t = (await sample(page))!;
  expect(t.framesPresented ?? 0).toBe(0);
  expect(t.videoDecoder).toBeNull();
});
