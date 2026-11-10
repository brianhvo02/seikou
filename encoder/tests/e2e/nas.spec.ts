// SPDX-License-Identifier: LGPL-3.0-or-later
import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test, type APIRequestContext, type Locator, type Page } from '@playwright/test';
import { NasClient } from '../../src/nas/client';
import { HEAD_BYTES } from '../../src/nas/mirror';
import { NAS_BASE, nasEnv, SERVER } from './nas-stand-in';

// The encoder and Seikou's NAS end to end, as playwright.encoder.config.ts starts them: Seikou's NAS server on 4198
// (nas-stand-in.ts) and `seikou-encode app` on 4199 with no library folders. The app pairs with the NAS as an owner
// device and opens the Library by show: the made-up AniList series Lantern Road (990001) holds two discs, copies of
// the encoder's disc1 and disc-vm, an episode of 4 s on each. The second is checked under another title (the made-up TMDB series
// Paper Boats, 990111), which the NAS then files it under; the first is checked as the series' episode 1, and the
// season's Queue sends it to the NAS, which files it in its Encodes library and shows the season Encoded.

/** The app's address with this run's token, from the server's output. */
function appUrl(): string {
  const url = process.env.NAS_APP_URL;
  if (!url) throw new Error('NAS_APP_URL is not set: run this spec through playwright.encoder.config.ts');
  return url;
}

/** The app's data directory. */
function appData(): string {
  const dir = process.env.SEIKOU_ENCODE_E2E_NAS_APP_DATA;
  if (!dir) throw new Error('SEIKOU_ENCODE_E2E_NAS_APP_DATA is not set: run this spec through playwright.encoder.config.ts');
  return dir;
}

const token = (): string => new URL(appUrl()).searchParams.get('t') ?? '';
const at = (path: string): string => new URL(`${path}${path.includes('?') ? '&' : '?'}t=${token()}`, appUrl()).href;
const headers = (): Record<string, string> => ({ Authorization: `Bearer ${token()}` });
const api = (path: string): string => new URL(`/api/${path}`, appUrl()).href;

const PERSON = 'Encoder Owner';
const ANILIST_ID = 990001;
const NO_TOOLS = 'needs VapourSynth with BestSource, SvtAv1EncApp and opusenc';

/** A fresh owner pairing code, minted as the NAS's owner does: `node server.mjs owner-code` against its data. */
function ownerCode(): string {
  const out = execFileSync(process.execPath, [SERVER, 'owner-code', '--person', PERSON], { env: { ...process.env, ...nasEnv() }, encoding: 'utf8' });
  const code = /Owner pairing code: ([0-9A-Z-]+)/.exec(out)?.[1];
  if (code === undefined) throw new Error(`owner-code printed no code: ${out}`);
  return code;
}

interface EpisodeView {
  state: string;
  encodeId?: string;
}
interface JobView {
  id: string;
  state: string;
  episodes: EpisodeView[];
}

async function jobs(request: APIRequestContext): Promise<JobView[]> {
  return ((await (await request.get(api('jobs'), { headers: headers() })).json()) as { jobs: JobView[] }).jobs;
}

/** Whether the app found the encoder's tools, as a helper session on the disc reports it. */
async function toolsReady(request: APIRequestContext, key: string): Promise<boolean> {
  const made = await request.post(api('sessions'), { headers: headers(), data: { discKey: key, playlistId: '00001', episodeSpec: '1-' } });
  expect(made.status()).toBeLessThan(300);
  const id = ((await made.json()) as { id: string }).id;
  return ((await (await request.get(api(`sessions/${id}`), { headers: headers() })).json()) as { toolsReady: boolean }).toolsReady;
}

/** Every file under `dir` (none when it is missing), as paths relative to it. */
function filesUnder(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((e) => e.isFile())
    .map((e) => join(e.parentPath, e.name).slice(dir.length + 1));
}

/** The mirror's clips that hold more than their head: whole clips, or more of one than a head. */
function clipsBeyondHead(mirror: string): string[] {
  const record = JSON.parse(readFileSync(join(mirror, 'fetch.json'), 'utf8')) as { files: Record<string, number>; ranges: Record<string, [number, number][]> };
  return Object.entries(record.ranges)
    .filter(([path, ranges]) => {
      const fetched = ranges.reduce((n, [a, b]) => n + (b - a), 0);
      const size = record.files[path] ?? 0;
      return fetched > Math.min(size, HEAD_BYTES) || (size > HEAD_BYTES && fetched >= size);
    })
    .map(([path]) => path);
}


test.describe.configure({ mode: 'serial' });

/** The Episodes page of the disc a season's Check episodes link leads to (the link may lead through the disc's page). */
async function openEpisodes(page: Page, playlist: string): Promise<void> {
  const episodes = page.getByRole('textbox', { name: 'Episodes' });
  const playlists = page.locator('.playlist-list li', { hasText: playlist });
  await expect(episodes.or(playlists)).toBeVisible({ timeout: 60_000 });
  if (await playlists.isVisible()) await playlists.getByRole('link', { name: 'Episodes' }).click();
  await expect(episodes).toBeVisible();
}

/** The disc block of a season page with this heading. */
const discBlock = (page: Page, label: string): Locator => page.locator('section.season-disc', { has: page.getByRole('heading', { name: label, exact: true }) });

test('pair with the NAS, find a show in the Library by show, and file a disc under another title by checking it', async ({ page }) => {
  test.setTimeout(240_000);
  const problems: string[] = [];
  page.on('pageerror', (e) => problems.push(`page error: ${e.message}`));

  // Settings: pair with an owner code and the NAS's address
  await page.goto(at('/settings'));
  await expect(page.getByRole('heading', { name: 'Your NAS' })).toBeVisible();
  await page.getByLabel('Pairing code').fill(ownerCode());
  await page.getByLabel('NAS address').fill(NAS_BASE);
  await page.getByRole('button', { name: 'Pair', exact: true }).click();
  await expect(page.getByText(`Paired with 127.0.0.1 as ${PERSON}`)).toBeVisible({ timeout: 30_000 });
  await expect(page.getByText('The NAS keeps encodes')).toBeVisible();

  // Library: paired, it opens By show; the NAS's first scan and matching may still be running: Rescan until Lantern Road is listed
  await page.getByRole('link', { name: 'Library', exact: true }).first().click();
  await expect(page.getByRole('heading', { name: 'Library', exact: true })).toBeVisible();
  await expect(page.getByRole('link', { name: 'By show' })).toHaveAttribute('aria-current', 'page');
  const lantern = page.getByRole('list', { name: 'Shows' }).getByRole('link', { name: /Lantern Road/ });
  await expect
    .poll(
      async () => {
        if (await lantern.isVisible()) return true;
        const rescan = page.getByRole('button', { name: 'Rescan' });
        if (await rescan.isEnabled()) await rescan.click();
        return false;
      },
      { timeout: 90_000, intervals: [1000] },
    )
    .toBe(true);
  await expect(lantern).toContainText('1 season, 2 discs');
  await expect(lantern).toContainText('None of 2 encoded');
  // the speech disc, which no title matches, is listed as the NAS's unsorted
  await expect(page.getByRole('link', { name: /disc-speech.*Encoder source/ })).toBeVisible();

  // Show, then its season: two discs, nothing checked, so the season can't be queued yet
  await lantern.click();
  await expect(page.getByRole('heading', { name: 'Lantern Road', level: 1 })).toBeVisible();
  await page.locator('.season-list a').first().click();
  const second = discBlock(page, 'Disc 2');
  await expect(second).toBeVisible({ timeout: 30_000 });
  await expect(page.getByRole('button', { name: /^Queue/ })).toBeDisabled();

  // Disc 2 (the copy of disc-vm): its episode is checked under Paper Boats, a TMDB series, in place of Lantern Road
  await second.getByRole('link', { name: 'Check episodes' }).click();
  await openEpisodes(page, '00001');
  // prefilled from the NAS's match: AniList 990001 (the app's own AniList fixture doesn't know it, so it is named by id), episode 2
  await expect(page.getByLabel('AniList episode number of episode 1')).toHaveValue('2');
  await expect(page.locator('.episode-anilist-show').first()).toContainText(/Lantern Road|AniList 990001/);
  await expect(page.getByText('Suggested').first()).toBeVisible();
  await page.getByRole('button', { name: 'Change the AniList entry of episode 1' }).click();
  const search = page.getByRole('searchbox', { name: 'Search for episode 1' });
  await search.fill('paper boats');
  await search.press('Enter');
  await page
    .locator('.show-row')
    .filter({ has: page.locator('.show-title', { hasText: /^Paper Boats$/ }) })
    .click();
  await page.getByLabel('Season of Paper Boats').fill('1');
  await page.getByRole('button', { name: 'Use this season' }).click();
  await expect(page.locator('.episode-anilist-show').first()).toContainText('Paper Boats, season 1');
  await page.getByRole('button', { name: 'Mark checked' }).click();
  await expect(page.locator('#check-result')).toHaveText('Checked. The NAS now files this disc under Paper Boats.', { timeout: 30_000 });

  // The NAS now lists Paper Boats with that disc
  const client = await NasClient.load(appData());
  expect(client).not.toBeNull();
  const paper = await client!.json<{ title: { names: { english: string | null } }; seasons: { discs: unknown[] }[] }>(`titles/${encodeURIComponent('tmdb-tv:990111')}`);
  expect(paper.title.names.english).toBe('Paper Boats');
  expect(paper.seasons.flatMap((s) => s.discs)).toHaveLength(1);
  client!.close();

  // Back at Lantern Road's season, only its first disc is left
  await page.getByRole('link', { name: 'Back to the season' }).first().click();
  await expect(page.locator('main.season-page')).toBeVisible();
  await expect(page.locator('section.season-disc')).toHaveCount(1, { timeout: 30_000 });
  await expect(page.locator('section.season-disc').first()).toContainText('Disc 1');
  expect(problems).toEqual([]);
});

test('check the first disc as the series episode 1, queue the season to the NAS, and see it Encoded', async ({ page, request }) => {
  test.setTimeout(480_000);
  const problems: string[] = [];
  page.on('pageerror', (e) => problems.push(`page error: ${e.message}`));

  await page.goto(at('/'));
  await page.getByRole('link', { name: 'Library', exact: true }).first().click();
  await page.getByRole('list', { name: 'Shows' }).getByRole('link', { name: /Lantern Road/ }).click();
  await page.locator('.season-list a').first().click();
  const first = discBlock(page, 'Disc 1');
  await expect(first).toBeVisible({ timeout: 30_000 });
  // With the second disc gone the NAS no longer guesses the series' episodes: Check episodes has nothing to prefill
  await expect(first).toContainText('no episode list on the NAS');
  await expect(page.getByRole('button', { name: /^Queue/ })).toBeDisabled();

  // Disc 1 is checked as Lantern Road (AniList 990001) episode 1, picked through the NAS's lookup: the NAS's match stands
  await first.getByRole('link', { name: 'Check episodes' }).click();
  await openEpisodes(page, '00001');
  const key = /\/disc\/([^/?]+)/.exec(new URL(page.url()).pathname)?.[1] ?? '';
  expect(key).toMatch(/^f\./);
  await expect(page.getByRole('button', { name: 'Mark checked' })).toBeDisabled();
  await page.getByRole('button', { name: 'Choose the AniList entry of episode 1' }).click();
  const search = page.getByRole('searchbox', { name: 'Search for episode 1' });
  await search.fill('lantern road');
  await search.press('Enter');
  await page
    .locator('.show-row')
    .filter({ has: page.locator('.show-title', { hasText: /^Lantern Road$/ }) })
    .click();
  await expect(page.getByLabel('AniList episode number of episode 1')).toHaveValue('1');
  await page.getByRole('button', { name: 'Mark checked' }).click();
  await expect(page.locator('#check-result')).toHaveText('Checked.', { timeout: 30_000 });
  await page.getByRole('link', { name: 'Back to the season' }).first().click();
  await expect(page.locator('main.season-page')).toBeVisible();
  await expect(discBlock(page, 'Disc 1').locator('.disc-state-checked')).toHaveText('Checked', { timeout: 30_000 });
  await expect(discBlock(page, 'Disc 1').locator('.season-ep-state')).toHaveText(['To encode']);

  test.skip(!(await toolsReady(request, key)), NO_TOOLS);

  // Queue: every disc with episodes to encode is checked
  const queue = page.getByRole('button', { name: 'Queue 1 episode to the NAS' });
  await expect(queue).toBeEnabled();
  await queue.click();
  await expect(page.getByRole('heading', { name: 'Queue an encode' })).toBeVisible();
  await page.getByRole('button', { name: 'Queue encode', exact: true }).click();
  await expect(page).toHaveURL((u) => u.pathname === '/queue');

  // The job fetches, encodes and uploads the episode, then is done (the fetch is too quick here to catch in a poll, so
  // the job's log says what it did)
  let job: JobView | undefined;
  await expect
    .poll(
      async () => {
        job = (await jobs(request))[0];
        return job?.state;
      },
      { timeout: 420_000, intervals: [250] },
    )
    .toMatch(/^(done|failed)$/);
  const log = readFileSync(join(appData(), 'jobs', `${job!.id}.log`), 'utf8');
  expect(job?.state, log).toBe('done');
  expect(job?.episodes.map((e) => [e.state, e.encodeId])).toEqual([['done', `${ANILIST_ID}-1`]]);
  expect(log).toMatch(/Episode 1: fetching .+ from the NAS\./);
  expect(log).toContain('Episode 1: uploading to the NAS.');
  expect(log).toMatch(new RegExp(`Episode 1: on the NAS as ${ANILIST_ID}-1;`));

  // The NAS lists the show with the episode, filed by its tags
  const client = await NasClient.load(appData());
  expect(client).not.toBeNull();
  const { shows } = await client!.json<{ shows: { anilistIds: number[]; episodeCount: number }[] }>('encodes/shows');
  expect(shows.filter((s) => s.anilistIds.includes(ANILIST_ID)).map((s) => s.episodeCount)).toEqual([1]);
  client!.close();
  expect(filesUnder(nasEnv().ENCODES_DIR!).filter((f) => !f.startsWith('.uploads')).sort()).toEqual([`${ANILIST_ID}/1.mkv`]);

  // The season shows its episode Encoded, and nothing is left to queue
  await page.getByRole('link', { name: 'Library', exact: true }).first().click();
  const lantern = page.getByRole('list', { name: 'Shows' }).getByRole('link', { name: /Lantern Road/ });
  await expect(lantern).toContainText('All 1 encoded', { timeout: 60_000 });
  await lantern.click();
  await page.locator('.season-list a').first().click();
  await expect(discBlock(page, 'Disc 1').locator('.season-ep-state')).toHaveText(['Encoded'], { timeout: 30_000 });
  await expect(page.getByRole('button', { name: /^Queue/ })).toBeDisabled();

  // Nothing is left here: no MKV waiting for the NAS, and the mirror holds no whole clip
  expect(filesUnder(join(appData(), 'nas-out'))).toEqual([]);
  await expect.poll(() => clipsBeyondHead(join(appData(), 'fetch', key)), { timeout: 10_000 }).toEqual([]);
  expect(problems).toEqual([]);
});
