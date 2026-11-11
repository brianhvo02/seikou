// SPDX-License-Identifier: LGPL-3.0-or-later
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test, type Page } from '@playwright/test';

/** Requests that would mean the player engine started: its worker module, the audio decoders, the BD-J class library. */
const ENGINE = /engine-worker|bdj-worker|worker-main|\.wasm(\?|$)|\.jar(\?|$)/;

function recordRequests(page: Page): string[] {
  const urls: string[] = [];
  page.on('request', (r) => urls.push(r.url()));
  return urls;
}

test('the index lists the eight packages', async ({ page }) => {
  await page.goto('/developers');
  await expect(page.locator('h1')).toHaveCount(1);
  await expect(page.locator('a.pkg-row')).toHaveCount(8);
  for (const name of ['bdmv', 'pg', 'ass', 'engine', 'matroska', 'nas', 'titles', 'fansubs']) {
    await expect(page.locator('a.pkg-row', { hasText: `@seikou/${name}` })).toHaveAttribute('href', `/developers/${name}`);
  }
});

test('an export page shows its signature and example without starting the engine', async ({ page }) => {
  const requests = recordRequests(page);
  const response = await page.goto('/developers/bdmv/parseMpls');
  expect(response?.status()).toBe(200);
  await expect(page.locator('h1')).toHaveText('parseMpls');
  await expect(page.locator('pre.signature').first()).toContainText('parseMpls(');
  await expect(page.locator('figure.example pre.code')).toContainText('parseMpls');
  // the stylesheet arrived (the page's background is the token's, not the browser's white)
  expect(await page.evaluate(() => getComputedStyle(document.body).backgroundColor)).not.toBe('rgba(0, 0, 0, 0)');
  // Instrument Sans came from the site itself
  const font = await page.evaluate(async () => {
    await document.fonts.ready;
    return [...document.fonts].some((f) => f.family.includes('Instrument Sans') && f.status === 'loaded');
  });
  expect(font).toBe(true);
  expect(requests.filter((u) => u.includes('/developers/fonts/'))).not.toEqual([]);
  await page.waitForLoadState('networkidle');
  expect(requests.filter((u) => ENGINE.test(u))).toEqual([]);
});

test('search offers an export and Enter goes to it', async ({ page }) => {
  const requests = recordRequests(page);
  await page.goto('/developers');
  const input = page.locator('.search-input');
  await input.fill('mpls');
  await expect(page.locator('.search-results')).toBeVisible();
  await expect(page.locator('.search-results')).toContainText('parseMpls');
  await input.fill('parseMpls');
  await expect(page.locator('.search-results')).toContainText('parseMpls');
  await input.press('Enter');
  await expect(page).toHaveURL(/\/developers\/bdmv\/parseMpls$/);
  await expect(page.locator('h1')).toHaveText('parseMpls');
  expect(requests.filter((u) => ENGINE.test(u))).toEqual([]);
});

test('an unknown developer address answers the developer 404', async ({ page }) => {
  const response = await page.goto('/developers/nope');
  expect(response?.status()).toBe(404);
  await expect(page.locator('h1')).toHaveText('No page at this address');
  await expect(page.locator('body.dev')).toHaveCount(1);
});

test('the theme switch sets data-theme and survives a reload', async ({ page }) => {
  await page.goto('/developers/bdmv');
  await expect(page.locator('body.dev')).toHaveCount(1);
  const light = page.locator('.theme-switch input[value="light"]');
  await light.check({ force: true });
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
  await page.reload();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
  await expect(light).toBeChecked();
  await page.locator('.theme-switch input[value="dark"]').check({ force: true });
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  await page.reload();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
});

test('every page has one h1, and a focused link shows a ring', async ({ page }) => {
  for (const path of ['/developers', '/developers/bdmv', '/developers/bdmv/parseMpls', '/developers/integrating', '/developers/nope']) {
    await page.goto(path);
    await expect(page.locator('h1'), path).toHaveCount(1);
  }
  await page.goto('/developers/bdmv');
  // Tab skips links in WebKit on macOS, so focus the link and then press a key: :focus-visible applies after a keyboard event.
  await page.locator('header a').first().focus();
  await page.keyboard.press('Shift');
  const ring = await page.evaluate(() => {
    const el = document.activeElement as HTMLElement | null;
    if (!el || el.tagName !== 'A') return null;
    const s = getComputedStyle(el);
    return { style: s.outlineStyle, width: parseFloat(s.outlineWidth) };
  });
  expect(ring).not.toBeNull();
  expect(ring!.style).not.toBe('none');
  expect(ring!.width).toBeGreaterThan(0);
});

/** Every file under `dir` (a path from the repository root), as paths from it. */
function filesUnder(dir: string): string[] {
  return readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((e) => e.isFile())
    .map((e) => join(e.parentPath, e.name));
}

test("the examples page shares no chunk with the player, so the player's chunks are its own", () => {
  // Built as another entry of the player's build, the examples page split the code they share into new player chunks
  // (ThemeSwitch, create-controller), and WebKit then never recovered a failed lazy import of the help screen.
  const scripts = (dir: string): string[] => filesUnder(dir).filter((f) => /\.(js|mjs)$/.test(f));
  const examples = scripts('dist/developers/_examples');
  expect(examples.length, 'the build must emit the examples page').toBeGreaterThan(0);
  const reachPlayer = examples.filter((f) => /(^|["'`(/])(\.\.\/)+assets\/|["'`]\/assets\//.test(readFileSync(f, 'utf8')));
  expect(reachPlayer, 'examples files that import the player\'s chunks').toEqual([]);
  const reachExamples = scripts('dist/assets').filter((f) => readFileSync(f, 'utf8').includes('developers/_examples'));
  expect(reachExamples, 'player chunks that name the examples page').toEqual([]);
});

test.describe('with the player service worker installed', () => {
  test.use({ serviceWorkers: 'allow' }); // blocked for every other spec in playwright.config.ts

  test('developer addresses still reach the developer pages', async ({ page }) => {
    await page.goto('/');
    await page.evaluate(async () => {
      await navigator.serviceWorker.ready;
    });
    await page.reload(); // now controlled by the service worker
    expect(await page.evaluate(() => navigator.serviceWorker.controller !== null)).toBe(true);
    const found = await page.goto('/developers/bdmv/parseMpls');
    expect(found?.status()).toBe(200);
    await expect(page.locator('h1')).toHaveText('parseMpls');
    await expect(page.locator('body.dev')).toHaveCount(1);
    const missing = await page.goto('/developers/nope');
    expect(missing?.status()).toBe(404);
    await expect(page.locator('h1')).toHaveText('No page at this address');
    // the player's precache holds none of the developer files
    const cached = await page.evaluate(async () => {
      const out: string[] = [];
      for (const name of await caches.keys()) for (const req of await (await caches.open(name)).keys()) out.push(new URL(req.url).pathname);
      return out;
    });
    expect(cached.filter((p) => p.startsWith('/developers'))).toEqual([]);
  });
});
