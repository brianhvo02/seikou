import { expect, test } from '@playwright/test';

test('a help page opens directly and links to the others in the app', async ({ page, baseURL }) => {
  const elsewhere: string[] = [];
  page.on('request', (r) => {
    if (new URL(r.url()).origin !== new URL(baseURL!).origin && !r.url().startsWith('data:')) elsewhere.push(r.url());
  });
  await page.goto('/help/troubleshooting');
  const article = page.getByTestId('help-page');
  await expect(article.getByRole('heading', { level: 1 })).toHaveText('Troubleshooting');
  await expect(page).toHaveTitle(/Troubleshooting/);
  expect(await page.evaluate(() => crossOriginIsolated)).toBe(true);
  await expect(page.getByRole('navigation', { name: 'Help pages' }).getByRole('link', { name: 'Troubleshooting' })).toHaveAttribute('aria-current', 'page');

  // a link between pages, written as nas.md in the Markdown
  await article.locator('a[href="/help/nas"]').first().click();
  await expect(page).toHaveURL(/\/help\/nas$/);
  await expect(page.getByTestId('help-page').getByRole('heading', { level: 1 })).toHaveText('NAS');
  await page.goBack();
  await expect(page).toHaveURL(/\/help\/troubleshooting$/);
  await expect(page.getByTestId('help-page').getByRole('heading', { level: 1 })).toHaveText('Troubleshooting');
  expect(elsewhere).toEqual([]);
});

test("the landing screen's Help link opens the index, and the index opens a page", async ({ page }) => {
  await page.goto('/');
  await page.getByTestId('help-link').click();
  await expect(page).toHaveURL(/\/help$/);
  const index = page.getByTestId('help-index');
  await expect(index.getByRole('heading', { level: 1 })).toHaveText('Help');
  await expect(index.getByRole('listitem')).toHaveCount(6);
  await index.getByRole('link', { name: 'Playing discs' }).click();
  await expect(page).toHaveURL(/\/help\/playing-discs$/);
  await expect(page.getByTestId('help-page').getByRole('heading', { level: 1 })).toHaveText('Playing discs');
  await page.getByTestId('help-home').click();
  await expect(page).toHaveURL(/\/$/);
  await expect(page.getByTestId('landing')).toBeVisible();
});

test("a help screen that can't load says so and offers a reload", async ({ page }) => {
  await page.route(/\/assets\/HelpScreen-[^/]*\.js$/, (route) => route.abort());
  await page.goto('/help/nas');
  const failed = page.getByTestId('help-load-failed');
  await expect(failed).toContainText("Couldn't load the help pages.");
  await page.unroute(/\/assets\/HelpScreen-[^/]*\.js$/);
  await failed.getByRole('button', { name: 'Reload' }).click();
  await expect(page.getByTestId('help-page').getByRole('heading', { level: 1 })).toHaveText('NAS');
});

test('an unknown help page shows the index', async ({ page }) => {
  await page.goto('/help/no-such-page');
  await expect(page.getByTestId('help-index')).toBeVisible();
});

test.describe('offline', () => {
  test.use({ serviceWorkers: 'allow' }); // blocked for every other spec in playwright.config.ts

  test('help pages open offline after the first visit', async ({ page, context }) => {
    await page.goto('/');
    await page.evaluate(async () => {
      await navigator.serviceWorker.ready;
    });
    await context.setOffline(true);
    await page.goto('/help/nas');
    await expect(page.getByTestId('help-page').getByRole('heading', { level: 1 })).toHaveText('NAS');
  });
});

test('the Credits page shows the FreeType notice and the CC BY attribution', async ({ page }) => {
  await page.goto('/help/credits');
  const article = page.getByTestId('help-page');
  await expect(article.getByRole('heading', { level: 1 })).toHaveText('Credits');
  await expect(article).toContainText('Portions of this software are copyright © The FreeType Project (www.freetype.org). All rights reserved.');
  await expect(article).toContainText('Stumpy Lake forest in HD');
  await expect(article.locator('a[href="http://creativecommons.org/licenses/by/2.5/"]')).toBeVisible();
});
