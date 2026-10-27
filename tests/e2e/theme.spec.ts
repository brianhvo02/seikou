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
