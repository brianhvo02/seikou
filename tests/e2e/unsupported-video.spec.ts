import { expect, test, type Page } from '@playwright/test';
import { setFolder } from './support';

// Video that can't be decoded here plays without a picture, as libbluray opens such playlists: audio, subtitles, menus
// and the clock run, and a notice says so once per disc. MPEG-2 and VC-1 have a decoder of their own (video.wasm in a
// worker); ?novideowasm=1 leaves it out, as in a browser that can't start a worker from a worker.
//
// fixtures/synthetic/disc-mpeg2-menu (scripts/make-mpeg2-disc.ts): real MPEG-2 video. First Play loops the top menu (playlist
// 00001, an always-on IG menu whose button 1 jumps to title 1); title 1 plays 00000 with PG subtitles on.
const MPEG2_DISC = 'fixtures/synthetic/disc-mpeg2-menu';
/** fixtures/synthetic/vc1-disc (scripts/make-error-fixtures.ts): no disc program, one playlist declaring VC-1 video. */
const VC1_DISC = 'fixtures/synthetic/vc1-disc';
const NOTICE = "This disc's video can't be played here yet, so it will play without a picture.";

interface Sample {
  clockUs: number;
  framesPresented?: number;
  menu: { page: number; selectedButton: number } | null;
  pg?: { objectsShown: number } | null;
}

const sample = (page: Page): Promise<Sample | null> =>
  page.evaluate(() => (window as unknown as { __blurayTelemetry?: Sample | null }).__blurayTelemetry ?? null);

const notices = (page: Page) => page.getByRole('status').filter({ hasText: NOTICE });

/** The clock moves on: two telemetry samples a second apart are at least 0.5 s apart. */
async function expectClockRunning(page: Page): Promise<void> {
  await expect.poll(async () => (await sample(page))?.clockUs ?? 0, { timeout: 10_000 }).toBeGreaterThan(0);
  const from = (await sample(page))!.clockUs;
  await expect.poll(async () => (await sample(page))!.clockUs - from, { timeout: 10_000 }).toBeGreaterThan(500_000);
}

test('an MPEG-2 disc opens into its menu without a picture, with the notice and a running clock', async ({ page }) => {
  await page.goto('/?telemetry=1&novideowasm=1');
  await setFolder(page.getByTestId('folder-input'), MPEG2_DISC);
  await expect(page.getByTestId('player')).toHaveAttribute('data-menu-active', 'true', { timeout: 10_000 });
  await expect.poll(async () => (await sample(page))?.menu?.selectedButton ?? null, { timeout: 10_000 }).toBe(1);
  await expect(page.getByTestId('playlist-picker')).toBeHidden();
  await expect(notices(page)).toHaveCount(1);
  await expect(page.getByTestId('error')).toBeHidden();
  await expectClockRunning(page);
  expect((await sample(page))!.framesPresented ?? 0).toBe(0);

  // the menu's button starts title 1: another MPEG-2 playlist of the same disc, with no second notice
  await page.keyboard.press('Enter');
  await expect(page.getByTestId('player')).toHaveAttribute('data-menu-active', 'false', { timeout: 10_000 });
  await expect(page.getByTestId('player')).toHaveAttribute('data-state', 'playing', { timeout: 10_000 });
  await expectClockRunning(page);
  await expect(notices(page)).toHaveCount(1);
  expect((await sample(page))!.framesPresented ?? 0).toBe(0);
});

test('a VC-1 playlist picked in the picker plays without a picture, and another disc shows the notice again', async ({ page }) => {
  await page.goto('/?telemetry=1&novideowasm=1');
  await setFolder(page.getByTestId('folder-input'), VC1_DISC);
  await page.getByTestId('playlist-00000').click();
  await expect(page.getByTestId('player')).toHaveAttribute('data-state', 'playing', { timeout: 10_000 });
  await expect(notices(page)).toHaveCount(1);
  await expect(page.getByTestId('error')).toBeHidden();
  await expectClockRunning(page);

  // another disc in the same session: its own notice
  await page.getByTestId('player').hover();
  await page.getByRole('button', { name: 'Playlists' }).click();
  await page.getByRole('button', { name: 'Open another disc' }).click();
  await expect(page.getByTestId('landing')).toBeVisible();
  await setFolder(page.getByTestId('folder-input'), MPEG2_DISC);
  await expect(page.getByTestId('player')).toHaveAttribute('data-menu-active', 'true', { timeout: 10_000 });
  await expect(notices(page)).toHaveCount(1);
});
