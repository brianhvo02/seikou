import { expect, test, type Page } from '@playwright/test';
import { expectBarHidden, expectBarShown, isLinuxWebKit, LINUX_WEBKIT_REALTIME, setFolder, skipWithoutH264 } from './support';
import { bdjStartup, telemetry } from './telemetry';
import { bdjPlane, clickPlane, flushedPast, MENU_DISC } from './bdj-support';

// fixtures/synthetic/disc-bdj (scripts/make-bdj-disc.ts): First Play is a BD-J object whose xlet starts TitleXlet,
// which plays playlist 00000 (2 s) and plays it again once it ends; then the player stays 'ended'.
const DISC = 'fixtures/synthetic/disc-bdj';

const notice = (page: Page, text: RegExp) => page.locator('.notice', { hasText: text });

/** Waits for a player state, sampled every animation frame: the disc's playlists are too short for expect's polling. */
async function reachesState(page: Page, state: string, timeout: number): Promise<void> {
  await page.waitForFunction((s) => document.querySelector('[data-testid="player"]')?.getAttribute('data-state') === s, state, { polling: 'raf', timeout });
}

async function open(page: Page, query = ''): Promise<void> {
  await page.goto(`/?telemetry=1${query}`);
  await skipWithoutH264(page);
  await setFolder(page.getByTestId('folder-input'), DISC);
}

test.beforeEach(({ browserName }) => test.skip(isLinuxWebKit(browserName), LINUX_WEBKIT_REALTIME));

test("plays the playlist the disc's Java selects, with no picker and no notice", async ({ page }) => {
  // Java's selections, from the BD-J log: between the two plays the player is 'ended' until the second arrives, for a
  // frame here and longer on a slow runner (CI run 44266015221 read the first play's telemetry there: 40 frames at 1.69 s)
  let selections = 0;
  page.on('console', (m) => {
    if (m.text().includes('bdj_process_event(PLAYLIST,')) selections++;
  });
  await open(page);
  await reachesState(page, 'playing', 30_000);
  await expect(page.getByTestId('player')).toHaveAttribute('data-playlist', '00000'); // the playlist Java selected
  await expect(page.getByTestId('playlist-picker')).toBeHidden();
  await expect(notice(page, /menu/)).toHaveCount(0); // 5c's "menu isn't shown yet" is gone
  await expect(page.getByTestId('player')).toHaveAttribute('data-bdj-menu', 'false'); // disc-bdj draws nothing
  await expect.poll(async () => (await bdjStartup(page))?.firstFrameMs ?? null, { timeout: 10_000 }).not.toBeNull();
  const startup = (await bdjStartup(page))!;
  console.log(`disc-bdj start-up: ${JSON.stringify(startup)}`);
  expect(startup.bootMs!).toBeLessThanOrEqual(startup.firstPlaylistMs!);
  expect(startup.firstPlaylistMs!).toBeLessThanOrEqual(startup.firstFrameMs!);
  // Java plays the playlist twice; then playback has ended, still under Java (no picker)
  await expect.poll(() => selections, { timeout: 15_000 }).toBe(2);
  await reachesState(page, 'playing', 15_000); // the second play (2 s)
  await reachesState(page, 'ended', 15_000);
  await expect(page.getByTestId('playlist-picker')).toBeHidden();
  const t = await telemetry(page);
  expect(t?.framesPresented).toBeGreaterThan(40);
  expect(t?.decoderErrors).toBe(0);
});

test('the picker stays reachable under a BD-J title, and a playlist chosen there plays', async ({ page }) => {
  await open(page);
  await reachesState(page, 'playing', 30_000);
  await page.getByTestId('player').hover();
  await page.getByRole('button', { name: /^(Playlists|Titles)$/ }).click();
  await expect(page.getByTestId('playlist-picker')).toBeVisible();
  await page.getByTestId('playlist-00000').click();
  await expect(page.getByTestId('playlist-picker')).toBeHidden();
  await reachesState(page, 'playing', 15_000);
});

test('a BD-J runtime that cannot boot (?bdjfail=1) falls back to the picker with a notice', async ({ page }) => {
  await open(page, '&bdjfail=1');
  await expect(page.getByTestId('playlist-picker')).toBeVisible({ timeout: 30_000 });
  await expect(notice(page, /^BD-J couldn't start this disc/)).toBeVisible();
  await page.getByTestId('playlist-00000').click();
  await reachesState(page, 'playing', 15_000);
});

// the BD-J menu disc's clicks, keys and taps on every browser: bdj-menu.spec.ts

test('the control bar never covers a BD-J menu: the bottom edge wakes it, a click in its empty space reaches the disc (R9)', async ({ page }) => {
  await page.goto('/?telemetry=1');
  await skipWithoutH264(page);
  await setFolder(page.getByTestId('folder-input'), MENU_DISC);
  const player = page.getByTestId('player');
  const bar = page.getByTestId('control-bar');
  await expect(player).toHaveAttribute('data-bdj-menu', 'true', { timeout: 30_000 });
  await expect.poll(async () => (await bdjPlane(page))?.flushes ?? 0, { timeout: 10_000 }).toBeGreaterThan(0);
  const box = (await player.boundingBox())!;
  const x = box.x + box.width / 2;
  const bottom = box.y + box.height;
  // over the menu the bar hides at once and the cursor stays
  await page.mouse.move(x, box.y + box.height / 2);
  await expectBarHidden(bar, 1_000);
  expect(await player.evaluate((el) => getComputedStyle(el).cursor)).not.toBe('none');
  // the lowest button (Extras, y 620-719) and the menu area below it do not wake the bar
  const scale = Math.min(box.width / 1920, box.height / 1080);
  const top = box.y + (box.height - 1080 * scale) / 2;
  for (const planeY of [670, 760, 900, 1000]) await page.mouse.move(x, top + planeY * scale);
  for (const dy of [60, 40, 26]) await page.mouse.move(x, bottom - dy);
  await page.waitForTimeout(300);
  await expectBarHidden(bar);
  // a click on Play (its MouseListener repaints) does not wake it either
  const shown = (await bdjPlane(page))!;
  await clickPlane(page, 300, 400);
  await flushedPast(page, shown.flushes);
  await expectBarHidden(bar);
  // the bottom 24 px wake it; back over the menu it hides at once
  await page.mouse.move(x, bottom - 10);
  await expectBarShown(bar, 1_000);
  await page.mouse.move(x, box.y + box.height / 2);
  await expectBarHidden(bar, 500);
  // with the bar shown, a click in its empty padding at the bottom edge reaches the disc (which ignores it: nothing is
  // there), so the remote opens; with the remote open the bar stays when the pointer goes back up (Task 8)
  await page.mouse.move(x, bottom - 10);
  await expectBarShown(bar, 1_000);
  const barBox = (await bar.boundingBox())!;
  const pad = { x: barBox.x + 6, y: barBox.y + barBox.height - 4 };
  expect(await page.evaluate(({ x, y }) => document.elementFromPoint(x, y)?.getAttribute('data-testid') ?? null, pad)).toBe('video-canvas');
  const before = (await bdjPlane(page))!.tapsIgnored;
  await page.mouse.click(pad.x, pad.y);
  await expect.poll(async () => (await bdjPlane(page))!.tapsIgnored, { timeout: 5_000 }).toBe(before + 1);
  await expect(page.getByTestId('remote-pad')).toBeVisible();
  await page.mouse.move(x, box.y + box.height / 2);
  await page.waitForTimeout(300);
  await expectBarShown(bar);
  await expect(page.getByTestId('remote-pad')).toBeVisible();
});

test('keys that go to a BD-J menu leave the control bar hidden; a player shortcut shows it (R11)', async ({ page }) => {
  await page.goto('/?telemetry=1');
  await skipWithoutH264(page);
  await setFolder(page.getByTestId('folder-input'), MENU_DISC);
  const player = page.getByTestId('player');
  const bar = page.getByTestId('control-bar');
  await expect(player).toHaveAttribute('data-bdj-menu', 'true', { timeout: 30_000 });
  const shown = await flushedPast(page, 0);
  const box = (await player.boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await expectBarHidden(bar, 1_000);
  await page.keyboard.press('ArrowDown'); // focus to Chapters: a repaint
  const down = await flushedPast(page, shown);
  await page.keyboard.press('ArrowUp');
  await flushedPast(page, down);
  await page.waitForTimeout(300);
  await expectBarHidden(bar);
  await page.keyboard.press('a'); // cycle audio: a player shortcut
  await expectBarShown(bar, 1_000);
});

test('a click on the video with an empty BD-J plane is play/pause, not a menu click; the remote is offered', async ({ page }) => {
  await open(page);
  await reachesState(page, 'playing', 30_000);
  await expect(page.getByTestId('player')).toHaveAttribute('data-bdj-menu', 'false');
  await page.getByTestId('video-canvas').click();
  await reachesState(page, 'paused', 5_000);
  // with no menu shown the control bar's empty space is the bar's own: a click there would not reach the video (R9)
  const bar = page.getByTestId('control-bar');
  await expectBarShown(bar);
  const barBox = (await bar.boundingBox())!;
  const pad = { x: barBox.x + 6, y: barBox.y + barBox.height - 4 };
  expect(await page.evaluate(({ x, y }) => document.elementFromPoint(x, y)?.closest('[data-testid="control-bar"]') !== null, pad)).toBe(true);
  await expect(notice(page, /doesn't respond to taps/)).toHaveCount(0);
  await page.getByTestId('remote-toggle').click();
  await expect(page.getByTestId('remote-pad')).toBeVisible();
});
