// SPDX-License-Identifier: LGPL-3.0-or-later
import { existsSync, readdirSync } from 'node:fs';
import { expect, test } from '@playwright/test';

interface Result {
  file: string;
  ok: boolean;
  error?: string;
}

/** Every `packages/<pkg>/examples/*.browser.ts`, from the repository root, sorted. */
function browserExamples(): string[] {
  const out: string[] = [];
  for (const pkg of readdirSync('packages')) {
    const dir = `packages/${pkg}/examples`;
    if (existsSync(dir)) for (const f of readdirSync(dir)) if (f.endsWith('.browser.ts')) out.push(`${dir}/${f}`);
  }
  return out.sort();
}

test('browser examples run', async ({ page }, info) => {
  test.skip(info.project.name !== 'chromium', 'the browser examples run in desktop Chrome only');
  const response = await page.goto('/developers/_examples/');
  const body = response?.ok() ? await response.text() : '';
  // The developer site's build emits the page; a build without it (the preview server then answers with the player) fails here.
  expect(body, 'the build must emit /developers/_examples/').toContain('data-examples-page');
  await page.waitForFunction(() => (window as unknown as { __examplesDone?: boolean }).__examplesDone === true, undefined, { timeout: 30_000 });
  const results = await page.evaluate(() => (window as unknown as { __examples: Result[] }).__examples);
  // The page must have run every browser example on disk, so one dropped from it fails here.
  expect(results.map((r) => r.file).sort()).toEqual(browserExamples());
  for (const r of results) expect(r.ok, `${r.file}: ${r.error ?? ''}`).toBe(true);
});
