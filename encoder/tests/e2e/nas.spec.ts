// SPDX-License-Identifier: LGPL-3.0-or-later
import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test, type APIRequestContext } from '@playwright/test';
import { NasClient } from '../../src/nas/client';
import { HEAD_BYTES } from '../../src/nas/mirror';
import { NAS_BASE, nasEnv, SERVER, SPEECH_FOLDER } from './nas-stand-in';

// The encoder and Seikou's NAS end to end, as playwright.encoder.config.ts starts them: Seikou's NAS server on 4198
// (nas-stand-in.ts) and `seikou-encode app` on 4199 with no library folders. The app pairs with the NAS as an owner
// device, opens the NAS's copy of the speech disc, names a chapter and picks the made-up AniList entry Starfall
// Wanderer (990010) for two episodes, and queues them to the NAS, which files them in its Encodes library.

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
const ANILIST_ID = 990010;
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
  const made = await request.post(api('sessions'), { headers: headers(), data: { discKey: key, playlistId: '00000', episodeSpec: '1-3,4-' } });
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

test('pair with the NAS, open a NAS disc, and send its episodes to the NAS', async ({ page, request }) => {
  test.setTimeout(480_000);
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

  // Library: the NAS's discs, marked NAS (the NAS's own first scan may still be running: Rescan until it is listed)
  await page.getByRole('link', { name: 'Library', exact: true }).first().click();
  await expect(page.getByRole('heading', { name: 'Library', exact: true })).toBeVisible();
  const speech = page.getByRole('link', { name: new RegExp(SPEECH_FOLDER) });
  await expect
    .poll(
      async () => {
        if (await speech.isVisible()) return true;
        const rescan = page.getByRole('button', { name: 'Rescan' });
        if (await rescan.isEnabled()) await rescan.click();
        return false;
      },
      { timeout: 60_000, intervals: [1000] },
    )
    .toBe(true);
  const row = page.locator('.disc-list li', { has: speech });
  await expect(row.locator('.mark-nas')).toHaveText('NAS');
  const key = /^\/disc\/([^/?]+)/.exec((await speech.getAttribute('href')) ?? '')?.[1] ?? '';
  expect(key).toMatch(/^f\./);
  await speech.click();

  // Disc, then the Episodes page of its playlist
  await expect(page.getByRole('heading', { name: 'disc-speech' })).toBeVisible({ timeout: 60_000 });
  await page.locator('.playlist-list li', { hasText: '00000' }).getByRole('link', { name: 'Episodes' }).click();
  await expect(page.getByRole('heading', { name: 'disc-speech' })).toBeVisible();

  // Two episodes, chapter 1 named Opening, and Starfall Wanderer episodes 1 and 2
  await page.getByRole('checkbox', { name: 'Split after chapter 3' }).check();
  await expect(page.getByRole('textbox', { name: 'Episodes' })).toHaveValue('1-3,4-');
  await page.getByLabel('Name of chapter 1').selectOption('Opening');
  await page.getByRole('button', { name: 'Choose the AniList entry of episode 1' }).click();
  const search = page.getByRole('searchbox', { name: 'Search AniList for episode 1' });
  await search.fill('starfall');
  await search.press('Enter');
  await page
    .locator('.show-row')
    .filter({ has: page.locator('.show-title', { hasText: /^Starfall Wanderer$/ }) })
    .click();
  await expect(page.getByLabel('AniList episode number of episode 1')).toHaveValue('1');
  await expect(page.getByLabel('AniList episode number of episode 2')).toHaveValue('2');
  await expect(page.locator('.info-save')).toHaveText('Saved', { timeout: 10_000 });

  test.skip(!(await toolsReady(request, key)), NO_TOOLS);

  // Queue with the NAS as the destination
  await page.getByRole('button', { name: 'Queue encode' }).click();
  await expect(page.getByRole('heading', { name: 'Queue an encode' })).toBeVisible();
  await page.getByRole('radio', { name: 'The NAS (Encodes library)' }).check();
  await expect(page.locator('.queue-needs')).toHaveCount(0);
  await page.getByRole('button', { name: 'Queue encode' }).click();
  await expect(page).toHaveURL(/\/queue(\/|$)/);

  // The job fetches, encodes and uploads each episode, then is done (the fetches are too quick here to catch in a
  // poll, so the job's log says what it did)
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
  expect(job?.state).toBe('done');
  expect(job?.episodes.map((e) => [e.state, e.encodeId])).toEqual([
    ['done', `${ANILIST_ID}-1`],
    ['done', `${ANILIST_ID}-2`],
  ]);
  const log = readFileSync(join(appData(), 'jobs', `${job!.id}.log`), 'utf8');
  for (const n of [1, 2]) {
    expect(log).toMatch(new RegExp(`Episode ${n}: fetching .+ from the NAS\\.`));
    expect(log).toContain(`Episode ${n}: uploading to the NAS.`);
    expect(log).toMatch(new RegExp(`Episode ${n}: on the NAS as ${ANILIST_ID}-${n};`));
  }

  // The NAS lists the show with both episodes, filed by their tags
  const client = await NasClient.load(appData());
  expect(client).not.toBeNull();
  const { shows } = await client!.json<{ shows: { anilistIds: number[]; episodeCount: number }[] }>('encodes/shows');
  expect(shows.filter((s) => s.anilistIds.includes(ANILIST_ID)).map((s) => s.episodeCount)).toEqual([2]);
  client!.close();
  expect(filesUnder(nasEnv().ENCODES_DIR!).filter((f) => !f.startsWith('.uploads')).sort()).toEqual([`${ANILIST_ID}/1.mkv`, `${ANILIST_ID}/2.mkv`]);

  // Nothing is left here: no MKV waiting for the NAS, and the mirror holds no whole clip
  expect(filesUnder(join(appData(), 'nas-out'))).toEqual([]);
  await expect.poll(() => clipsBeyondHead(join(appData(), 'fetch', key)), { timeout: 10_000 }).toEqual([]);
  expect(problems).toEqual([]);
});
