// SPDX-License-Identifier: LGPL-3.0-or-later
import { expect, test } from '@playwright/test';

interface Result {
  file: string;
  ok: boolean;
  error?: string;
}

test('browser examples run', async ({ page }, info) => {
  test.skip(info.project.name !== 'chromium', 'the browser examples run in desktop Chrome only');
  const response = await page.goto('/developers/_examples/');
  const body = response?.ok() ? await response.text() : '';
  // The developer site's build emits the page; a build without it (the preview server then answers with the player) has nothing to run.
  test.skip(!body.includes('data-examples-page'), 'the build does not emit /developers/_examples/ yet');
  await page.waitForFunction(() => (window as unknown as { __examplesDone?: boolean }).__examplesDone === true, undefined, { timeout: 30_000 });
  const results = await page.evaluate(() => (window as unknown as { __examples: Result[] }).__examples);
  // Browser examples exist (the renderer's, at least), so a page that ran none is a broken page, not a pass.
  expect(results.length).toBeGreaterThan(0);
  for (const r of results) expect(r.ok, `${r.file}: ${r.error ?? ''}`).toBe(true);
});
