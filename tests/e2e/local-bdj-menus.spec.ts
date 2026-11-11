import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import { CHROME_ONLY, expectBarHidden, setFolder } from './support';

/**
 * Menu responsiveness on the developer's BD-J discs (5d spec §4.2): a key press or a click reaches a visible menu
 * change within 0.2 s on a computer. The engine times it (telemetry bdj.inputLatencyMs): from the input reaching the
 * engine to the next presented frame that contains a plane change published after it. Before each input the plane is
 * left to settle (no flush for a while), so the change the input brings is the one timed.
 */
test.skip(({ browserName, isMobile }) => browserName !== 'chromium' || isMobile, CHROME_ONLY);

const LOCAL = 'fixtures/local';
const BAR_MS = 200;

interface MenuTelemetry {
  readonly flushes: number;
  readonly tapsIgnored: number;
  readonly latency: { readonly last: number; readonly max: number; readonly count: number } | null;
}

const menuTelemetry = (page: Page): Promise<MenuTelemetry> =>
  page.evaluate(() => {
    const t = (window as unknown as {
      __blurayTelemetry?: {
        bdjPlane: { flushes: number; tapsIgnored: number } | null;
        bdj: { inputLatencyMs: MenuTelemetry['latency'] } | null;
      } | null;
    }).__blurayTelemetry;
    return { flushes: t?.bdjPlane?.flushes ?? 0, tapsIgnored: t?.bdjPlane?.tapsIgnored ?? 0, latency: t?.bdj?.inputLatencyMs ?? null };
  });

/** Waits until the plane has not flushed for `quietMs` (an animation, a fade-in, a menu still drawing). */
async function settled(page: Page, quietMs: number, timeoutMs = 60_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let last = (await menuTelemetry(page)).flushes;
  let since = Date.now();
  while (Date.now() < deadline) {
    await page.waitForTimeout(100);
    const flushes = (await menuTelemetry(page)).flushes;
    if (flushes !== last) {
      last = flushes;
      since = Date.now();
    } else if (Date.now() - since >= quietMs) {
      return;
    }
  }
  throw new Error(`the BD-J plane kept flushing for ${timeoutMs} ms`);
}

/** Presses `key` on a settled menu, waits for the change it brings and checks how long it took to show. */
async function timedKey(page: Page, disc: string, key: string, quietMs = 1000): Promise<number> {
  await settled(page, quietMs);
  const before = (await menuTelemetry(page)).latency?.count ?? 0;
  await page.keyboard.press(key);
  await expect.poll(async () => (await menuTelemetry(page)).latency?.count ?? 0, { timeout: 5_000, message: `${disc}: ${key} changed nothing` }).toBeGreaterThan(before);
  const ms = (await menuTelemetry(page)).latency!.last;
  console.log(`${disc}: ${key} → menu change shown in ${ms} ms`);
  expect(ms, `${disc}: ${key} (ms)`).toBeLessThanOrEqual(BAR_MS);
  return ms;
}

async function open(page: Page, disc: string): Promise<void> {
  await page.goto('/?telemetry=1');
  await setFolder(page.getByTestId('folder-input'), join(LOCAL, disc));
}

test('BDJ_DISC_A: arrows and Enter on the main menu show within 0.2 s; a click, which the disc ignores, offers the remote', async ({ page }) => {
  test.skip(!process.env.LOCAL_DISCS, 'Set LOCAL_DISCS=1 to play the discs under fixtures/local in the browser.');
  test.skip(!existsSync(join(LOCAL, 'BDJ_DISC_A', 'BDMV')), 'fixtures/local/BDJ_DISC_A is not present');
  test.setTimeout(180_000);
  await open(page, 'BDJ_DISC_A');
  const player = page.getByTestId('player');
  await expect(player).toHaveAttribute('data-playlist', '00149', { timeout: 60_000 }); // the menu's playlist
  await expect(player).toHaveAttribute('data-bdj-menu', 'true', { timeout: 30_000 });
  await settled(page, 1500); // faded in, PLAY focused
  // the mouse over the menu hides the control bar at once (ruling R9)
  const bar = page.getByTestId('control-bar');
  const pbox = (await player.boundingBox())!;
  await page.mouse.move(pbox.x + pbox.width / 2, pbox.y + pbox.height / 2);
  await expectBarHidden(bar, 1_000);
  for (const key of ['ArrowRight', 'ArrowRight', 'ArrowLeft', 'ArrowLeft', 'ArrowRight']) await timedKey(page, 'BDJ_DISC_A', key); // CHAPTERS focused
  await timedKey(page, 'BDJ_DISC_A', 'Enter'); // the chapters panel opens
  await expect(player).toHaveAttribute('data-playlist', '00149');
  // keys that go to the menu leave the bar hidden (R11), and so does the mouse over the row of buttons along the bottom
  // edge, just above the 24 px that wake the bar (R9)
  await expectBarHidden(bar);
  for (const fx of [0.2, 0.4, 0.5, 0.6, 0.8]) await page.mouse.move(pbox.x + pbox.width * fx, pbox.y + pbox.height - 40);
  await page.waitForTimeout(300);
  await expectBarHidden(bar);
  const max = (await menuTelemetry(page)).latency!.max;
  console.log(`BDJ_DISC_A: largest key latency ${max} ms`);

  // BDJ_DISC_A's menu has no mouse handling: a click is forwarded (BDJ_EVENT_MOUSE and the activate key) and, with no
  // reaction within the window, the remote opens by itself (the ignored-tap rule). The click goes to the middle of the
  // picture: the menu's buttons are along its bottom edge, under the player's control bar while that shows.
  await settled(page, 1000);
  const box = (await page.getByTestId('video-canvas').boundingBox())!;
  const scale = Math.min(box.width / 1920, box.height / 1080);
  const before = await menuTelemetry(page);
  await page.mouse.click(box.x + (box.width - 1920 * scale) / 2 + 960 * scale, box.y + (box.height - 1080 * scale) / 2 + 540 * scale);
  await expect.poll(async () => (await menuTelemetry(page)).tapsIgnored, { timeout: 5_000 }).toBe(before.tapsIgnored + 1);
  expect((await menuTelemetry(page)).latency?.count).toBe(before.latency?.count);
  await expect(page.getByTestId('remote-pad')).toBeVisible();
});

test('BDJ_DISC_B: arrows and Enter on the language picker and the main menu show within 0.2 s', async ({ page }) => {
  test.skip(!process.env.LOCAL_DISCS, 'Set LOCAL_DISCS=1 to play the discs under fixtures/local in the browser.');
  test.skip(!existsSync(join(LOCAL, 'BDJ_DISC_B', 'BDMV')), 'fixtures/local/BDJ_DISC_B is not present');
  test.setTimeout(240_000);
  await open(page, 'BDJ_DISC_B');
  const player = page.getByTestId('player');
  await expect(player).toHaveAttribute('data-bdj-menu', 'true', { timeout: 60_000 }); // the language picker
  await settled(page, 1500); // ENGLISH focused
  for (const key of ['ArrowDown', 'ArrowUp', 'ArrowRight', 'ArrowLeft']) await timedKey(page, 'BDJ_DISC_B', key);
  await timedKey(page, 'BDJ_DISC_B', 'Enter'); // ENGLISH: the picker is cleared
  // the main menu draws over playlist 00149 after about 15 s
  await expect(player).toHaveAttribute('data-playlist', '00149', { timeout: 60_000 });
  await expect(player).toHaveAttribute('data-bdj-menu', 'true', { timeout: 60_000 });
  await settled(page, 1500); // PLAY focused
  for (const key of ['ArrowRight', 'ArrowLeft']) await timedKey(page, 'BDJ_DISC_B', key);
  await timedKey(page, 'BDJ_DISC_B', 'Enter'); // PLAY
  const max = (await menuTelemetry(page)).latency!.max;
  console.log(`BDJ_DISC_B: largest key latency ${max} ms`);
});
