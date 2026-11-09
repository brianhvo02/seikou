// SPDX-License-Identifier: LGPL-3.0-or-later
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test, type Page } from '@playwright/test';
import { normalizeCode } from '@seikou/nas/pairing-code';
import { NAS_E2E_DIR, NAS_ENV, NAS_PORT, SERVER } from './nas-server';
import { telemetry } from './telemetry';

// The encodes library against the NAS stand-in (tests/e2e/nas-server.ts), which serves copies of fixtures/encodes: the
// made-up show Lantern Road (AniList 990001, from tests/e2e/fixtures/nas-metadata.json) with episodes 1 and 2, each
// 60 s with the chapters Avant 0 s, Opening 10 s, Part A 20 s, Ending 40 s, Preview 50 s. Each project pairs as its own
// owner person (`Encodes <project>`), so its places are its own. Run it by its full path, as nas.spec.ts is.

const REPO_ROOT = fileURLToPath(new URL('../../', import.meta.url));
const NAS_API = `http://localhost:${NAS_PORT}/api/`;
const SHOW_ID = '990001';
const SHOW_NAME = 'Lantern Road';
const EPISODE_ONE = '990001-1';
const EPISODE_TWO = '990001-2';
/** The episode the upload test adds, and removes again. */
const EPISODE_THREE = '990001-3';
const S = 1_000_000;

const sleep = (ms: number): void => void Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

/** Runs `fn` while no other worker holds `name` (nas.spec.ts takes `owner-code` the same way). */
function exclusively<T>(name: string, fn: () => T): T {
  const lock = join(NAS_E2E_DIR, `${name}.lock`);
  for (let tries = 0; ; tries++) {
    try {
      mkdirSync(lock);
      break;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST' || tries > 600) throw err;
      sleep(50);
    }
  }
  try {
    return fn();
  } finally {
    rmSync(lock, { recursive: true, force: true });
  }
}

/** As `exclusively`, holding the lock while `fn` awaits. */
async function exclusivelyAsync<T>(name: string, fn: () => Promise<T>): Promise<T> {
  const lock = join(NAS_E2E_DIR, `${name}.lock`);
  for (let tries = 0; ; tries++) {
    try {
      mkdirSync(lock);
      break;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST' || tries > 2400) throw err;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }
  try {
    return await fn();
  } finally {
    rmSync(lock, { recursive: true, force: true });
  }
}

const person = (): string => `Encodes ${test.info().project.name}`;

/** A fresh owner code for this project's person, minted as the NAS owner does (`server.mjs owner-code`), under a new NAS key. */
function ownerCode(): string {
  const out = exclusively('owner-code', () => {
    rmSync(join(NAS_ENV.DATA_DIR!, 'rendezvous-key.json'), { force: true });
    return execFileSync(process.execPath, [SERVER, 'owner-code', '--person', person()], { env: { ...process.env, ...NAS_ENV }, encoding: 'utf8', cwd: REPO_ROOT });
  });
  expect(out).toContain('Rendezvous: registered');
  return /Owner pairing code: ([0-9A-Z-]+)/.exec(out)![1]!;
}

const post = async (path: string, body: unknown): Promise<unknown> => {
  const res = await fetch(`${NAS_API}${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  expect(res.status, `POST ${path}`).toBe(200);
  return res.json();
};

const sessions = new Map<string, Promise<string>>();
/** A session token of an owner device (`E2E API`) this worker pairs for the project's person, as the app does. */
function apiToken(): Promise<string> {
  const who = person();
  let session = sessions.get(who);
  if (!session) {
    session = (async () => {
      const code = normalizeCode(ownerCode())!;
      const key = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign', 'verify']);
      const { kty, crv, x, y } = await crypto.subtle.exportKey('jwk', key.publicKey);
      const { deviceId } = (await post('pair/redeem', { code, deviceName: 'E2E API', publicKeyJwk: { kty, crv, x, y } })) as { deviceId: string };
      const { challenge } = (await post('session/challenge', { deviceId })) as { challenge: string };
      const signature = Buffer.from(await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, key.privateKey, new TextEncoder().encode(challenge))).toString('base64url');
      return ((await post('session', { deviceId, challenge, signature })) as { token: string }).token;
    })();
    sessions.set(who, session);
  }
  return session;
}

async function ownerApi(path: string, init: RequestInit = {}): Promise<Response> {
  const headers = new Headers(init.headers);
  headers.set('Authorization', `Bearer ${await apiToken()}`);
  return fetch(`${NAS_API}${path}`, { ...init, headers });
}

/**
 * Waits for the stand-in's encodes index and the show's AniList entry: the index scans at start, and the show is named
 * "AniList 990001" until the entry the recorded metadata holds has loaded in the background (the routes never wait on
 * AniList), so the list is read again until it carries the made-up name.
 */
async function showNamed(): Promise<void> {
  await expect
    .poll(
      async () => {
        const res = await ownerApi('encodes/shows');
        if (!res.ok) return `HTTP ${res.status}`;
        return ((await res.json()) as { shows: { id: string; name: string }[] }).shows.find((s) => s.id === SHOW_ID)?.name ?? 'no show';
      },
      { timeout: 30_000, message: "the show's AniList name" },
    )
    .toBe(SHOW_NAME);
}

/** Chrome asks before a page reaches the local network; the tests answer for the user where the browser supports it. */
async function allowLocalNetwork(page: Page, browserName: string): Promise<void> {
  if (browserName === 'chromium') await page.context().grantPermissions(['local-network-access']);
}

/** Pairs this page as the project's person (`query`: more of the app's flags, read as it loads). */
async function pair(page: Page, browserName: string, query = ''): Promise<void> {
  await allowLocalNetwork(page, browserName);
  const code = ownerCode();
  await page.goto(`/?pair=${code}&telemetry=1${query}`);
  await expect(page.getByTestId('pair-code')).toHaveValue(code);
  await page.getByTestId('pair-button').click();
  await expect(page.getByTestId('nas-paired')).toBeVisible({ timeout: 25_000 });
}

/** From the paired landing screen to the Encodes tab, then the fixture show's screen. */
async function openShow(page: Page): Promise<void> {
  await page.getByTestId('nas-open').click();
  await page.locator('[data-testid="library-tab"][data-tab="encodes"]').click();
  await expect(page.getByTestId('encodes-library')).toBeVisible({ timeout: 15_000 });
  const card = page.locator(`[data-testid="encode-show-card"][data-show-id="${SHOW_ID}"]`);
  await expect(card).toContainText(SHOW_NAME, { timeout: 15_000 });
  await card.click();
  await expect(page.locator('[data-testid="encode-show"]').last()).toBeVisible();
}

const episodeRow = (page: Page, id: string) => page.locator(`[data-testid="episode-row"][data-encode-id="${id}"]`);

/** Opens an episode's pre-flight from the show screen. */
async function openEpisode(page: Page, id: string): Promise<void> {
  await episodeRow(page, id).click();
  await expect(page.getByTestId('encode-preflight')).toBeVisible();
}

const player = (page: Page) => page.getByTestId('player');

/** The playing time the control bar shows, in seconds. */
async function shownTimeS(page: Page): Promise<number> {
  const text = (await page.getByTestId('time').textContent()) ?? '';
  const m = /^(\d+):(\d\d)/.exec(text.trim());
  return m ? Number(m[1]) * 60 + Number(m[2]) : NaN;
}

/** Shows the control bar (it hides while the pointer rests) and picks a chapter from its Chapters menu. */
async function jumpToChapter(page: Page, name: string): Promise<void> {
  await page.mouse.move(200, 200);
  await page.mouse.move(400, 500);
  await page.getByTestId('chapter-menu').click();
  await page.getByRole('menuitemradio', { name: new RegExp(`^${name} · `) }).click();
}

/** Skips the test where this browser's WebCodecs can't decode AV1, as the app probes it. */
async function skipWithoutAv1(page: Page): Promise<void> {
  await page.goto('/');
  const av1 = await page.evaluate(async () => {
    if (typeof VideoDecoder === 'undefined') return false;
    try {
      return (await VideoDecoder.isConfigSupported({ codec: 'av01.0.08M.08', codedWidth: 1920, codedHeight: 1080 })).supported === true;
    } catch {
      return false;
    }
  });
  test.skip(!av1, "this browser's WebCodecs has no AV1 decoder, which encoded episodes need");
}

/** Each test starts with none of the person's places on the fixture episodes: a place would bring up Resume in place of Play. */
test.beforeEach(async () => {
  await showNamed();
  for (const key of ['e.990001.1', 'e.990001.2', 'e.990001.3']) await ownerApi(`me/playback/${key}`, { method: 'DELETE' });
});

test('lists the show, plays episode 1 with its chapters, skips the opening and goes on to episode 2', async ({ page, browserName }) => {
  test.setTimeout(120_000);
  await skipWithoutAv1(page);
  await pair(page, browserName);
  // the upload test adds a third episode for a while: the count is read while it doesn't
  await exclusivelyAsync('encodes-library', async () => {
    await openShow(page);
    await expect(page.getByTestId('episode-row')).toHaveCount(2);
  });
  await expect(episodeRow(page, EPISODE_ONE)).toContainText('The Lantern Road');
  await expect(episodeRow(page, EPISODE_TWO)).toContainText('A Quiet Harbor');

  await openEpisode(page, EPISODE_ONE);
  await page.getByTestId('encode-preflight-play').click();
  await expect(player(page)).toHaveAttribute('data-state', 'playing', { timeout: 20_000 });
  expect(new URL(page.url()).pathname).toBe(`/nas/encodes/play/${EPISODE_ONE}`);
  // the clock advances on the audio (Opus) with frames presented
  await expect.poll(async () => (await telemetry(page))?.clockMode, { timeout: 10_000 }).toBe('audio');
  const first = (await telemetry(page))!.clockUs;
  await expect.poll(async () => (await telemetry(page))!.clockUs, { timeout: 10_000 }).toBeGreaterThan(first + 1 * S);
  expect((await telemetry(page))!.framesPresented ?? 0).toBeGreaterThan(0);

  // the chapter list carries the MKV's names
  await page.mouse.move(300, 300);
  await page.getByTestId('chapter-menu').click();
  await expect(page.getByRole('menuitemradio', { name: /^Opening · 0:10$/ })).toBeVisible();
  await page.keyboard.press('Escape');

  // Skip opening, in the Opening, jumps to Part A (20 s)
  await jumpToChapter(page, 'Opening');
  const skip = page.getByTestId('skip-chapter');
  await expect(skip).toHaveText('Skip opening', { timeout: 10_000 });
  await skip.click();
  await expect.poll(() => shownTimeS(page), { timeout: 10_000 }).toBeGreaterThanOrEqual(20);
  expect(await shownTimeS(page)).toBeLessThan(40);

  // Next episode, at the Preview after the Ending, opens episode 2
  await jumpToChapter(page, 'Preview');
  const next = page.getByTestId('next-episode');
  await expect(next).toBeVisible({ timeout: 10_000 });
  await next.click();
  await expect.poll(() => new URL(page.url()).pathname, { timeout: 20_000 }).toBe(`/nas/encodes/play/${EPISODE_TWO}`);
  await expect(player(page)).toHaveAttribute('data-state', 'playing', { timeout: 20_000 });
  await expect.poll(() => shownTimeS(page), { timeout: 10_000 }).toBeLessThan(15);
});

test('reopening an episode left part-way offers to resume it', async ({ page, browserName }) => {
  test.setTimeout(90_000);
  await skipWithoutAv1(page);
  await pair(page, browserName);
  await openShow(page);
  await openEpisode(page, EPISODE_ONE);
  await page.getByTestId('encode-preflight-play').click();
  await expect(player(page)).toHaveAttribute('data-state', 'playing', { timeout: 20_000 });
  await jumpToChapter(page, 'Part A');
  await expect.poll(() => shownTimeS(page), { timeout: 10_000 }).toBeGreaterThanOrEqual(20);
  // Close saves the place and goes back to the encodes
  await page.mouse.move(300, 300);
  await page.getByTestId('close-episode').click();
  await expect(page.getByTestId('encodes-library').or(page.locator('[data-testid="encode-show"]').last())).toBeVisible({ timeout: 15_000 });
  await expect
    .poll(async () => {
      const res = await ownerApi('me/playback/e.990001.1');
      return res.ok ? ((await res.json()) as { places: Record<string, { timeUs: number }> }).places.mkv?.timeUs ?? 0 : 0;
    }, { timeout: 15_000 })
    .toBeGreaterThanOrEqual(20 * S);
  await page.goto(`/nas/encodes/play/${EPISODE_ONE}?telemetry=1`);
  await expect(page.getByTestId('resume-prompt')).toBeVisible({ timeout: 15_000 });
  await expect(page.getByTestId('resume-at')).toHaveText(/^Resume at 0:2\d$/);
  await page.getByTestId('resume-at').click();
  await expect(player(page)).toHaveAttribute('data-state', 'playing', { timeout: 20_000 });
  expect(await shownTimeS(page)).toBeGreaterThanOrEqual(20);
});

/** Episode 1's file as a third episode: its EPISODE tag's value and its title rewritten in place (same lengths). */
function thirdEpisode(): Buffer {
  const bytes = readFileSync(join(REPO_ROOT, 'fixtures/encodes/990001/1.mkv'));
  // SimpleTag: TagName (45 A3, size 87) "EPISODE", then TagString (44 87, size 81) "1"
  const name = Buffer.concat([Buffer.from([0x45, 0xa3, 0x87]), Buffer.from('EPISODE'), Buffer.from([0x44, 0x87, 0x81])]);
  const at = bytes.indexOf(name);
  expect(at, 'the EPISODE tag').toBeGreaterThan(0);
  expect(bytes.indexOf(name, at + 1)).toBe(-1);
  bytes.write('3', at + name.length);
  for (let i = bytes.indexOf('The Lantern Road'); i >= 0; i = bytes.indexOf('The Lantern Road', i + 1)) bytes.write('The Lantern Gate', i);
  return bytes;
}

test("an owner's upload through the API appears in the show", async ({ page, browserName }) => {
  test.skip(browserName !== 'chromium', 'the upload changes the shared stand-in library; the Chrome project checks it');
  test.setTimeout(90_000);
  const bytes = thirdEpisode();
  // a temporary copy, never under fixtures/
  const path = test.info().outputPath('3.mkv');
  writeFileSync(path, bytes);
  const body = readFileSync(path);
  await exclusivelyAsync('encodes-library', async () => {
    try {
      const sha256 = createHash('sha256').update(body).digest('hex');
      const created = await ownerApi('encodes/uploads', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ size: body.length, sha256, name: '3.mkv' }) });
      expect(created.status).toBe(200);
      const { id } = (await created.json()) as { id: string };
      // two chunks, the second first: ranges may come in any order
      const half = Math.floor(body.length / 2);
      for (const [a, b] of [[half, body.length - 1], [0, half - 1]] as const) {
        const put = await ownerApi(`encodes/uploads/${id}`, { method: 'PUT', headers: { 'Content-Range': `bytes ${a}-${b}/${body.length}` }, body: body.subarray(a, b + 1) });
        expect(put.status).toBe(204);
      }
      const done = await ownerApi(`encodes/uploads/${id}/complete`, { method: 'POST' });
      expect(done.status).toBe(200);
      expect(((await done.json()) as { entry: { id: string } | null }).entry?.id).toBe(EPISODE_THREE);

      await pair(page, browserName);
      await openShow(page);
      await expect(page.getByTestId('episode-row')).toHaveCount(3);
      await expect(episodeRow(page, EPISODE_THREE)).toContainText('The Lantern Gate');
    } finally {
      await ownerApi(`encodes/${EPISODE_THREE}`, { method: 'DELETE' });
    }
  });
});

test('a device without AV1 sees the warning and no file read', async ({ page, browserName }) => {
  const reads: string[] = [];
  page.on('request', (r) => {
    if (new URL(r.url()).pathname.startsWith(`/api/encodes/${EPISODE_ONE}/files/`)) reads.push(r.url());
  });
  await pair(page, browserName, '&noav1=1');
  await openShow(page);
  await episodeRow(page, EPISODE_ONE).click();
  const warning = page.getByTestId('encode-av1-unsupported');
  await expect(warning).toBeVisible({ timeout: 15_000 });
  await expect(warning.getByRole('alert')).toContainText("This device can't decode AV1 video");
  await expect(page.getByTestId('encode-preflight-play')).toHaveCount(0);
  await page.waitForTimeout(1_000); // a read the warning failed to stop would have started by now
  expect(reads).toEqual([]);
  await expect(player(page)).toHaveCount(0);
});
