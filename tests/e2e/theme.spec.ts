import { expect, test, type Page } from '@playwright/test';
import { setFolder } from './support';

const DISC = 'fixtures/synthetic/disc1';
const LIGHT = '#f6f8fe';
const DARK = '#0a1330';

const theme = (page: Page) => page.evaluate(() => document.documentElement.dataset.theme);
const themeColors = (page: Page) => page.evaluate(() => [...document.querySelectorAll('meta[name="theme-color"]')].map((m) => m.getAttribute('content')));

test('opens light on a light device with Auto, with no dark first', async ({ page }) => {
  await page.emulateMedia({ colorScheme: 'light' });
  await page.addInitScript(() => {
    document.addEventListener('DOMContentLoaded', () => {
      (window as unknown as { __themeAtLoad?: string }).__themeAtLoad = document.documentElement.dataset.theme;
    });
  });
  await page.goto('/');
  await expect(page.getByTestId('theme-switch')).toBeVisible();
  expect(await page.evaluate(() => (window as unknown as { __themeAtLoad?: string }).__themeAtLoad)).toBe('light');
  expect(await theme(page)).toBe('light');
  await expect(page.getByTestId('theme-auto')).toBeChecked();
  expect(await themeColors(page)).toEqual([LIGHT, LIGHT]);
});

test('Dark survives a reload, and Light works on a dark device', async ({ page }) => {
  await page.emulateMedia({ colorScheme: 'light' });
  await page.goto('/');
  await page.getByTestId('theme-dark').click();
  expect(await theme(page)).toBe('dark');
  await page.reload();
  await expect(page.getByTestId('theme-dark')).toBeChecked();
  expect(await theme(page)).toBe('dark');
  await page.emulateMedia({ colorScheme: 'dark' });
  await page.getByTestId('theme-light').click();
  expect(await theme(page)).toBe('light');
  expect(await themeColors(page)).toEqual([LIGHT, LIGHT]);
});

test('Auto follows the device while open', async ({ page }) => {
  await page.goto('/');
  // Playwright's Firefox drops a colour scheme emulated before the first navigation, so it is set once the page is open
  await page.emulateMedia({ colorScheme: 'dark' });
  await expect(page.getByTestId('theme-auto')).toBeChecked();
  await expect.poll(() => theme(page)).toBe('dark');
  await page.emulateMedia({ colorScheme: 'light' });
  await expect.poll(() => theme(page)).toBe('light');
  await page.emulateMedia({ colorScheme: 'dark' });
  await expect.poll(() => theme(page)).toBe('dark');
  await page.getByTestId('theme-light').click();
  await page.emulateMedia({ colorScheme: 'dark' });
  await page.waitForTimeout(200);
  expect(await theme(page)).toBe('light');
});

test('help follows the theme and has the switch', async ({ page }) => {
  await page.emulateMedia({ colorScheme: 'dark' });
  await page.goto('/');
  await page.getByTestId('theme-light').click();
  await page.goto('/help/nas');
  await expect(page.getByTestId('help-page')).toBeVisible();
  expect(await theme(page)).toBe('light');
  await expect(page.getByTestId('theme-switch')).toBeVisible();
  await expect(page.getByTestId('theme-light')).toBeChecked();
});

test('a disc is dark in light mode and light returns when it closes', async ({ page }) => {
  await page.emulateMedia({ colorScheme: 'light' });
  await page.goto('/');
  await page.getByTestId('theme-light').click();
  await setFolder(page.getByTestId('folder-input'), DISC);
  await expect(page.getByTestId('playlist-00000')).toBeVisible();
  await expect.poll(() => theme(page)).toBe('dark');
  expect(await themeColors(page)).toEqual([DARK, DARK]);
  await expect(page.getByTestId('theme-switch')).toHaveCount(0);
  await page.getByRole('button', { name: 'Open another disc' }).click();
  await expect(page.getByTestId('landing')).toBeVisible();
  await expect.poll(() => theme(page)).toBe('light');
  await expect(page.getByTestId('theme-light')).toBeChecked();
});

test('the NAS bar fits a narrow phone with the switch and Help on screen', async ({ page }) => {
  await page.setViewportSize({ width: 360, height: 740 });
  await page.goto('/nas/pair');
  await expect(page.getByTestId('theme-switch')).toBeVisible();
  const fit = await page.evaluate(() => {
    const help = document.querySelector('[data-testid="help-link"]')!.getBoundingClientRect();
    const option = document.querySelector('.theme-option')!.getBoundingClientRect();
    return { scroll: document.documentElement.scrollWidth, width: window.innerWidth, helpRight: help.right, optionHeight: option.height };
  });
  expect(fit.scroll).toBeLessThanOrEqual(fit.width);
  expect(fit.helpRight).toBeLessThanOrEqual(fit.width - 16);
});

test('the page is dark before the player first paints', async ({ page }) => {
  await page.emulateMedia({ colorScheme: 'light' });
  await page.goto('/');
  await page.getByTestId('theme-light').click();
  // a MutationObserver callback runs before the next paint: the theme seen when the player is inserted is the first frame's
  await page.evaluate(() => {
    const w = window as unknown as { __themeAtPlayer?: string; __themeAtLanding?: string };
    new MutationObserver(() => {
      if (w.__themeAtPlayer === undefined && document.querySelector('[data-testid="player"]')) w.__themeAtPlayer = document.documentElement.dataset.theme;
      if (w.__themeAtPlayer !== undefined && w.__themeAtLanding === undefined && document.querySelector('[data-testid="landing"]'))
        w.__themeAtLanding = document.documentElement.dataset.theme;
    }).observe(document.body, { childList: true, subtree: true });
  });
  await setFolder(page.getByTestId('folder-input'), DISC);
  await expect(page.getByTestId('playlist-00000')).toBeVisible();
  await page.getByRole('button', { name: 'Open another disc' }).click();
  await expect(page.getByTestId('landing')).toBeVisible();
  expect(await page.evaluate(() => (window as unknown as { __themeAtPlayer?: string }).__themeAtPlayer)).toBe('dark');
  expect(await page.evaluate(() => (window as unknown as { __themeAtLanding?: string }).__themeAtLanding)).toBe('light');
});
