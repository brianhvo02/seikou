// SPDX-License-Identifier: LGPL-3.0-or-later
import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { expect, test, type Page } from '@playwright/test';
import { build } from 'esbuild';
import { decodePng } from '../ass-trace/png';
import type { GpuReport, LumaFrames } from './deinterlace-gpu';
import { setFolder, skipWithoutH264 } from './support';
import { collectWindows, expectInSync, recordTelemetrySamples, telemetry, telemetrySamples, type TelemetrySample } from './telemetry';

// fixtures/synthetic/disc-interlaced (scripts/make-interlaced-disc.ts): 4 s playlists of 1080i H.264 at 29.97 with a
// white bar scrolling over testsrc2. 00000 is true interlaced, top field first; 00001 the same bottom field first; 00002
// 24p film through a hard 3:2 telecine; 00003 the same film flagged for soft 3:2 pulldown. The expected pictures beside
// it (fixtures/synthetic/deinterlace-ref, refs.json) are one crop around where the bar is at 2 s: ffmpeg's bwdif for
// 00000, the film frames before telecine for 00002 and 00003, each as the luma read back from the picture drawn as RGB
// (the generator says why).
//
// The pictures are compared at the deinterlacer's own pixels: the engine reads back the picture it draws (the
// test-only captureVideo, ?telemetry=1) before it is scaled onto the page, so no screenshot scaling or colour
// management comes into it. They are taken while playing (a pause keeps the picture as it was shown, and nothing new is
// drawn to capture).

const DISC = 'fixtures/synthetic/disc-interlaced';
const REF_DIR = 'fixtures/synthetic/deinterlace-ref';
/** Where the pictures are taken: the first one drawn at or after this playlist time. */
const PICTURE_AT_US = 2_000_000;
/** A field of a 29.97 frame (1001/60 ms) and a 23.976 film frame (1001/24 ms), in microseconds. */
const FIELD_US = 1_001_000 / 60;
const FILM_FRAME_US = 1_001_000 / 24;
/**
 * PSNR floors in dB. Measured on macOS (Apple silicon): video 50.9 in Chrome and 41.2 in WebKit (its decoder blends the
 * two fields' chroma, which colours the bar's moving edges; docs/known-issues.md), film 46.1-47.6 in both; Off 28.8 and
 * 29.2. Firefox on macOS decodes to RGB and draws these woven. Off must be more than OFF_MARGIN_DB worse than Auto on
 * the same picture.
 */
const VIDEO_PSNR_DB = 30;
const FILM_PSNR_DB = 35;
const OFF_MARGIN_DB = 3;
/** Film is locked by this playlist time (three 3:2 cycles are half a second) … */
const FILM_LOCKED_US = 600_000;
/** … and the telemetry says so until here, before the decoder reaches the 4 s playlist's end. */
const FILM_UNTIL_US = 3_300_000;

interface RefCrop {
  file: string;
  width: number;
  height: number;
  x: number;
  y: number;
  pictures: number;
}
const refs = JSON.parse(readFileSync(`${REF_DIR}/refs.json`, 'utf8')) as {
  video2s: RefCrop & { firstField: number };
  film2s: RefCrop & { firstFilmFrame: number };
  video: { file: string; width: number; height: number; frames: number };
  telecine: { file: string; width: number; height: number; frames: number };
};

interface DeinterlaceSample extends TelemetrySample {
  deinterlace: {
    setting: 'auto' | 'off';
    stats: { mode: 'progressive' | 'film' | 'video'; fieldOrder: 'tff' | 'bff'; fieldOrderSource: string; fallback: boolean; locks: number; breaks: number } | null;
    woven: string | null;
  } | null;
}

const deinterlaceOf = async (page: Page): Promise<DeinterlaceSample['deinterlace'] | undefined> => ((await telemetry(page)) as DeinterlaceSample | null)?.deinterlace;

/** The reference pictures of `crop` (stacked top to bottom in its PNG), as luma planes. */
function refPictures(crop: RefCrop): Uint8Array[] {
  const png = decodePng(readFileSync(`${REF_DIR}/${crop.file}`));
  expect([png.width, png.height]).toEqual([crop.width, crop.height * crop.pictures]);
  const size = crop.width * crop.height;
  return Array.from({ length: crop.pictures }, (_, p) => Uint8Array.from({ length: size }, (_, i) => png.rgba[(p * size + i) * 4]!));
}

function psnr(a: Uint8Array, b: Uint8Array): number {
  let sum = 0;
  for (let i = 0; i < a.length; i++) sum += (a[i]! - b[i]!) ** 2;
  return sum === 0 ? Infinity : 10 * Math.log10((255 * 255) / (sum / a.length));
}

interface Captured {
  timestampUs: number;
  deinterlaced: boolean;
  /** Luma of the crop, from the picture's RGB with BT.709's weights back to limited range. */
  luma: Uint8Array;
}

/** The first picture drawn at or after `atUs` (playlist time), cropped to `crop`, read back by the engine. */
async function capture(page: Page, atUs: number, crop: RefCrop): Promise<Captured> {
  const out = await page.evaluate(
    async ({ atUs, crop }) => {
      const take = (window as unknown as { __blurayCaptureVideo: (atUs: number) => Promise<{ timestampUs: number; width: number; height: number; rgba: Uint8ClampedArray; deinterlaced: boolean }> }).__blurayCaptureVideo;
      const c = await take(atUs);
      if (c.width !== 1920 || c.height !== 1080) throw new Error(`captured ${c.width}x${c.height}, wanted 1920x1080`);
      let bin = '';
      for (let y = crop.y; y < crop.y + crop.height; y++) {
        for (let x = crop.x; x < crop.x + crop.width; x++) {
          const i = (y * c.width + x) * 4;
          const yy = 0.2126 * c.rgba[i]! + 0.7152 * c.rgba[i + 1]! + 0.0722 * c.rgba[i + 2]!;
          bin += String.fromCharCode(Math.round(16 + (yy * 219) / 255));
        }
      }
      return { timestampUs: c.timestampUs, deinterlaced: c.deinterlaced, luma: btoa(bin) };
    },
    { atUs, crop },
  );
  return { ...out, luma: Uint8Array.from(Buffer.from(out.luma, 'base64')) };
}

/** PSNR of a captured picture against the reference picture `index` of `refs`, with every other reference's for the log. */
function scored(label: string, shot: Captured, pictures: Uint8Array[], index: number): number {
  expect(index, `${label}: the picture at ${shot.timestampUs} us has a reference (0-${pictures.length - 1})`).toBeGreaterThanOrEqual(0);
  expect(index).toBeLessThan(pictures.length);
  const all = pictures.map((p) => psnr(shot.luma, p).toFixed(1));
  const db = psnr(shot.luma, pictures[index]!);
  console.log(`${label}: picture at ${shot.timestampUs} us (reference ${index}), ${db.toFixed(1)} dB; against each reference: ${all.join(' ')}`);
  return db;
}

/**
 * Opens a playlist of the disc and waits for its first picture; skips the running test where this browser has no
 * deinterlacer (skipWithoutDeinterlacer).
 */
async function openPlaylist(page: Page, id: string, { realtime = true }: { realtime?: boolean } = {}): Promise<void> {
  await page.goto('/?telemetry=1&videopath=canvas');
  await skipWithoutH264(page, { realtime });
  await setFolder(page.getByTestId('folder-input'), DISC);
  await page.getByTestId(`playlist-${id}`).click();
  await expect(page.getByTestId('player')).toHaveAttribute('data-state', 'playing', { timeout: 10_000 });
  await skipWithoutDeinterlacer(page);
}

/** Why the player draws frames woven though deinterlacing is on, where that is the browser's doing and not a fault. */
const NO_DEINTERLACER = /^(The browser decodes to |WebGL2 is unavailable|A software WebGL renderer )/;

/**
 * Skips the running test where the player doesn't deinterlace in this browser: it decodes to RGB (Firefox on macOS gives
 * BGRX frames, and the deinterlacer reads YUV planes), has no WebGL2, or draws WebGL in software (SwiftShader, llvmpipe:
 * CI's machines without a GPU), which can't keep up in real time. The player then draws the frames woven and
 * telemetry says why; the playlist still plays, which interlaced-decode.spec.ts checks. A deinterlacer that stopped
 * on a fault is not skipped.
 */
async function skipWithoutDeinterlacer(page: Page): Promise<void> {
  // once a picture has been presented, the decoder's first frames have told which it is (one telemetry sample says both)
  let t: DeinterlaceSample | null = null;
  await expect
    .poll(async () => {
      t = (await telemetry(page)) as DeinterlaceSample | null;
      return (t?.framesPresented ?? 0) > 0;
    }, { timeout: 10_000 })
    .toBe(true);
  const woven = (t as DeinterlaceSample | null)?.deinterlace?.woven ?? '';
  test.skip(NO_DEINTERLACER.test(woven), woven);
}

/** Sets the seek bar as a user would by dragging it (see subtitles.spec.ts). */
async function seekTo(page: Page, us: number): Promise<void> {
  await page.getByTestId('seek').evaluate((el, value) => {
    const input = el as HTMLInputElement;
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, String(value));
    input.dispatchEvent(new Event('input', { bubbles: true }));
  }, us);
}

/**
 * Film is locked within a few cycles of the start and stays locked, at full quality, until the playlist's last frames
 * are decoded (the samples between FILM_LOCKED_US and FILM_UNTIL_US). After that the telemetry shows the detector of
 * the stream the end-of-playlist flush starts, not the pictures still showing.
 */
function expectFilmThroughout(samples: DeinterlaceSample[]): void {
  const middle = samples.filter((t) => t.clockUs >= FILM_LOCKED_US && t.clockUs <= FILM_UNTIL_US);
  console.log(`modes: ${samples.map((t) => `${(t.clockUs / 1e6).toFixed(2)} s ${t.deinterlace?.stats?.mode ?? '-'}`).join(', ')}`);
  expect(middle.length).toBeGreaterThanOrEqual(3);
  for (const t of middle) expect(t.deinterlace?.stats, `at ${t.clockUs} us`).toMatchObject({ mode: 'film', breaks: 0, fallback: false });
}

/** Skips the A/V sync checks in Firefox, as the element path's do: Firefox on CI has no running audio output. */
function skipSyncInFirefox(browserName: string): void {
  test.skip(browserName === 'firefox', 'A/V sync is checked in Chrome and WebKit, as the element path does');
}

test('true interlaced video (00000) is deinterlaced at field rate, its pictures as bwdif draws them', async ({ page }) => {
  await openPlaylist(page, '00000');
  await expect.poll(async () => (await deinterlaceOf(page))?.stats?.mode, { timeout: 10_000 }).toBe('video');
  const shot = await capture(page, PICTURE_AT_US, refs.video2s);
  expect(shot.deinterlaced).toBe(true);
  const d = await deinterlaceOf(page);
  expect(d).toMatchObject({ setting: 'auto', woven: null, stats: { mode: 'video', fieldOrder: 'tff', fallback: false } });
  const db = scored('00000 auto', shot, refPictures(refs.video2s), Math.round(shot.timestampUs / FIELD_US) - refs.video2s.firstField);
  expect(db).toBeGreaterThanOrEqual(VIDEO_PSNR_DB);
});

test('video mode plays in sync (00000)', async ({ page, browserName }) => {
  skipSyncInFirefox(browserName);
  await openPlaylist(page, '00000');
  const windows = await collectWindows(page, 3_800_000);
  expect(windows.length).toBeGreaterThan(3);
  for (const w of windows) expect(w.clockMode).toBe('audio');
  expectInSync(windows);
  expect((await deinterlaceOf(page))?.stats).toMatchObject({ mode: 'video', fallback: false });
});

test('bottom field first video (00001) is found to be bottom field first', async ({ page }) => {
  await openPlaylist(page, '00001', { realtime: false });
  await expect.poll(async () => (await deinterlaceOf(page))?.stats?.mode, { timeout: 10_000 }).toBe('video');
  await expect.poll(async () => (await telemetry(page))?.clockUs ?? 0, { timeout: 15_000 }).toBeGreaterThanOrEqual(1_000_000);
  expect((await deinterlaceOf(page))?.stats).toMatchObject({ mode: 'video', fieldOrder: 'bff' });
});

for (const { id, what } of [
  { id: '00002', what: 'hard 3:2 telecine' },
  { id: '00003', what: 'soft 3:2 pulldown' },
]) {
  test(`film through ${what} (${id}) plays as its 24 frames a second, each picture the source film frame`, async ({ page }) => {
    await recordTelemetrySamples(page);
    await openPlaylist(page, id);
    await expect.poll(async () => (await deinterlaceOf(page))?.stats?.mode, { timeout: 10_000 }).toBe('film');
    const shot = await capture(page, PICTURE_AT_US, refs.film2s);
    expect(shot.deinterlaced).toBe(true);
    const db = scored(`${id} film`, shot, refPictures(refs.film2s), Math.round(shot.timestampUs / FILM_FRAME_US) - refs.film2s.firstFilmFrame);
    expect(db).toBeGreaterThanOrEqual(FILM_PSNR_DB);

    // pictures presented over 3 s of playlist time once film is locked (the lock takes a few cycles from the start)
    await expect(page.getByTestId('player')).toHaveAttribute('data-state', 'ended', { timeout: 15_000 });
    const samples = (await telemetrySamples(page)).filter((t) => t.framesPresented !== undefined);
    const from = samples.find((t) => t.clockUs >= FILM_LOCKED_US);
    const to = from && [...samples].reverse().find((t) => t.clockUs <= 4_000_000 && t.clockUs - from.clockUs >= 2_500_000);
    expect(from && to, `two samples 2.5 s apart in ${samples.map((t) => t.clockUs).join(' ')}`).toBeTruthy();
    const per3s = ((to!.framesPresented! - from!.framesPresented!) * 3_000_000) / (to!.clockUs - from!.clockUs);
    console.log(`${id}: ${to!.framesPresented! - from!.framesPresented!} pictures from ${from!.clockUs} to ${to!.clockUs} us, ${per3s.toFixed(1)} per 3 s`);
    expect(per3s).toBeGreaterThanOrEqual(70);
    expect(per3s).toBeLessThanOrEqual(74);
    expectFilmThroughout(samples as DeinterlaceSample[]);
  });
}

test('film mode plays in sync (00002)', async ({ page, browserName }) => {
  skipSyncInFirefox(browserName);
  await openPlaylist(page, '00002');
  const windows = await collectWindows(page, 3_800_000);
  expect(windows.length).toBeGreaterThan(3);
  for (const w of windows) expect(w.clockMode).toBe('audio');
  expectInSync(windows);
  expectFilmThroughout(windows as DeinterlaceSample[]);
});

test('Off draws the woven frames at once, combed where the picture moves', async ({ page }) => {
  await openPlaylist(page, '00000');
  const pictures = refPictures(refs.video2s);
  const auto = await capture(page, PICTURE_AT_US, refs.video2s);
  const autoDb = scored('00000 auto', auto, pictures, Math.round(auto.timestampUs / FIELD_US) - refs.video2s.firstField);

  await page.getByTestId('player').hover();
  await page.getByTestId('video-output-menu').click();
  await page.getByTestId('deinterlace-off').click();
  await expect.poll(async () => (await deinterlaceOf(page))?.setting, { timeout: 5_000 }).toBe('off');
  expect(await deinterlaceOf(page)).toMatchObject({ setting: 'off', stats: null, woven: 'Deinterlacing is off' });
  expect(await page.evaluate(() => localStorage.getItem('bluray-web:deinterlace'))).toBe('off');

  await seekTo(page, 1_000_000);
  await expect.poll(async () => (await telemetry(page))?.clockUs ?? Infinity, { timeout: 5_000 }).toBeLessThan(PICTURE_AT_US);
  await expect(page.getByTestId('player')).toHaveAttribute('data-state', 'playing', { timeout: 5_000 });
  const off = await capture(page, PICTURE_AT_US, refs.video2s);
  expect(off.deinterlaced).toBe(false);
  // a woven frame shows at a frame's time, the first field's
  const offDb = scored('00000 off', off, pictures, Math.round(off.timestampUs / FIELD_US) - refs.video2s.firstField);
  expect(offDb).toBeLessThan(autoDb - OFF_MARGIN_DB);
});

test('where the browser decodes to RGB, interlaced video plays woven and telemetry says why', async ({ page }) => {
  await page.goto('/?telemetry=1&videopath=canvas');
  await skipWithoutH264(page);
  await setFolder(page.getByTestId('folder-input'), DISC);
  await page.getByTestId('playlist-00000').click();
  await expect(page.getByTestId('player')).toHaveAttribute('data-state', 'playing', { timeout: 10_000 });
  await expect.poll(async () => (await telemetry(page))?.framesPresented ?? 0, { timeout: 10_000 }).toBeGreaterThan(0);
  const woven = (await deinterlaceOf(page))?.woven ?? '';
  test.skip(!/^The browser decodes to /.test(woven), 'this browser does not decode to RGB (the other tests cover what it does)');
  await expect.poll(async () => (await telemetry(page))?.clockUs ?? 0, { timeout: 15_000 }).toBeGreaterThanOrEqual(3_000_000);
  const t = await telemetry(page);
  expect(t?.decoderErrors).toBe(0);
  expect(t?.framesPresented ?? 0).toBeGreaterThanOrEqual(80);
  expect(await deinterlaceOf(page)).toMatchObject({ setting: 'auto', stats: null });
});

test("the deinterlacer's GPU passes equal their CPU references: field measurements, bwdif and the fall-back's line averaging", async ({ page }) => {
  const bundle = await build({ entryPoints: ['tests/e2e/deinterlace-gpu.ts'], bundle: true, write: false, format: 'iife', platform: 'browser', target: 'es2022', logLevel: 'silent' });
  await page.setContent('<!doctype html><meta charset="utf-8"><title>deinterlace GPU checks</title>');
  await page.addScriptTag({ content: bundle.outputFiles[0]!.text });
  const frames = (r: { file: string; width: number; height: number; frames: number }): LumaFrames => ({
    width: r.width,
    height: r.height,
    frames: r.frames,
    base64: gunzipSync(readFileSync(`${REF_DIR}/${r.file}`)).toString('base64'),
  });
  const report: GpuReport = await page.evaluate(([video, telecine]) => window.deinterlaceGpuChecks(video, telecine), [frames(refs.video), frames(refs.telecine)] as const);
  test.skip('unavailable' in report, 'unavailable' in report ? report.unavailable : '');
  const checks = 'checks' in report ? report.checks : [];
  for (const c of checks) console.log(`${c.ok ? 'ok  ' : 'FAIL'} ${c.name}: ${c.detail}`);
  expect(checks.length).toBeGreaterThan(40);
  expect(checks.filter((c) => !c.ok)).toEqual([]);
});
