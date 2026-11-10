// SPDX-License-Identifier: LGPL-3.0-or-later
import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test, type APIRequestContext, type Page } from '@playwright/test';

// The encoder app from the library to finished encodes, against `seikou-encode app` as playwright.encoder.config.ts
// starts it: a library of the speech disc and disc1, recorded answers for the made-up show Lantern Harbor, and an
// output folder of the test's own. The tests run in order and share the app's queue.

/** The app's address with this run's token, from the server's output. */
function appUrl(): string {
  const url = process.env.APP_URL;
  if (!url) throw new Error('APP_URL is not set: run this spec through playwright.encoder.config.ts');
  return url;
}

/** The temporary folder the run's encodes go to, outside the library and the data directory. */
function outputRoot(): string {
  const out = process.env.SEIKOU_ENCODE_E2E_OUT;
  if (!out) throw new Error('SEIKOU_ENCODE_E2E_OUT is not set: run this spec through playwright.encoder.config.ts');
  return out;
}

const token = (): string => new URL(appUrl()).searchParams.get('t') ?? '';

/** An address on the app that keeps this run's token, as the app's own links do. */
const at = (path: string): string => new URL(`${path}${path.includes('?') ? '&' : '?'}t=${token()}`, appUrl()).href;

const headers = (): Record<string, string> => ({ Authorization: `Bearer ${token()}` });

interface JobView {
  id: string;
  state: string;
}

async function jobs(request: APIRequestContext): Promise<JobView[]> {
  const res = await request.get(new URL('/api/jobs', appUrl()).href, { headers: headers() });
  return ((await res.json()) as { jobs: JobView[] }).jobs;
}

/** The disc key of the library's disc named `name`, from its link on the Library page. */
async function discKey(page: Page, name: string): Promise<string> {
  await page.goto(at('/'));
  const href = await page.getByRole('link', { name: new RegExp(`^${name}`) }).getAttribute('href');
  const key = /^\/disc\/([^/?]+)/.exec(href ?? '')?.[1];
  expect(key).toBeDefined();
  return key ?? '';
}

const NO_TOOLS = 'needs VapourSynth with BestSource, SvtAv1EncApp and opusenc';

/** Whether the app found the encoder's tools, as a helper session on the disc reports it. */
async function toolsReady(request: APIRequestContext, key: string): Promise<boolean> {
  const made = await request.post(new URL('/api/sessions', appUrl()).href, { headers: headers(), data: { discKey: key, playlistId: '00000', episodeSpec: '1-3,4-' } });
  const id = ((await made.json()) as { id: string }).id;
  const session = await request.get(new URL(`/api/sessions/${id}`, appUrl()).href, { headers: headers() });
  return ((await session.json()) as { toolsReady: boolean }).toolsReady;
}

test.describe.serial('the app', () => {
  test('group a disc into episodes, choose subtitles, queue the encode and watch it finish', async ({ page, request }) => {
    test.setTimeout(420_000);
    const problems: string[] = [];
    page.on('pageerror', (e) => problems.push(`page error: ${e.message}`));
    page.on('response', (r) => {
      if (r.status() >= 400 && !new URL(r.url()).pathname.endsWith('/events')) problems.push(`${r.status()} ${new URL(r.url()).pathname}`);
    });

    // Library
    await page.goto(at('/'));
    await expect(page.getByRole('heading', { name: 'Library', exact: true })).toBeVisible();
    await expect(page.getByRole('link', { name: /^disc-speech/ })).toBeVisible();
    await expect(page.getByRole('link', { name: /^disc1/ })).toBeVisible();
    await page.getByRole('link', { name: /^disc-speech/ }).click();

    // Disc
    await expect(page.getByRole('heading', { name: 'disc-speech' })).toBeVisible();
    await page.locator('.playlist-list li', { hasText: '00000' }).getByRole('link', { name: 'Episodes' }).click();

    // Episodes: chapter 4 moves the player, and a split after chapter 3 makes episodes 1-3 and 4-
    await expect(page.getByRole('heading', { name: 'disc-speech' })).toBeVisible();
    const time = page.locator('.player-time');
    await expect(time).toBeVisible();
    const before = (await time.textContent()) ?? '';
    await page.getByRole('button', { name: /^Chapter 4, starts at/ }).click();
    await expect(time).not.toHaveText(before, { timeout: 30_000 });
    await page.getByRole('checkbox', { name: 'Split after chapter 3' }).check();
    await expect(page.getByRole('textbox', { name: 'Episodes' })).toHaveValue('1-3,4-');
    await expect(page.getByRole('list', { name: 'Episodes made' }).getByRole('listitem')).toHaveCount(2);

    // Choose subtitles opens the helper on a session for this grouping; GroupA's release, then save
    await page.getByRole('button', { name: 'Choose subtitles' }).click();
    await expect(page).toHaveURL(/\/helper\/[0-9a-f]{16}/);
    const sessionId = /\/helper\/([0-9a-f]{16})/.exec(page.url())?.[1] ?? '';
    const session = (await (await request.get(new URL(`/api/sessions/${sessionId}`, appUrl()).href, { headers: headers() })).json()) as { toolsReady: boolean };
    const search = page.getByRole('searchbox', { name: 'Search AniList for the show' });
    await search.fill('lantern');
    await search.press('Enter');
    await page.getByRole('button', { name: /Lantern Harbor/ }).click();
    await page.getByRole('button', { name: /^GroupA/ }).click();
    await expect(page.getByRole('heading', { name: 'Releases in use' })).toBeVisible();
    await page.getByRole('button', { name: 'Next' }).click();
    await expect(page.getByRole('group', { name: 'Episode 1, Arrival' })).toBeVisible();
    await page.getByRole('button', { name: 'Next' }).click();
    test.skip(!session.toolsReady, NO_TOOLS);
    await page.getByRole('alertdialog', { name: "Line up the subtitles against the disc's audio?" }).getByRole('button', { name: 'Line up', exact: true }).click();
    await expect(page.locator('.lineup-status')).toContainText(/Shifted|Could not line up/, { timeout: 120_000 });
    await page.getByRole('button', { name: 'Save for encoding' }).click();
    await expect(page.getByRole('status').filter({ hasText: /^Saved at/ })).toBeVisible();

    // Queue encode from the helper, into a folder of this test's own
    const out = join(outputRoot(), 'first');
    await page.getByRole('button', { name: 'Queue encode' }).click();
    await expect(page.getByRole('heading', { name: 'Queue an encode' })).toBeVisible();
    await page.getByLabel('Output folder').fill(out);
    await page.getByRole('button', { name: 'Queue encode' }).click();
    await expect(page).toHaveURL(/\/queue(\/|$)/);

    // The progress line shows on the Library page while it runs (the encode is quick, so poll for it)
    await page.getByRole('link', { name: 'Library', exact: true }).first().click();
    await expect(page.getByRole('heading', { name: 'Library', exact: true })).toBeVisible();
    let sawProgress = false;
    await expect
      .poll(
        async () => {
          if ((await page.locator('.progress-line').count()) > 0) sawProgress = true;
          const all = await jobs(request);
          return all.length > 0 && all.every((j) => j.state === 'done' || j.state === 'failed');
        },
        { timeout: 360_000, intervals: [100] },
      )
      .toBe(true);
    expect(sawProgress).toBe(true);

    // Queue: both episodes done, and the MKVs on disk
    await page.getByRole('link', { name: 'Queue', exact: true }).first().click();
    await page.getByRole('link', { name: /disc-speech/ }).first().click();
    await expect(page.locator('.episode-row.episode-done')).toHaveCount(2);
    await expect(page.locator('progress[aria-label="Episode 1"]')).toHaveAttribute('value', '100');
    await expect(page.locator('progress[aria-label="Episode 2"]')).toHaveAttribute('value', '100');
    const files = readdirSync(out);
    expect(files.filter((f) => f.endsWith('.mkv')).sort()).toEqual(['episode-01.mkv', 'episode-02.mkv']);
    expect(files.filter((f) => f.endsWith('.partial'))).toEqual([]);
    expect(problems).toEqual([]);
  });

  test('cancel a running job: it stops, and no partial file is left', async ({ page, request }) => {
    test.setTimeout(180_000);
    const key = await discKey(page, 'disc-speech');
    test.skip(!(await toolsReady(request, key)), NO_TOOLS);
    const base = new URL('/api/', appUrl()).href;
    const created = await request.post(`${base}profiles`, {
      headers: headers(),
      data: { name: 'Slow', settings: { crf: 25, preset: 0, filmGrain: 4, extraSvtArgs: [], opusBitrate: null, pgs: false, web: false, namePattern: 'episode-{n}' } },
    });
    expect(created.status()).toBe(201);
    const profile = (await created.json()) as { settings: unknown };
    const out = join(outputRoot(), 'second');
    const made = await request.post(`${base}jobs`, {
      headers: headers(),
      data: { discKey: key, playlistId: '00000', episodeSpec: '1-3,4-', settings: profile.settings, outDir: out, noSubtitles: true },
    });
    expect(made.status()).toBeLessThan(300);
    const id = ((await made.json()) as { id: string }).id;

    await page.goto(at(`/queue/${id}`));
    await expect(page.locator('.episode-row.episode-running')).toBeVisible({ timeout: 60_000 });
    await page.getByRole('button', { name: 'Cancel', exact: true }).click();
    await expect.poll(async () => (await jobs(request)).find((j) => j.id === id)?.state, { timeout: 60_000 }).toBe('cancelled');
    await expect(page.getByRole('button', { name: 'Retry' })).toBeVisible();
    const left = existsSync(out) ? readdirSync(out) : [];
    expect(left.filter((f) => f.endsWith('.partial'))).toEqual([]);
  });

  test('a test encode shows its samples side by side and plays them', async ({ page, request }) => {
    test.setTimeout(240_000);
    const key = await discKey(page, 'disc-speech');
    test.skip(!(await toolsReady(request, key)), NO_TOOLS);
    await page.goto(at(`/queue/new?disc=${key}&playlist=00000&spec=${encodeURIComponent('1-3,4-')}&noSubtitles=1`));
    await expect(page.getByRole('heading', { name: 'Queue an encode' })).toBeVisible();
    await page.getByRole('checkbox', { name: /^Default/ }).check();
    await page.getByRole('button', { name: 'Run test encode' }).click();
    await expect(page).toHaveURL(/\/test\/[^/]+/);
    await expect(page.getByRole('heading', { name: 'Test encode' })).toBeVisible();
    await expect(page.getByRole('group', { name: /^Sample at / }).first()).toBeVisible({ timeout: 200_000 });
    const video = page.locator('video').first();
    await expect(video).toBeAttached();
    await expect.poll(() => video.evaluate((v) => (v as unknown as { readyState: number }).readyState), { timeout: 30_000 }).toBeGreaterThanOrEqual(2);
  });
});
