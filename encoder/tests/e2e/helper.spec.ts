// SPDX-License-Identifier: LGPL-3.0-or-later
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test, type Page } from '@playwright/test';

// The subtitle helper from the first search to a saved record, against `seikou-encode serve` as
// playwright.encoder.config.ts starts it: the speech disc, episodes 1-3 and 4-5 of playlist 00000, and recorded answers
// for the made-up show Lantern Harbor (AniList 900101), whose best SeaDex release is GroupA's.

/** The helper's address with this run's token, from the server's output. */
function helperUrl(): string {
  const url = process.env.HELPER_URL;
  if (!url) throw new Error('HELPER_URL is not set: run this spec through playwright.encoder.config.ts');
  return url;
}

/** The saved record files under the run's data directory (`subtitles/<disc key>/<playlist>.json`). */
function recordFiles(): string[] {
  const data = process.env.SEIKOU_ENCODE_E2E_DATA;
  if (!data) throw new Error('SEIKOU_ENCODE_E2E_DATA is not set: run this spec through playwright.encoder.config.ts');
  const root = join(data, 'subtitles');
  let keys: string[];
  try {
    keys = readdirSync(root);
  } catch {
    return [];
  }
  return keys.flatMap((key) => readdirSync(join(root, key)).filter((f) => f.endsWith('.json')).map((f) => join(root, key, f)));
}

/** The episode's button in step 3's episode list. */
function lineUpEpisode(page: Page, n: number) {
  return page.getByRole('navigation', { name: 'Episodes' }).getByRole('button', { name: new RegExp(`^Episode ${n}\\b`) });
}

/** Episode `n`'s release-file select in step 2. */
function fileOf(page: Page, n: number) {
  return page.getByRole('combobox', { name: new RegExp(`^Release file for Episode ${n}\\b`) });
}

/** The nudge value step 3 shows. */
function nudgeValue(page: Page) {
  return page.getByRole('group', { name: 'Nudge the subtitles' }).locator('output');
}

test('pick a show and a release, match, line up, nudge, name a track, save and restore', async ({ page, request }) => {
  const url = helperUrl();
  const token = new URL(url).searchParams.get('t') ?? '';
  const session = (await (await request.get(new URL('/api/session', url).href, { headers: { Authorization: `Bearer ${token}` } })).json()) as { toolsReady: boolean };

  const problems: string[] = [];
  page.on('console', (m) => {
    if (m.type() === 'error' || m.type() === 'warning') problems.push(`console ${m.type()}: ${m.text()}`);
  });
  page.on('pageerror', (e) => problems.push(`page error: ${e.message}`));
  page.on('response', (r) => {
    if (r.status() >= 400) problems.push(`${r.status()} ${new URL(r.url()).pathname}`);
  });
  const seadexAsked: string[] = [];
  page.on('request', (r) => {
    if (new URL(r.url()).pathname === '/api/fansubs/seadex') seadexAsked.push(r.url());
  });

  // Step 1: nothing is looked up before the show is picked by hand
  await page.goto(url);
  await expect(page.getByRole('heading', { name: 'disc-speech' })).toBeVisible();
  const search = page.getByRole('searchbox', { name: 'Search AniList for the show' });
  await search.fill('lantern');
  await search.press('Enter');
  const show = page.getByRole('button', { name: /Lantern Harbor/ });
  await expect(show).toBeVisible();
  // the cover comes through the backend, since the isolated page may not load AniList's image host
  const cover = show.locator('img.cover');
  await expect(cover).toHaveAttribute('src', /\/api\/titles\/900101\/cover\?t=/);
  const loadedWidth = () =>
    cover.evaluate((img) => {
      const image = img as unknown as { complete: boolean; naturalWidth: number };
      return image.complete ? image.naturalWidth : 0;
    });
  await expect.poll(loadedWidth).toBe(4);
  expect(seadexAsked).toEqual([]);

  const seadexAnswer = page.waitForResponse((r) => new URL(r.url()).pathname === '/api/fansubs/seadex');
  await show.click();
  expect(new URL((await seadexAnswer).url()).searchParams.get('anilist')).toBe('900101');

  await expect(page.getByRole('button', { name: /^GroupC/ })).toBeDisabled();
  await expect(page.getByRole('button', { name: /^GroupC/ })).toContainText('Private tracker');
  await page.getByRole('button', { name: /^GroupA/ }).click();
  await expect(page.getByRole('heading', { name: 'Releases in use' })).toBeVisible();
  // a second release joins the pool
  await page.getByRole('button', { name: /^GroupB/ }).click();
  await expect(page.getByRole('button', { name: /^Remove .*GroupB/ })).toBeVisible();
  await expect(page.getByRole('button', { name: /^Remove .*GroupA/ })).toBeVisible();
  await page.getByRole('button', { name: 'Next' }).click();

  // Step 2: both episodes, with AniList's titles; episode 1 takes GroupB's file, episode 2 stays on GroupA's
  await expect(page.getByRole('group', { name: 'Episode 1, Arrival' })).toBeVisible();
  await expect(page.getByRole('group', { name: 'Episode 2, The Lighthouse' })).toBeVisible();
  await expect(fileOf(page, 1).locator('optgroup')).toHaveCount(2);
  await expect(fileOf(page, 1).locator('option:checked')).toContainText('[GroupA]');
  await fileOf(page, 1).selectOption({ label: '[GroupB] Lantern Harbor - 01 (BD 1080p).mkv' });
  await expect(fileOf(page, 1).locator('option:checked')).toContainText('[GroupB]');
  await expect(fileOf(page, 2).locator('option:checked')).toContainText('[GroupA]');
  // step 3 lines episode 1 up, and previews it, from GroupB's release
  const alignAsked = page.waitForRequest((r) => new URL(r.url()).pathname === '/api/episodes/1/align');
  const subtitleAsked = page.waitForRequest((r) => new URL(r.url()).pathname === '/api/episodes/1/subtitle', { timeout: 120_000 });
  await page.getByRole('button', { name: 'Next' }).click();
  expect((await alignAsked).postDataJSON()).toMatchObject({ release: 'tosho-7002' });

  // Step 3, episode 1: lined up, playing, nudged a frame later
  await expect(page.getByRole('heading', { name: 'Episode 1', exact: true })).toBeVisible();
  const status = page.locator('.lineup-status');
  if (session.toolsReady) {
    await expect(status).toContainText('Shifted +1.20 s', { timeout: 120_000 });
  } else {
    test.info().annotations.push({ type: 'skip', description: 'no VapourSynth with BestSource here: the line-up results are not checked' });
    await expect(status).toContainText('Lining up needs VapourSynth');
  }

  const later = page.getByRole('button', { name: 'Later by 42 ms' });
  await expect(later).toBeEnabled({ timeout: 60_000 });
  expect(new URL((await subtitleAsked).url()).searchParams.get('release')).toBe('tosho-7002');
  const playButton = page.locator('.player-controls .play');
  if ((await playButton.textContent()) === 'Play') await playButton.click();
  await expect(playButton).toHaveText('Pause');
  const time = page.locator('.player-time');
  const startedAt = await time.textContent();
  await expect(time).not.toHaveText(startedAt ?? '', { timeout: 15_000 });

  await expect(nudgeValue(page)).toHaveText('0.000 s');
  await page.locator('body').press(']');
  await expect(nudgeValue(page)).toHaveText('+0.042 s');

  // Episode 2 has too little dialogue to line up
  await lineUpEpisode(page, 2).click();
  await expect(page.getByRole('heading', { name: 'Episode 2', exact: true })).toBeVisible();
  if (session.toolsReady) await expect(status).toContainText('Could not line up', { timeout: 120_000 });

  // Previous episode returns to episode 1 with its nudge, and is disabled there
  await page.getByRole('button', { name: 'Previous episode' }).click();
  await expect(page.getByRole('heading', { name: 'Episode 1', exact: true })).toBeVisible();
  await expect(nudgeValue(page)).toHaveText('+0.042 s');
  await expect(page.getByRole('button', { name: 'Previous episode' })).toBeDisabled();
  await lineUpEpisode(page, 2).click();
  await expect(page.getByRole('heading', { name: 'Episode 2', exact: true })).toBeVisible();

  // The browser's Back moves between steps: 3 to 2 to 1, then Forward to 2
  await page.goBack();
  await expect(page.getByRole('group', { name: 'Episode 1, Arrival' })).toBeVisible();
  await page.goBack();
  await expect(page.getByRole('heading', { name: 'Releases in use' })).toBeVisible();
  await page.goForward();
  await expect(page.getByRole('group', { name: 'Episode 1, Arrival' })).toBeVisible();
  await expect(fileOf(page, 1).locator('option:checked')).toContainText('[GroupB]');
  await page.getByRole('navigation', { name: 'Steps' }).getByRole('button', { name: /Line up/ }).click();
  await lineUpEpisode(page, 2).click();

  // Details: rename episode 1's first subtitle track, then save
  await page.getByRole('button', { name: 'Details' }).click();
  const details = page.getByRole('dialog', { name: 'Details' });
  await details.getByRole('button', { name: 'Episode 1', exact: true }).click();
  const trackName = details.getByRole('textbox', { name: 'Name of subtitle track 1' });
  await trackName.fill('Harbor dialogue');
  await details.getByRole('button', { name: 'Close details' }).click();
  await page.getByRole('button', { name: 'Save for encoding' }).click();
  await expect(page.getByRole('status').filter({ hasText: /^Saved at/ })).toBeVisible();

  // A reload restores the name and the nudge
  await page.reload();
  await expect(page.getByText(/^Restored the choices saved/)).toBeVisible();
  await page.getByRole('button', { name: 'Details' }).click();
  await details.getByRole('button', { name: 'Episode 1', exact: true }).click();
  await expect(details.getByRole('textbox', { name: 'Name of subtitle track 1' })).toHaveValue('Harbor dialogue');
  await details.getByRole('button', { name: 'Close details' }).click();
  await page.getByRole('navigation', { name: 'Steps' }).getByRole('button', { name: /Line up/ }).click();
  await lineUpEpisode(page, 1).click();
  await expect(nudgeValue(page)).toHaveText('+0.042 s');
  await page.getByRole('navigation', { name: 'Steps' }).getByRole('button', { name: /Episodes/ }).click();
  await expect(fileOf(page, 1).locator('option:checked')).toContainText('[GroupB]');
  await expect(fileOf(page, 2).locator('option:checked')).toContainText('[GroupA]');

  // The record on disk
  const files = recordFiles();
  expect(files).toHaveLength(1);
  expect(files[0]).toMatch(/[\\/]00000\.json$/);
  const record = JSON.parse(readFileSync(files[0]!, 'utf8')) as {
    releases: { id: string; group: string }[];
    episodes: { index: number; tracks: { name: string; nudgeMs: number; release: string }[] }[];
  };
  expect(record.releases.map((r) => r.id).sort()).toEqual(['tosho-7001', 'tosho-7002']);
  expect(record.releases.find((r) => r.id === 'tosho-7001')?.group).toBe('GroupA');
  expect(record.releases.find((r) => r.id === 'tosho-7002')?.group).toBe('GroupB');
  const second = record.episodes.find((e) => e.index === 2);
  expect(second?.tracks.length).toBeGreaterThan(0);
  for (const track of record.episodes.find((e) => e.index === 1)?.tracks ?? []) expect(track.release).toBe('tosho-7002');
  for (const track of second?.tracks ?? []) expect(track.release).toBe('tosho-7001');
  const first = record.episodes.find((e) => e.index === 1);
  expect(first?.tracks.length).toBeGreaterThan(0);
  expect(first?.tracks[0]?.name).toBe('Harbor dialogue');
  for (const track of first?.tracks ?? []) expect(track.nudgeMs).toBe(42);

  expect(problems).toEqual([]);
});
