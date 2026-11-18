import { expect, test, type Page } from '@playwright/test';
import { setFolder, skipWithoutH264 } from './support';

// Small-screen layout (Pixel 7 emulation, touch). The controls container is [data-testid=control-bar] (.control-bar).
const DISC = 'fixtures/synthetic/disc3'; // several audio tracks
const MENU_DISC = 'fixtures/synthetic/disc-menu'; // HDMV: has the Remote toggle
const MIN_TARGET = 44;

async function play(page: Page, disc: string, playlist?: string): Promise<void> {
  await page.goto('/?telemetry=1');
  await skipWithoutH264(page);
  await setFolder(page.getByTestId('folder-input'), disc);
  if (playlist) await page.getByTestId(playlist).click();
  await expect(page.getByTestId('player')).toBeVisible({ timeout: 10_000 });
  await expect(page.getByTestId('control-bar')).not.toHaveClass(/hidden/);
}

const noOverflow = (page: Page) => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth);

async function inViewport(page: Page, testId: string): Promise<void> {
  const box = (await page.locator(`[data-testid=${testId}] ~ .audio-menu-list`).boundingBox())!;
  const vp = page.viewportSize()!;
  expect(box, testId).toBeTruthy();
  expect(box.x).toBeGreaterThanOrEqual(0);
  expect(box.y).toBeGreaterThanOrEqual(0);
  expect(box.x + box.width).toBeLessThanOrEqual(vp.width + 0.5);
  expect(box.y + box.height).toBeLessThanOrEqual(vp.height + 0.5);
}

for (const size of [
  { width: 390, height: 844 },
  { width: 844, height: 390 },
]) {
  test.describe(`${size.width}x${size.height}`, () => {
    test.use({ viewport: size });

    test('the start screen fits the screen, its app bar included', async ({ page }) => {
      await page.goto('/');
      await expect(page.getByTestId('open-folder')).toBeVisible();
      // A page wider than a phone's screen is zoomed out to fit, and the player opened from it could keep the zoom's
      // horizontal scroll (CI run 44266015221: a menu sheet at x = -17).
      expect(await noOverflow(page)).toBe(true);
      expect(await page.evaluate(() => window.innerWidth)).toBe(size.width);
      for (const id of ['help-link', 'disc-preferences-button', 'theme-switch']) {
        const el = page.getByTestId(id);
        if ((await el.count()) === 0) continue;
        const box = (await el.boundingBox())!;
        expect(box.x, `${id} x`).toBeGreaterThanOrEqual(0);
        expect(box.x + box.width, `${id} right`).toBeLessThanOrEqual(size.width + 0.5);
      }
    });

    test('controls fit the screen and every button is a 44x44 touch target', async ({ page }) => {
      await play(page, DISC, 'playlist-00000');
      expect(await noOverflow(page)).toBe(true);
      const targets = page.locator('[data-testid=control-bar] button:visible, [data-testid=control-bar] input[type=range]:visible');
      const count = await targets.count();
      expect(count).toBeGreaterThan(5);
      for (let i = 0; i < count; i++) {
        const el = targets.nth(i);
        const box = (await el.boundingBox())!;
        const label = await el.evaluate((n) => n.getAttribute('aria-label') ?? n.textContent ?? n.tagName);
        expect(box.width, `${label} width`).toBeGreaterThanOrEqual(MIN_TARGET);
        expect(box.height, `${label} height`).toBeGreaterThanOrEqual(MIN_TARGET);
        expect(box.x, `${label} x`).toBeGreaterThanOrEqual(0);
        expect(box.x + box.width, `${label} right`).toBeLessThanOrEqual(size.width + 0.5);
      }
    });

    for (const menu of ['audio-menu', 'subtitle-menu', 'shader-menu']) {
      test(`the ${menu} opens inside the viewport`, async ({ page }) => {
        await play(page, DISC, 'playlist-00000');
        if (menu === 'subtitle-menu') {
          // a loaded file adds the offset and size adjusters (UTF-8, so no encoding prompt)
          const srt = Buffer.from('1\n00:00:06,000 --> 00:00:08,000\nHello\n', 'utf8');
          await page.getByTestId('subtitle-file-input').setInputFiles({ name: 'utf8.srt', mimeType: 'text/plain', buffer: srt });
        }
        await page.getByTestId(menu).click();
        await expect(page.locator('[data-testid=control-bar] .audio-menu-list')).toBeVisible();
        await inViewport(page, menu);
        if (menu === 'subtitle-menu') {
          for (const id of ['subtitle-offset-minus', 'subtitle-offset-plus', 'subtitle-size-minus', 'subtitle-size-plus']) {
            const b = (await page.getByTestId(id).boundingBox())!;
            expect(b, id).toBeTruthy();
            expect(b.width, `${id} width`).toBeGreaterThanOrEqual(MIN_TARGET);
            expect(b.height, `${id} height`).toBeGreaterThanOrEqual(MIN_TARGET);
          }
          const items = page.locator('[data-testid=subtitle-menu] ~ .audio-menu-list button:visible');
          expect(await items.count()).toBeGreaterThan(1);
          for (let i = 0; i < (await items.count()); i++) {
            const b = (await items.nth(i).boundingBox())!;
            expect(b.height).toBeGreaterThanOrEqual(MIN_TARGET);
            expect(b.width).toBeGreaterThanOrEqual(MIN_TARGET);
          }
        }
        expect(await noOverflow(page)).toBe(true);
      });
    }

    test('the encoding prompt stays above the bottom sheets', async ({ page }) => {
      await play(page, 'fixtures/synthetic/disc-subs');
      // open a bottom sheet first, so the prompt has something to stack above
      await page.getByTestId('subtitle-menu').click();
      await expect(page.locator('[data-testid=control-bar] .audio-menu-list')).toBeVisible();
      const latin1 = Buffer.from('1\n00:00:06,000 --> 00:00:08,000\nCaf\u00e9\n', 'latin1');
      await page.getByTestId('subtitle-file-input').setInputFiles({ name: 'latin1.srt', mimeType: 'text/plain', buffer: latin1 });
      await expect(page.getByTestId('encoding-prompt')).toBeVisible();
      await expect(page.locator('[data-testid=control-bar] .audio-menu-list')).toBeVisible();
      const top = await page.evaluate(() => {
        const prompt = document.querySelector('[data-testid=encoding-prompt]')!;
        const r = prompt.getBoundingClientRect();
        const hit = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2);
        return { inside: prompt.contains(hit), z: Number(getComputedStyle(prompt.parentElement!).zIndex) };
      });
      expect(top.inside).toBe(true);
      expect(top.z).toBeGreaterThan(40);
    });

    test('the Remote toggle is visible and the page does not overflow', async ({ page }) => {
      await play(page, MENU_DISC);
      await expect(page.getByTestId('remote-toggle')).toBeVisible({ timeout: 10_000 });
      const box = (await page.getByTestId('remote-toggle').boundingBox())!;
      expect(box.x + box.width).toBeLessThanOrEqual(size.width + 0.5);
      expect(await noOverflow(page)).toBe(true);
    });
  });
}
