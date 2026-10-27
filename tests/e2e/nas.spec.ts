import { execFileSync } from 'node:child_process';
import { copyFileSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test, type Page, type Route } from '@playwright/test';
import { CHANGED_FOLDER, NAS_E2E_DIR, NAS_ENV, NAS_PORT, NAS_SERVER_KEY, OWNER_SERIES, PROJECTS, RENDEZVOUS_PORT, RENDEZVOUS_URL, SERVER, ownerDiscs, ownerStray, restoreChangedDisc } from './nas-server';
import { discKeyOf } from '../../src/engine/disc/disc-key';
import { normalizeCode } from '../../src/engine/disc/pairing-code';
import { skipWithoutH264 } from './support';
import { telemetry } from './telemetry';

// The NAS is tests/e2e/nas-server.ts: the built server over a copy of fixtures/synthetic (root `syn`, whose discs the
// library's top level lists), and the rendezvous Worker that turns a code into the server's address. Its title
// library matches made-up titles from tests/e2e/fixtures/nas-metadata.json against copies of synthetic discs.

const REPO_ROOT = fileURLToPath(new URL('../../', import.meta.url));

const sleep = (ms: number): void => void Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

/** Runs `fn` while no other worker does (the browsers' projects run side by side). */
function exclusively<T>(fn: () => T): T {
  const lock = join(NAS_E2E_DIR, 'owner-code.lock');
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

/** Runs `fn` while no other worker does, holding the lock while `fn` awaits (the release gate is the server's, shared). */
async function exclusivelyAsync<T>(name: string, fn: () => Promise<T>): Promise<T> {
  const lock = join(NAS_E2E_DIR, `${name}.lock`);
  for (let tries = 0; ; tries++) {
    try {
      mkdirSync(lock);
      break;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST' || tries > 1200) throw err;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }
  try {
    return await fn();
  } finally {
    rmSync(lock, { recursive: true, force: true });
  }
}

const NAS_API = `http://localhost:${NAS_PORT}/api/`;

const post = async (path: string, body: unknown): Promise<unknown> => {
  const res = await fetch(`${NAS_API}${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  expect(res.status, `POST ${path}`).toBe(200);
  return res.json();
};

/**
 * The owner person the running project's tests pair as: one per browser project, since the projects run at once against
 * one server and each person's places (and so the resume prompt) are their own.
 */
const projectOwner = (): string => `Owner ${test.info().project.name}`;

const apiSessions = new Map<string, Promise<string>>();
/**
 * A session token of an owner device this test worker pairs for itself (`E2E API`), as the app does: redeem an owner
 * code with a new P-256 key, then sign the NAS's challenge. Kept for the worker's run (sessions last an hour).
 */
function apiToken(): Promise<string> {
  const person = projectOwner();
  let session = apiSessions.get(person);
  if (!session) apiSessions.set(person, (session = sessionFor(ownerCode(person))));
  return session;
}

/** Pairs a device (`E2E API`) with `code` through the API and returns its session token. */
function sessionFor(rawCode: string): Promise<string> {
  return (async () => {
    const code = normalizeCode(rawCode)!;
    const key = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign', 'verify']);
    const { kty, crv, x, y } = await crypto.subtle.exportKey('jwk', key.publicKey);
    const { deviceId } = (await post('pair/redeem', { code, deviceName: 'E2E API', publicKeyJwk: { kty, crv, x, y } })) as { deviceId: string };
    const { challenge } = (await post('session/challenge', { deviceId })) as { challenge: string };
    const signature = Buffer.from(await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, key.privateKey, new TextEncoder().encode(challenge))).toString('base64url');
    const { token } = (await post('session', { deviceId, challenge, signature })) as { token: string };
    return token;
  })();
}

/** An owner route of the NAS API, as the owner device. */
async function ownerApi(path: string, init: RequestInit = {}): Promise<Response> {
  const headers = new Headers(init.headers);
  headers.set('Authorization', `Bearer ${await apiToken()}`);
  return fetch(`${NAS_API}${path}`, { ...init, headers });
}

/** Sets the release gate as the owner does, through the API. */
async function setGate(gate: 'owners' | 'everyone'): Promise<void> {
  const res = await ownerApi('admin/settings/title-library', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ gate }) });
  expect(res.status).toBe(204);
}

/**
 * Waits, through `GET admin/metadata/status`, for the server's first scan and title matching run (it matches after
 * scanning) to have filed the fixture's discs: until then the folder listing is empty, and the app fetches the titles
 * once per session.
 */
async function libraryReady(): Promise<void> {
  await expect
    .poll(
      async () => {
        const status = (await (await ownerApi('admin/metadata/status')).json()) as { running: boolean; lastRunAt: number | null; filed: number };
        return !status.running && status.lastRunAt !== null ? status.filed : 0;
      },
      { timeout: 30_000 },
    )
    .toBeGreaterThanOrEqual(3);
}

/**
 * A fresh owner code, minted the way the NAS owner does: `node server.mjs owner-code` against the server's data.
 * The rendezvous service holds at most 5 live codes per NAS and a run mints about 20 within its 10 minutes, so each
 * code is registered under a new NAS key (the server makes one when its key file is gone).
 */
function ownerCode(person: string = projectOwner()): string {
  return mintOwnerCode(() => rmSync(join(NAS_ENV.DATA_DIR!, 'rendezvous-key.json'), { force: true }), person);
}

/**
 * A fresh owner code whose WebRTC route leads to the running server: minted under the server's own rendezvous key
 * (its NAS id, whose signalling socket is open), put back in place of the last code's.
 */
function serverOwnerCode(): string {
  return mintOwnerCode(() => copyFileSync(NAS_SERVER_KEY, join(NAS_ENV.DATA_DIR!, 'rendezvous-key.json')), projectOwner());
}

/** For the owner person `person`, made when there is none. */
function mintOwnerCode(prepareKey: () => void, person: string): string {
  const out = exclusively(() => {
    prepareKey();
    return execFileSync(process.execPath, [SERVER, 'owner-code', '--person', person], { env: { ...process.env, ...NAS_ENV }, encoding: 'utf8' });
  });
  expect(out).toContain('Rendezvous: registered');
  return /Owner pairing code: ([0-9A-Z-]+)/.exec(out)![1]!;
}

/**
 * Counts the bytes the page's WebRTC data channels receive (`window.__rtcBytes`), in every page load: the positive proof
 * that the disc's reads came over the channel.
 */
async function countChannelBytes(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const w = window as unknown as { __rtcBytes: number };
    w.__rtcBytes = 0;
    const create = RTCPeerConnection.prototype.createDataChannel;
    RTCPeerConnection.prototype.createDataChannel = function (this: RTCPeerConnection, ...args: Parameters<typeof create>) {
      const channel = create.apply(this, args);
      channel.addEventListener('message', (e: MessageEvent<unknown>) => {
        const data = e.data;
        w.__rtcBytes += data instanceof ArrayBuffer ? data.byteLength : data instanceof Blob ? data.size : String(data).length;
      });
      return channel;
    };
  });
}

const channelBytes = (page: Page): Promise<number> => page.evaluate(() => (window as unknown as { __rtcBytes: number }).__rtcBytes);

/** The rendezvous lookup (at `worker`, the built-in one by default) as for a NAS whose HTTPS route this network can't use: its WebRTC route only. */
async function webrtcOnlyLookup(page: Page, worker = RENDEZVOUS_URL): Promise<void> {
  await page.route(`${worker}/codes/lookup`, async (route) => {
    if (route.request().method() !== 'POST') return route.continue();
    const response = await route.fetch();
    const body = (await response.json()) as { routes?: { webrtc?: unknown } };
    expect(body.routes?.webrtc).toBeDefined();
    await route.fulfill({ response, json: { ...body, routes: { webrtc: body.routes?.webrtc } } });
  });
}

/** Chrome asks before a page reaches the local network; the tests answer for the user where the browser supports it. */
async function allowLocalNetwork(page: Page, browserName: string): Promise<void> {
  if (browserName === 'chromium') await page.context().grantPermissions(['local-network-access']);
}

/** `query`: more of the app's flags (`&placemin=1`), read as it loads. */
async function pairByLink(page: Page, query = '', code = ownerCode()): Promise<void> {
  await page.goto(`/?pair=${code}&telemetry=1${query}`);
  await expect(page.getByTestId('pair-code')).toHaveValue(code);
  await page.getByTestId('pair-button').click();
  await expect(page.getByTestId('nas-paired')).toBeVisible({ timeout: 25_000 });
}

/** Pairs, then opens the title library (an owner always has it). */
/** `code`: pairs as that code's person (by default the project's owner person). */
async function openTitles(page: Page, browserName: string, query = '', code?: string): Promise<void> {
  await libraryReady();
  await allowLocalNetwork(page, browserName);
  await pairByLink(page, query, code);
  await page.getByTestId('nas-open').click();
  await expect(page.getByTestId('title-library')).toBeVisible({ timeout: 15_000 });
}

/** Pairs, then opens the folder browser at its top, from the title library. */
async function openLibrary(page: Page, browserName: string): Promise<void> {
  await openTitles(page, browserName);
  await page.getByTestId('browse-folders').click();
  await expect(page.getByTestId('nas-crumbs')).toHaveText('NAS');
}

const discRow = (page: Page, name: string) => page.locator(`[data-testid="nas-disc"][data-name="${name}"]`);

/** Opens a disc's pre-flight and plays it. */
async function playFromNas(page: Page, name: string): Promise<void> {
  await discRow(page, name).click();
  await expect(page.getByTestId('nas-preflight')).toBeVisible();
  await page.getByTestId('nas-play').click();
}

const playerState = (page: Page) => page.getByTestId('player');

/**
 * A project's tests play as its owner person, one after another, and a place one leaves unfinished would bring up the
 * resume prompt in place of Play in the next: each test starts with none (this project's person's only).
 */
test.beforeEach(async () => {
  const res = await ownerApi('me/playback');
  if (!res.ok) return;
  const keys = new Set(((await res.json()) as { kind: string; discKey: string }[]).filter((i) => i.kind === 'resume').map((i) => i.discKey));
  for (const key of keys) await ownerApi(`me/playback/${encodeURIComponent(key)}`, { method: 'DELETE' });
});

test('pairs from a ?pair= link with an owner code', async ({ page, browserName }) => {
  await allowLocalNetwork(page, browserName);
  await pairByLink(page);
  await expect(page.getByTestId('pair-screen')).toBeHidden();
  expect(new URL(page.url()).searchParams.has('pair')).toBe(false);
});

test("pairs with a code typed into the landing screen's field", async ({ page, browserName }) => {
  await allowLocalNetwork(page, browserName);
  const code = ownerCode();
  await page.goto('/');
  await page.getByTestId('pair-code').fill(code.replaceAll('-', '').toLowerCase());
  await expect(page.getByTestId('pair-code')).toHaveValue(code);
  await page.getByTestId('pair-button').click();
  await expect(page.getByTestId('nas-paired')).toBeVisible({ timeout: 25_000 });
});

/** Counts the lookups that reach the app's built-in Worker, and refuses them. */
async function refuseBuiltInLookups(page: Page): Promise<string[]> {
  const lookups: string[] = [];
  await page.route(`${RENDEZVOUS_URL}/codes/lookup`, (route) => {
    lookups.push(route.request().url());
    return route.abort('connectionrefused');
  });
  return lookups;
}

test("a link carrying the server's address pairs without the Worker", async ({ page, browserName }) => {
  await libraryReady();
  await allowLocalNetwork(page, browserName);
  const lookups = await refuseBuiltInLookups(page);
  const code = ownerCode();
  await page.goto(`/?pair=${code}&nas=${encodeURIComponent(NAS_API)}`);
  // nothing is sent before the person has seen where the link leads
  await expect(page.getByTestId('pair-confirm')).toBeVisible();
  await expect(page.getByTestId('pair-confirm-hosts')).toHaveText(`localhost:${NAS_PORT}`);
  await expect(page.getByTestId('pair-confirm')).toContainText('Only continue if you trust them.');
  // not paired yet: nothing to replace
  await expect(page.getByTestId('pair-confirm-replaces')).toBeHidden();
  const params = new URL(page.url()).searchParams;
  expect(['pair', 'nas', 'rv'].filter((name) => params.has(name))).toEqual([]);
  await page.getByTestId('pair-confirm-continue').click();
  await expect(page.getByTestId('pair-code')).toHaveValue(code);
  await page.getByTestId('pair-button').click();
  await expect(page.getByTestId('nas-paired')).toBeVisible({ timeout: 25_000 });
  await page.getByTestId('nas-open').click();
  await expect(page.getByTestId('title-library')).toBeVisible({ timeout: 15_000 });
  expect(lookups).toEqual([]);
});

test('Cancel on a pairing link that names a server sends nothing to it', async ({ page }) => {
  const sent: string[] = [];
  await page.context().route(`http://localhost:${NAS_PORT}/**`, (route) => {
    sent.push(route.request().url());
    return route.abort('connectionrefused');
  });
  await page.goto(`/?pair=ABCD-EFGH-JKMN&nas=${encodeURIComponent(NAS_API)}`);
  await page.getByTestId('pair-confirm-cancel').click();
  await expect(page.getByTestId('pair-confirm')).toBeHidden();
  await expect(page.getByTestId('pair-code')).toHaveValue('');
  await page.waitForTimeout(1_000); // anything sent on Cancel would have gone by now
  expect(sent).toEqual([]);
});

test('Cancel on a pairing link leaves a paired device as it was', async ({ page, browserName }) => {
  await allowLocalNetwork(page, browserName);
  await pairByLink(page);
  await page.goto(`/?pair=ABCD-EFGH-JKMN&nas=${encodeURIComponent('https://nas.example.com/bluray/api/')}`);
  await expect(page.getByTestId('pair-confirm-hosts')).toHaveText('nas.example.com');
  await expect(page.getByTestId('pair-confirm-replaces')).toHaveText('This device is already paired: continuing replaces its current pairing.');
  await page.getByTestId('pair-confirm-cancel').click();
  await expect(page.getByTestId('nas-paired')).toBeVisible();
  await expect(page.getByTestId('pair-screen')).toBeHidden();
});

test("a link naming the app's own Worker asks nothing", async ({ page, browserName }) => {
  await allowLocalNetwork(page, browserName);
  const code = ownerCode();
  await page.goto(`/?pair=${code}&rv=${encodeURIComponent(`${RENDEZVOUS_URL}/`)}`);
  await expect(page.getByTestId('pair-code')).toHaveValue(code);
  await expect(page.getByTestId('pair-confirm')).toBeHidden();
  await page.getByTestId('pair-button').click();
  await expect(page.getByTestId('nas-paired')).toBeVisible({ timeout: 25_000 });
});

test('a link whose address fails its check is refused, and its code goes nowhere', async ({ page }) => {
  const lookups = await refuseBuiltInLookups(page);
  await page.goto(`/?pair=ABCD-EFGH-JKMN&nas=${encodeURIComponent('http://nas.example.com/bluray/api/')}`);
  await expect(page.getByTestId('pair-error')).toHaveText("This pairing link names an address this app can't use (it must be https://). Ask for a new link.");
  await expect(page.getByTestId('pair-confirm')).toBeHidden();
  await expect(page.getByTestId('pair-button')).toBeDisabled();
  expect(lookups).toEqual([]);
});

test('a link carrying another Worker pairs through it', async ({ page, browserName }) => {
  test.skip(browserName === 'firefox' && process.platform === 'linux', 'Playwright Firefox on Linux gathers no ICE candidates');
  test.setTimeout(120_000);
  await libraryReady();
  await allowLocalNetwork(page, browserName);
  // The same stand-in Worker under another host: a Worker other than the app's built-in one (localhost) as far as the
  // app can tell (ruling R1). The NAS answers over WebRTC only, so the pairing's signalling has to go through it.
  const other = `http://127.0.0.1:${RENDEZVOUS_PORT}`;
  const lookups = await refuseBuiltInLookups(page);
  const httpsTried: string[] = [];
  await page.context().route(`http://localhost:${NAS_PORT}/**`, (route) => {
    httpsTried.push(route.request().url());
    return route.abort('connectionrefused');
  });
  await webrtcOnlyLookup(page, other);
  const sockets: string[] = [];
  page.on('websocket', (ws) => sockets.push(new URL(ws.url()).host));
  const code = serverOwnerCode();
  await page.goto(`/?pair=${code}&rv=${encodeURIComponent(other)}`);
  await expect(page.getByTestId('pair-confirm-hosts')).toHaveText(`127.0.0.1:${RENDEZVOUS_PORT}`);
  await page.getByTestId('pair-confirm-continue').click();
  await page.getByTestId('pair-button').click();
  await expect(page.getByTestId('nas-paired')).toBeVisible({ timeout: 30_000 });
  // after a reload too: the pairing remembers its Worker
  await page.reload();
  await page.getByTestId('nas-open').click();
  await expect(page.getByTestId('title-library')).toBeVisible({ timeout: 30_000 });
  expect(sockets.length).toBeGreaterThanOrEqual(2); // the redeem's connection, then the library's
  expect(new Set(sockets)).toEqual(new Set([`127.0.0.1:${RENDEZVOUS_PORT}`]));
  expect(lookups).toEqual([]);
  expect(httpsTried).toEqual([]);
});

test('a code typed with another rendezvous is looked up there', async ({ page, browserName }) => {
  await allowLocalNetwork(page, browserName);
  const lookups = await refuseBuiltInLookups(page);
  const code = ownerCode();
  await page.goto('/');
  await expect(page.getByTestId('pair-rendezvous-url')).toBeHidden();
  await page.getByTestId('pair-other-rendezvous').click();
  await page.getByTestId('pair-rendezvous-url').fill(`http://127.0.0.1:${RENDEZVOUS_PORT}/`);
  await page.getByTestId('pair-code').fill(code);
  await page.getByTestId('pair-button').click();
  await expect(page.getByTestId('nas-paired')).toBeVisible({ timeout: 25_000 });
  expect(lookups).toEqual([]);
});

test("the app bar's Help link opens the help pages from the title library, and Back returns to the library", async ({ page, browserName }) => {
  await openTitles(page, browserName);
  await page.getByTestId('help-link').click();
  await expect(page).toHaveURL(/\/help$/);
  await expect(page.getByTestId('help-index')).toBeVisible();
  await page.goBack();
  await expect(page.getByTestId('title-library')).toBeVisible({ timeout: 15_000 });
});

test("plays disc1 from the NAS after a pre-flight showing this connection's throughput", async ({ page, browserName }) => {
  await openLibrary(page, browserName);
  await skipWithoutH264(page, { realtime: false });
  await discRow(page, 'disc1').click();
  await expect(page.getByTestId('nas-preflight-line').first()).toHaveText(/^This connection: \d+ Mbps$/, { timeout: 15_000 });
  await page.getByTestId('nas-play').click();
  await expect(page.getByTestId('playlist-00000')).toBeVisible({ timeout: 15_000 });
  await page.getByTestId('playlist-00000').click();
  await expect(playerState(page)).toHaveAttribute('data-state', 'playing', { timeout: 15_000 });
});

test('buffers first on a slow connection: the pre-flight asks, and Wait fills the cache, then the disc plays', async ({ page, browserName }) => {
  test.skip(browserName !== 'chromium', 'one browser is enough for the pre-flight flow; the cache is unit-tested');
  await libraryReady();
  await allowLocalNetwork(page, browserName);
  // ?bufferask=1: disc1 plays for 8 s, so its wait is seconds long; the flag makes the pre-flight ask before any wait.
  const code = ownerCode();
  await page.goto(`/?pair=${code}&telemetry=1&bufferask=1`);
  await page.getByTestId('pair-button').click();
  await expect(page.getByTestId('nas-paired')).toBeVisible({ timeout: 25_000 });
  await skipWithoutH264(page, { realtime: false });
  // The probe throttled to about 1 Mbps (125 kB in a second), below disc1's rate (about 2.9 Mbps with the margin).
  await page.route('**/discs/*/probe?*', async (route) => {
    await new Promise((resolve) => setTimeout(resolve, 1_000));
    await route.fulfill({ status: 200, contentType: 'application/octet-stream', headers: { 'Access-Control-Allow-Origin': new URL(page.url()).origin }, body: Buffer.alloc(125_000) });
  });
  await page.getByTestId('nas-open').click();
  await page.getByTestId('browse-folders').click();
  await discRow(page, 'disc1').click();
  await expect(page.getByTestId('nas-buffer-wait')).toHaveText('About 1 minute before it can play straight through', { timeout: 15_000 });
  await expect(page.getByTestId('nas-play')).toHaveText('Play now with pauses');
  // the level list preselects one level (at about 1 Mbps nothing fits, so the cheapest: disc1's own rate is below the levels' budgets)
  const preselected = page.locator('[data-testid="level-option"]:checked');
  await expect(preselected).toHaveCount(1);
  // ?bufferask=1 makes every wait an ask, so the notes here are waits, not 'plays now'
  await expect(page.getByTestId('level-list')).toContainText('about 1 minute');
  await page.getByTestId('nas-wait').click();
  // disc1 opens to its playlists once the cache holds the wait's bytes
  await expect(page.getByTestId('playlist-00000')).toBeVisible({ timeout: 15_000 });
  const cached = await page.evaluate(async () => {
    const top = await (await navigator.storage.getDirectory()).getDirectoryHandle('read-ahead');
    const names: string[] = [];
    for await (const disc of (top as unknown as { values(): AsyncIterable<FileSystemDirectoryHandle> }).values()) {
      for await (const name of (disc as unknown as { keys(): AsyncIterable<string> }).keys()) names.push(name);
    }
    return names;
  });
  expect(cached.some((name) => name.startsWith('BDMV_2fSTREAM_2f00001_2eM2TS.') && name.endsWith('.bin'))).toBe(true);
  await page.getByTestId('playlist-00000').click();
  await expect(playerState(page)).toHaveAttribute('data-state', 'playing', { timeout: 15_000 });
});

/** Plays what a pre-flight opened: a disc that opens to its playlist picker gets its first playlist picked. */
async function startPlaylistIfPicked(page: Page): Promise<void> {
  const picked = page.getByTestId('playlist-00000');
  // a level's first bytes wait for the encoder, so the picker can take a while
  if (await picked.waitFor({ timeout: 30_000 }).then(() => true, () => false)) await picked.click();
}

/**
 * The quality-level tests take turns across the browsers: the NAS's encoder capacity is shared (six 1080p viewings fit,
 * and a lease lapses only 2 minutes after the last read), so three browsers' level viewings at once, with those of the
 * slow-connection test, left the next pre-flight with "The NAS is busy". The viewing is released at the end too.
 */
async function levelViewing(page: Page, body: () => Promise<void>): Promise<void> {
  await exclusivelyAsync('levels', async () => {
    await body();
    const released = page.waitForResponse((r) => r.request().method() === 'DELETE' && r.url().includes('/viewing?'), { timeout: 5_000 }).catch(() => null);
    await page.goBack();
    await released;
  });
}

test('plays a disc at a re-encoded level picked in the pre-flight, seeks, and switches to Original', async ({ page, browserName }) => {
  test.setTimeout(120_000);
  await levelViewing(page, async () => {
    await openLibrary(page, browserName);
    await skipWithoutH264(page, { realtime: false });
    // disc-levels (10 s, 1080p H.264) in place of disc1 (4 s): long enough to seek in
    await discRow(page, 'disc-levels').click();
    await expect(page.getByTestId('level-list')).toBeVisible({ timeout: 20_000 });
    await page.locator('[data-testid="level-option"][data-level="h264-1080"]').check();
    await page.getByTestId('nas-play').click();
    await startPlaylistIfPicked(page);
    await expect(playerState(page)).toHaveAttribute('data-state', 'playing', { timeout: 60_000 });
    const frames = async () => (await telemetry(page))?.framesPresented ?? 0;
    await expect.poll(frames, { timeout: 60_000 }).toBeGreaterThan(30);
    await expect(page.getByTestId('level-badge')).toHaveText('1080p · re-encoded on the NAS');
    // seek: ArrowRight (+10 s) would land at the end of a 10 s disc, so seek back to the start; frames keep advancing past it
    await expect.poll(async () => (await telemetry(page))?.clockUs ?? 0, { timeout: 30_000 }).toBeGreaterThan(2_000_000);
    await page.keyboard.press('ArrowLeft');
    const afterSeek = await frames();
    await expect.poll(frames, { timeout: 30_000 }).toBeGreaterThan(afterSeek + 10);
    // back to Original through the Quality menu
    await page.getByTestId('quality-menu').click();
    await page.locator('[role="menuitemradio"][data-level="original"]').click();
    await expect(page.getByTestId('level-badge')).toBeHidden({ timeout: 60_000 });
    await expect(page.getByTestId('level-notice')).toBeHidden({ timeout: 60_000 });
    // a slow runner can reach the end of the 10 s disc by now (it then rests paused on the last frame): start over
    await page.getByTestId('quality-menu').blur();
    await page.keyboard.press('ArrowLeft');
    if ((await playerState(page).getAttribute('data-state')) !== 'playing') await page.getByRole('button', { name: 'Play', exact: true }).click();
    await expect(playerState(page)).toHaveAttribute('data-state', 'playing', { timeout: 30_000 });
    const afterSwitch = await frames();
    await expect.poll(frames, { timeout: 30_000 }).toBeGreaterThan(afterSwitch + 10);
  });
});

test('a busy NAS refusing the level leaves the address bar where Play was pressed', async ({ page, browserName }) => {
  test.skip(browserName !== 'chromium', 'one browser is enough for the pre-flight flow');
  await openLibrary(page, browserName);
  await discRow(page, 'disc-levels').click();
  await expect(page.getByTestId('level-list')).toBeVisible({ timeout: 20_000 });
  await page.locator('[data-testid="level-option"][data-level="h264-1080"]').check();
  const before = page.url();
  // the level's manifest answers busy, as the NAS does when its GPU has no room
  await page.route('**/discs/*/manifest?level=*', (route) =>
    route.fulfill({
      status: 503,
      contentType: 'application/json',
      headers: { 'Access-Control-Allow-Origin': new URL(page.url()).origin },
      body: JSON.stringify({ error: 'busy', message: 'The NAS is busy. Try again in a few minutes.' }),
    }),
  );
  await expect(page.getByTestId('nas-play')).toBeEnabled({ timeout: 20_000 });
  await page.getByTestId('nas-play').click();
  await expect(page.getByTestId('nas-error')).toHaveText('The NAS is busy. Try again in a few minutes.', { timeout: 15_000 });
  expect(page.url()).toBe(before);
  expect(new URL(page.url()).pathname).not.toContain('/play/');
});

test('an MPEG-2 disc plays with a picture at a re-encoded level', async ({ page, browserName }) => {
  test.setTimeout(120_000);
  await levelViewing(page, async () => {
    await openLibrary(page, browserName);
    await skipWithoutH264(page, { realtime: false });
    // disc-mpeg2 (the same video as disc-mpeg2-menu, with no menu): it opens to its playlist picker
    await discRow(page, 'disc-mpeg2').click();
    await expect(page.getByTestId('level-list')).toBeVisible({ timeout: 20_000 });
    const original = page.locator('[data-testid="level-option"][data-level="original"]');
    await expect(original).toBeDisabled();
    await expect(original.locator('xpath=ancestor::label[1]')).toContainText("can't play in this browser");
    await expect(page.getByTestId('nas-play')).toBeEnabled({ timeout: 20_000 });
    await expect(page.locator('[data-testid="level-option"]:checked')).toHaveCount(1);
    await expect(page.locator('[data-testid="level-option"]:checked')).not.toHaveAttribute('data-level', 'original');
    await page.getByTestId('nas-play').click();
    await startPlaylistIfPicked(page);
    await expect(playerState(page)).toHaveAttribute('data-state', 'playing', { timeout: 60_000 });
    await expect.poll(async () => (await telemetry(page))?.framesPresented ?? 0, { timeout: 60_000 }).toBeGreaterThan(30);
    await expect(page.getByRole('status').filter({ hasText: "This disc's video can't be played here yet" })).toHaveCount(0);
  });
});

test('opens disc-menu from the NAS into its menu', async ({ page, browserName }) => {
  await openLibrary(page, browserName);
  await skipWithoutH264(page, { realtime: false });
  await playFromNas(page, 'disc-menu');
  await expect(playerState(page)).toHaveAttribute('data-menu-active', 'true', { timeout: 15_000 });
});

test('plays the playlist the Java of disc-bdj selects, from the NAS', async ({ page, browserName }) => {
  await openLibrary(page, browserName);
  await skipWithoutH264(page);
  await playFromNas(page, 'disc-bdj');
  await page.waitForFunction(() => document.querySelector('[data-testid="player"]')?.getAttribute('data-state') === 'playing', undefined, { polling: 'raf', timeout: 30_000 });
  await expect(playerState(page)).toHaveAttribute('data-playlist', '00000');
});

test('pairs, browses and plays over WebRTC when HTTPS to the NAS is unreachable: disc1 for 3 s, then disc-bdj', async ({ page, browserName }) => {
  // Measured 2026-10-19 in Playwright's Firefox on Linux (CI and the Playwright image): the peer connection gathers no
  // ICE candidates at all, whatever the media.peerconnection.ice.* prefs, and fails before the answer arrives.
  // Firefox on macOS runs this test, and the device run covers real browsers.
  test.skip(browserName === 'firefox' && process.platform === 'linux', 'Playwright Firefox on Linux gathers no ICE candidates');
  test.setTimeout(180_000);
  await libraryReady();
  await allowLocalNetwork(page, browserName);
  const httpsTried: string[] = [];
  await page.context().route(`http://localhost:${NAS_PORT}/**`, (route) => {
    httpsTried.push(route.request().url());
    return route.abort('connectionrefused');
  });
  await webrtcOnlyLookup(page);
  await countChannelBytes(page);
  const code = serverOwnerCode();
  await page.goto(`/?pair=${code}&telemetry=1&rtcrelayed=1`);
  await expect(page.getByTestId('pair-code')).toHaveValue(code);
  await page.getByTestId('pair-button').click();
  await expect(page.getByTestId('nas-paired')).toBeVisible({ timeout: 30_000 });
  await skipWithoutH264(page);
  const browse = async (): Promise<void> => {
    await page.getByTestId('nas-open').click();
    await expect(page.getByTestId('title-library')).toBeVisible({ timeout: 30_000 });
    await page.getByTestId('browse-folders').click();
    await expect(page.getByTestId('nas-crumbs')).toHaveText('NAS');
  };
  await browse();
  await playFromNas(page, 'disc1');
  await expect(page.getByTestId('playlist-00000')).toBeVisible({ timeout: 20_000 });
  await page.getByTestId('playlist-00000').click();
  await expect(playerState(page)).toHaveAttribute('data-state', 'playing', { timeout: 20_000 });
  await expect.poll(async () => (await telemetry(page))?.clockUs ?? 0, { timeout: 20_000 }).toBeGreaterThanOrEqual(3_000_000);
  await expect(page.getByTestId('relay-badge')).toContainText('Relayed'); // ?rtcrelayed=1 makes the connection count as relayed
  expect(await channelBytes(page)).toBeGreaterThan(1_000_000); // most of disc1's first 1.3 MB clip, over the channel

  // A new page load: the pairing has no HTTPS base, so it connects over WebRTC at once. The address bar kept the play
  // link, so the load opens the disc's pre-flight (resolved over the channel); its Back returns to the folder browser.
  await page.reload();
  await expect(page.getByTestId('nas-preflight')).toBeVisible({ timeout: 30_000 });
  // the pre-flight settles (the levels, the places) before it is clicked: it re-renders as each answer arrives over the channel
  await expect(page.getByTestId('level-list')).toBeVisible({ timeout: 30_000 });
  await page.getByTestId('nas-preflight').getByRole('button', { name: 'Back' }).click();
  await expect(page.getByTestId('nas-crumbs')).toHaveText('NAS', { timeout: 30_000 });
  await playFromNas(page, 'disc-bdj');
  await page.waitForFunction(() => document.querySelector('[data-testid="player"]')?.getAttribute('data-state') === 'playing', undefined, { polling: 'raf', timeout: 45_000 });
  await expect(playerState(page)).toHaveAttribute('data-playlist', '00000');
  await expect.poll(() => channelBytes(page)).toBeGreaterThan(500_000); // disc-bdj's 0.66 MB clip, over the channel
  expect(httpsTried).toEqual([]);
});

test("a device that connects while the NAS's signalling socket is down is told it can't connect", async ({ page, browserName }) => {
  await allowLocalNetwork(page, browserName);
  await webrtcOnlyLookup(page);
  const code = ownerCode(); // under a NAS key of its own, whose signalling socket never opens
  const closed: string[] = [];
  page.on('websocket', (ws) => ws.on('close', () => closed.push(new URL(ws.url()).pathname)));
  await page.goto(`/?pair=${code}`);
  await expect(page.getByTestId('pair-code')).toHaveValue(code);
  const started = Date.now();
  await page.getByTestId('pair-button').click();
  await expect(page.getByTestId('pair-error')).toHaveText("Can't connect to the NAS from this network. Try another Wi-Fi or mobile data.", { timeout: 15_000 });
  // The Worker's offline close (4404), not the 10 s wait for its hello.
  expect(Date.now() - started).toBeLessThan(8_000);
  expect(closed).toContain('/signal/device');
});

test('plays disc1.iso from the NAS', async ({ page, browserName }) => {
  await openLibrary(page, browserName);
  await skipWithoutH264(page, { realtime: false });
  await expect(discRow(page, 'disc1.iso')).toContainText('ISO');
  await playFromNas(page, 'disc1.iso');
  await expect(page.getByTestId('playlist-00000')).toBeVisible({ timeout: 15_000 });
  await page.getByTestId('playlist-00000').click();
  await expect(playerState(page)).toHaveAttribute('data-state', 'playing', { timeout: 15_000 });
});

test('a disc deleted after its folder was listed says so', async ({ page, browserName }, testInfo) => {
  const project = testInfo.project.name;
  const dir = restoreChangedDisc(project); // listed by the server's scan at start
  await openLibrary(page, browserName);
  await page.locator(`[data-testid="nas-folder"][data-name="${CHANGED_FOLDER}"]`).click();
  await expect(page.getByTestId('nas-crumbs')).toHaveText(`NAS › syn › ${CHANGED_FOLDER}`);
  await expect(discRow(page, project)).toBeVisible();
  rmSync(dir, { recursive: true, force: true });
  await discRow(page, project).click();
  await expect(page.getByTestId('nas-error')).toHaveText('This disc changed on the NAS. Open its folder again.');
  await expect(page.getByTestId('nas-play')).toBeDisabled();
});

test('a disc whose probe finds no clip shows no throughput line and still plays', async ({ page, browserName }) => {
  await openLibrary(page, browserName);
  await skipWithoutH264(page, { realtime: false });
  // As the server answers for a disc without a .M2TS.
  await page.route('**/discs/*/probe?*', (route) =>
    route.fulfill({ status: 404, contentType: 'application/json', headers: { 'Access-Control-Allow-Origin': new URL(page.url()).origin }, body: '{"error":"not found"}' }),
  );
  await discRow(page, 'disc1').click();
  await expect(page.getByTestId('nas-play')).toBeEnabled({ timeout: 15_000 });
  await expect(page.getByText('Measuring this connection…')).toBeHidden();
  await expect(page.getByTestId('nas-preflight-line')).toHaveCount(0);
  await expect(page.getByTestId('nas-error')).toHaveCount(0);
  await page.getByTestId('nas-play').click();
  await expect(page.getByTestId('playlist-00000')).toBeVisible({ timeout: 15_000 });
});

test('a disc deleted after its pre-flight fails to open, and Play works again', async ({ page, browserName }, testInfo) => {
  const project = `${testInfo.project.name}-open`;
  const dir = restoreChangedDisc(project);
  await openLibrary(page, browserName);
  await page.locator(`[data-testid="nas-folder"][data-name="${CHANGED_FOLDER}"]`).click();
  await discRow(page, project).click();
  await expect(page.getByTestId('nas-play')).toBeEnabled({ timeout: 15_000 });
  // Original, whatever the auto rule picked (a small screen takes Phone, whose open fails in the pre-flight itself, with its own error)
  await page.locator('[data-testid="level-option"][data-level="original"]').check();
  rmSync(dir, { recursive: true, force: true });
  await page.getByTestId('nas-play').click();
  await expect(page.getByTestId('error')).toContainText('This disc changed on the NAS. Open its folder again.', { timeout: 15_000 });
  await expect(page.getByTestId('nas-play')).toBeEnabled();
});

/** A folder every test leaves alone: the guest's check must not depend on `changed`, which the tests above empty and any rescan then drops. */
const GUEST_FOLDER = 'Anime';

test('the owner invites Mika, who pairs as Mika, then removes Mika, and rescans', async ({ page, browser, browserName }) => {
  await openLibrary(page, browserName);
  await page.getByTestId('nas-settings').click();
  await expect(page.getByTestId('nas-admin')).toBeVisible();
  // A code for a new person, Mika, not an owner, sent as an invite.
  await expect(page.getByTestId('nas-code-person')).toHaveValue('new');
  await page.getByTestId('nas-new-person-name').fill('Mika');
  await expect(page.getByTestId('nas-new-person-owner')).not.toBeChecked();
  await page.getByTestId('nas-code-invite').check();
  const mintedResponse = page.waitForResponse((r) => r.url().endsWith('/admin/codes') && r.request().method() === 'POST');
  await page.getByTestId('nas-new-code').click();
  const minted = (await (await mintedResponse).json()) as { personId: string; personName: string; invite: boolean };
  expect(minted).toMatchObject({ personName: 'Mika', invite: true });
  const codeText = page.getByTestId('nas-code');
  await expect(codeText).toHaveText(/^[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}$/, { timeout: 15_000 });
  await expect(page.getByTestId('nas-code-qr')).toBeVisible();
  await expect(page.getByTestId('nas-code-for')).toHaveText('For Mika · an invite, valid 3 days');
  await expect(page.getByTestId('nas-code-expiry')).toHaveText('Expires in 3 days');
  await expect(page.getByTestId('nas-code-copy')).toBeVisible();
  const code = (await codeText.textContent())!;
  // Every browser's project makes its own Mika on the shared server: this one is found by its id.
  const mikaRow = page.locator(`[data-testid="nas-person-Mika"][data-person-id="${minted.personId}"]`);
  await expect(mikaRow).toContainText('No devices yet');

  // A second browser, as Mika.
  const mikaContext = await browser.newContext();
  try {
    const mika = await mikaContext.newPage();
    await allowLocalNetwork(mika, browserName);
    await mika.goto('/');
    await mika.getByTestId('pair-code').fill(code);
    await mika.getByTestId('pair-device-name').fill('iPad');
    await mika.getByTestId('pair-button').click();
    await expect(mika.getByTestId('nas-paired')).toBeVisible({ timeout: 25_000 });
    await expect(mika.getByTestId('nas-paired')).toContainText('Paired as Mika.');
    // Review Focus 5. The gate is the server's, so the browsers take turns with it.
    await exclusivelyAsync('gate', async () => {
      try {
        // A guest while the gate is closed: the folder browser, with no error notice.
        await mika.getByTestId('nas-open').click();
        await expect(mika.getByTestId('nas-crumbs')).toHaveText('NAS');
        await expect(mika.getByTestId('title-library')).toHaveCount(0);
        await expect(mika.getByTestId('nas-error')).toHaveCount(0);
        await expect(mika.getByTestId('error')).toHaveCount(0);
        // A guest: the listing is up, and there is no way into the settings.
        await expect(mika.locator(`[data-testid="nas-folder"][data-name="${GUEST_FOLDER}"]`)).toBeVisible();
        await expect(mika.getByTestId('nas-settings')).toHaveCount(0);
        // The guest's folders are in the address bar too: a folder, then the browser's Back, is the top again.
        expect(new URL(mika.url()).pathname).toBe('/nas/folders');
        await mika.locator(`[data-testid="nas-folder"][data-name="${GUEST_FOLDER}"]`).click();
        await expect(mika.getByTestId('nas-crumbs')).not.toHaveText('NAS');
        await mika.goBack();
        await expect(mika.getByTestId('nas-crumbs')).toHaveText('NAS');
        await expect(mika.locator(`[data-testid="nas-folder"][data-name="${GUEST_FOLDER}"]`)).toBeVisible();

        // Once the owner opens the gate, the guest's next app load shows the library, without the owner's parts.
        await setGate('everyone');
        await mika.goto('/');
        await mika.getByTestId('nas-open').click();
        await expect(mika.getByTestId('title-library')).toBeVisible({ timeout: 15_000 });
        await expect(mika.locator('[data-testid="title-shelf"][data-shelf="series"]')).toBeVisible();
        await expect(mika.locator('[data-testid="title-shelf"][data-shelf="unsorted"]')).toHaveCount(0);
        await expect(mika.getByTestId('nas-settings')).toHaveCount(0);
        await mika.getByTestId('browse-folders').click();
        await expect(mika.getByTestId('nas-crumbs')).toHaveText('NAS');
      } finally {
        await setGate('owners');
      }
    });

    // The owner's People list shows Mika with one device (other tests' people and devices share the server).
    await expect(mikaRow.getByTestId('nas-device')).toHaveCount(1, { timeout: 15_000 });
    await expect(mikaRow.getByTestId('nas-device')).toContainText(/^iPad · last seen just now/);
    await expect(mikaRow.locator('.badge')).toHaveCount(0);
    const ownRow = page.getByTestId('nas-device').filter({ hasText: '(this device)' });
    await expect(ownRow).toHaveCount(1);
    // This device's own row asks first.
    await ownRow.getByTestId('nas-revoke').click();
    await expect(ownRow).toContainText('Revoke this device?');
    await ownRow.getByTestId('nas-revoke-cancel').click();
    await expect(ownRow.getByTestId('nas-revoke')).toBeVisible();
    // So does taking owner rights from this device's own person.
    const ownPersonRow = page.locator('[data-person-id]').filter({ has: ownRow });
    await ownPersonRow.getByTestId('nas-person-owner').click();
    await expect(ownPersonRow).toContainText('This device will lose NAS settings. Only another owner can give them back.');
    await ownPersonRow.getByRole('button', { name: 'Cancel' }).click();
    await expect(ownPersonRow.getByTestId('nas-person-owner')).toHaveText('Remove owner');
    // Removing Mika says what goes first.
    await mikaRow.getByTestId('nas-person-remove').click();
    await expect(mikaRow).toContainText('Remove Mika? Their device iPad is unpaired.');
    await mikaRow.getByTestId('nas-person-remove-confirm').click();
    await expect(mikaRow).toHaveCount(0);

    // Mika's next library request finds the device gone with its person: back to pairing.
    await mika.locator(`[data-testid="nas-folder"][data-name="${GUEST_FOLDER}"]`).click();
    await expect(mika.getByTestId('error')).toHaveText('This device is no longer paired with the NAS.');
    await expect(mika.getByTestId('pair-screen')).toBeVisible();
    await expect(mika.getByTestId('nas-library')).toHaveCount(0);
  } finally {
    await mikaContext.close();
  }

  await page.getByTestId('nas-rescan').click();
  await expect(page.getByTestId('nas-admin-status')).toHaveText('Rescanning…');

  // A plain code for an existing person: this device's. The answer is stubbed: another code per browser registered
  // with the rendezvous service would pass its 20-live-codes cap on this server's key (redeeming one is tested in server/).
  const ownPerson = page.locator('[data-person-id]').filter({ has: page.getByTestId('nas-device').filter({ hasText: '(this device)' }) });
  const ownPersonId = (await ownPerson.getAttribute('data-person-id'))!;
  await expect(page.getByTestId('nas-code-person')).toHaveValue('new');
  await page.getByTestId('nas-code-person').selectOption(ownPersonId);
  await expect(page.getByTestId('nas-new-person-name')).toHaveCount(0);
  await page.getByTestId('nas-code-invite').uncheck();
  const origin = new URL(page.url()).origin;
  let body: unknown;
  await page.route('**/api/admin/codes', async (route) => {
    if (route.request().method() !== 'POST') return route.fallback();
    body = route.request().postDataJSON();
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      headers: { 'Access-Control-Allow-Origin': origin },
      body: JSON.stringify({
        code: 'K7QM-4XP2-R9TD', link: 'https://bluray.pages.dev/?pair=K7QM4XP2R9TD', expiresAt: Date.now() + 600_000, rendezvous: false,
        personId: ownPersonId, personName: 'Owner', invite: false,
      }),
    });
  });
  await page.getByTestId('nas-new-code').click();
  await expect(codeText).toHaveText('K7QM-4XP2-R9TD');
  await expect(page.getByTestId('nas-code-for')).toHaveText('For Owner · valid 10 minutes');
  expect(body).toEqual({ personId: ownPersonId, invite: false });
  // The stub's code wasn't registered with the rendezvous service: it says where the code still works.
  await expect(page.getByTestId('nas-code-rendezvous')).toHaveText(
    "The pairing service didn't take this code, so it only works on your home network or over Tailscale. Try again later for a friend away from home.",
  );

  // Another owner takes this device's owner status away (stubbed, as the Owner person is every browser's): the next
  // people reload is refused, the settings close, and the library no longer offers them.
  const stub = (status: number, json: unknown) => (route: Route) =>
    route.fulfill({ status, contentType: 'application/json', headers: { 'Access-Control-Allow-Origin': origin }, body: JSON.stringify(json) });
  await page.route('**/api/admin/people', stub(403, { error: 'forbidden' }));
  await page.route('**/api/me', stub(200, { owner: false, titleLibrary: false, personId: ownPersonId, personName: 'Owner' }));
  await page.getByTestId('nas-new-code').click();
  await expect(page.getByTestId('nas-admin')).toHaveCount(0);
  await expect(page.getByTestId('nas-admin-error')).toHaveCount(0);
  await expect(page.getByTestId('nas-crumbs')).toBeVisible();
  await expect(page.getByTestId('nas-settings')).toHaveCount(0);
});

test('an owner browses the NAS by title: shelves, search, a series and its season', async ({ page, browserName }) => {
  // The shelf counts are the server's: the owner screens' tests change them, and restore them, under the same lock.
  await exclusivelyAsync('catalogue', () => browseByTitle(page, browserName));
});

async function browseByTitle(page: Page, browserName: string): Promise<void> {
  await openTitles(page, browserName);
  const shelf = (id: string) => page.locator(`[data-testid="title-shelf"][data-shelf="${id}"]`);
  await expect(shelf('series')).toHaveText(/^Series\s*1$/);
  await expect(shelf('movie')).toHaveText(/^Movies\s*1$/);
  await expect(shelf('music')).toHaveText(/^Music\s*1$/);
  await expect(shelf('unsorted')).toContainText('Unsorted');
  const card = (name: string) => page.locator(`[data-testid="title-card"][data-name="${name}"]`);
  await expect(card('Starfall Wanderer')).toContainText('星降りの旅人');
  await expect(card('Moonlit Harbor')).toBeVisible();
  // a music release by its found title (the folder says only "Night Lights")
  await expect(card('Night Lights Live 2024')).toBeVisible();

  // Search by English, romaji and Japanese names; a blank search shows the shelves again.
  const search = page.getByTestId('title-search');
  const results = page.getByTestId('title-row');
  for (const [query, name] of [['starfall', 'Starfall Wanderer'], ['hoshifuri', 'Starfall Wanderer'], ['月影', 'Moonlit Harbor']]) {
    await search.fill(query!);
    await expect(results).toHaveCount(1);
    await expect(results).toHaveAttribute('data-name', name!);
  }
  await search.fill('');
  await expect(card('Moonlit Harbor')).toBeVisible();

  // The Movies shelf alone.
  await shelf('movie').click();
  await expect(page.getByTestId('title-card')).toHaveCount(1);
  await expect(card('Moonlit Harbor')).toBeVisible();
  await shelf('movie').click();

  // The series, its season, and the season's Episodes and Discs.
  await card('Starfall Wanderer').click();
  await expect(page.getByTestId('series-name')).toHaveText('Starfall Wanderer');
  await expect(page.getByTestId('series-screen')).toContainText('Hoshifuri no Tabibito');
  await expect(page.getByTestId('series-screen')).toContainText('TV · 2016 · 1 season');
  const season = page.locator('[data-testid="season-row"][data-label="Season 1"]');
  await expect(season).toContainText('1 episode · 2 discs');
  await season.click();
  await expect(page.getByTestId('season-screen')).toContainText('Starfall Wanderer');
  await expect(page.getByTestId('season-tab')).toHaveText(['Episodes', 'Discs']);
  await expect(page.getByTestId('episode-row')).toHaveCount(1);
  await expect(page.getByTestId('episode-row')).toContainText('Episode 1');
  await page.locator('[data-testid="season-tab"][data-tab="discs"]').click();
  await expect(page.getByTestId('disc-card')).toHaveText([/^Disc 1 · Episode 1/, /^Disc 2/]);
  await expect(page.getByTestId('disc-copy').first()).toContainText('Anime/Starfall Wanderer (星降りの旅人)/Starfall Wanderer Vol.1');
}

test("tapping an episode plays the episode's playlist", async ({ page, browserName }) => {
  await openTitles(page, browserName);
  await skipWithoutH264(page, { realtime: false });
  await page.locator('[data-testid="title-card"][data-name="Starfall Wanderer"]').click();
  await page.locator('[data-testid="season-row"][data-label="Season 1"]').click();
  await page.locator('[data-testid="episode-row"][data-number="1"]').click();
  await expect(page.getByTestId('nas-preflight')).toContainText('Episode 1 · Starfall Wanderer Vol.1');
  await page.getByTestId('nas-play').click();
  // The episode is disc1's 4-second playlist 00001, not the 00000 the disc's picker would offer first.
  await page.waitForFunction(() => document.querySelector('[data-testid="player"]')?.getAttribute('data-state') === 'playing', undefined, { polling: 'raf', timeout: 15_000 });
  await expect(playerState(page)).toHaveAttribute('data-playlist', '00001');
});

test('"Browse by folder instead" opens the folder browser', async ({ page, browserName }) => {
  await openTitles(page, browserName);
  await page.getByTestId('browse-folders').click();
  await expect(page.getByTestId('nas-crumbs')).toHaveText('NAS');
  await expect(page.getByTestId('title-library')).toHaveCount(0);
  await expect(page.locator('[data-testid="nas-folder"][data-name="Anime"]')).toBeVisible();
});

test("an episode whose playlist isn't on its disc opens the disc normally, with a notice", async ({ page, browserName }) => {
  await openTitles(page, browserName);
  await skipWithoutH264(page, { realtime: false });
  // As if the catalogue named a playlist the disc doesn't have.
  await page.route('**/api/titles/anilist%3A900001', async (route) => {
    const res = await route.fetch();
    const detail = (await res.json()) as { seasons: { episodes: { playlistId: string }[] | null }[] };
    for (const s of detail.seasons) for (const e of s.episodes ?? []) e.playlistId = '00009';
    await route.fulfill({ response: res, json: detail });
  });
  await page.locator('[data-testid="title-card"][data-name="Starfall Wanderer"]').click();
  await page.locator('[data-testid="season-row"][data-label="Season 1"]').click();
  await page.locator('[data-testid="episode-row"][data-number="1"]').click();
  await page.getByTestId('nas-play').click();
  // disc1 has no menu: opened normally, it offers its playlists.
  await expect(page.getByTestId('playlist-00000')).toBeVisible({ timeout: 15_000 });
  await expect(page.getByText("This episode isn't on this disc; it opened normally.")).toBeVisible();
  await expect(page.getByTestId('error')).toHaveCount(0);
});

test('on a phone the header is compact, and the alphabet bars sit clear of the list and answer a tap', async ({ browser, browserName }) => {
  // a touch phone's layout: coarse pointer, so every button gets its 44 px minimum
  const phone = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, ...(browserName === 'firefox' ? {} : { isMobile: true }) });
  try {
    const page = await phone.newPage();
    await openTitles(page, browserName);
    const left = page.getByTestId('alphabet-rail-left');
    const right = page.getByTestId('alphabet-rail-right');
    const list = page.locator('.titles-body');
    await expect(left).toBeVisible();
    const [l, r, body] = await Promise.all([left.boundingBox(), right.boundingBox(), list.boundingBox()]);
    // each bar's keys stay inside it, and the bars keep their distance from the list
    for (const [rail, box] of [[left, l!], [right, r!]] as const) {
      const key = await rail.locator('[data-rail-key]').first().boundingBox();
      expect(key!.x).toBeGreaterThanOrEqual(box.x - 0.5);
      expect(key!.x + key!.width).toBeLessThanOrEqual(box.x + box.width + 0.5);
    }
    expect(body!.x - (l!.x + l!.width)).toBeGreaterThanOrEqual(8);
    expect(r!.x - (body!.x + body!.width)).toBeGreaterThanOrEqual(8);
    expect(r!.x + r!.width).toBeLessThanOrEqual(390);
    // the pinned header stays compact: heading, search and one row of shelves that swipes sideways
    const header = (await page.getByTestId('titles-sticky').boundingBox())!;
    expect(header.height).toBeLessThanOrEqual(170);
    const shelves = await page.locator('.title-shelves [data-testid="title-shelf"]').evaluateAll((chips) => new Set(chips.map((c) => Math.round(c.getBoundingClientRect().top))).size);
    expect(shelves).toBe(1);
    // Starfall Wanderer reads ほしふり: a tap on は re-sorts by reading, a tap on S back to A–Z
    const heading = page.locator('.title-section', { hasText: /^Series / });
    await right.locator('[data-rail-key="は"]').tap();
    await expect(heading).toHaveText('Series 五十音順');
    await left.locator('[data-rail-key="S"]').tap();
    await expect(heading).toHaveText('Series A–Z');
  } finally {
    await phone.close();
  }
});

test('the title screens move focus to the new heading, and back to the opener', async ({ page, browserName }) => {
  await openTitles(page, browserName);
  const card = page.locator('[data-testid="title-card"][data-name="Starfall Wanderer"]');
  await card.click();
  await expect(page.getByTestId('series-name')).toBeFocused();
  const season = page.locator('[data-testid="season-row"][data-label="Season 1"]');
  await season.click();
  await expect(page.getByTestId('season-screen').locator('h2')).toBeFocused();
  // The tabs: arrow keys move between them, selecting as they go.
  const tabs = page.getByTestId('season-tab');
  await expect(page.getByRole('tablist', { name: 'Season view' })).toBeVisible();
  await tabs.first().focus();
  await page.keyboard.press('ArrowRight');
  await expect(tabs.nth(1)).toBeFocused();
  await expect(tabs.nth(1)).toHaveAttribute('aria-selected', 'true');
  await expect(page.getByRole('tabpanel')).toHaveAttribute('aria-labelledby', (await tabs.nth(1).getAttribute('id'))!);
  await page.getByRole('button', { name: 'Back to Starfall Wanderer' }).click();
  await expect(season).toBeFocused();
  await page.getByRole('button', { name: 'Back', exact: true }).click();
  await expect(card).toBeFocused();
});

/** The page's path and query, without the origin. */
const pathOf = (page: Page): string => {
  const url = new URL(page.url());
  return url.pathname + url.search;
};

test('library screens are in the address bar, and Back and Forward move between them', async ({ page, browserName }) => {
  await openTitles(page, browserName);
  expect(pathOf(page)).toBe('/nas');
  const card = page.locator('[data-testid="title-card"][data-name="Starfall Wanderer"]');
  const titleId = (await card.getAttribute('data-title-id'))!;
  await card.click();
  await expect(page.getByTestId('series-name')).toHaveText('Starfall Wanderer');
  expect(pathOf(page)).toBe(`/nas/title/${encodeURIComponent(titleId)}`);
  const season = page.locator('[data-testid="season-row"][data-label="Season 1"]');
  // The season's key in the path is its catalogue id after the '#'.
  const seasonId = (await season.getAttribute('data-season-id'))!;
  const seasonPath = `/nas/title/${encodeURIComponent(titleId)}/season/${encodeURIComponent(seasonId.slice(seasonId.indexOf('#') + 1))}`;
  await season.click();
  await expect(page.getByTestId('season-screen')).toBeVisible();
  expect(pathOf(page)).toBe(seasonPath);

  await page.goBack();
  await expect(page.getByTestId('series-screen')).toBeVisible();
  await expect(page.getByTestId('season-screen')).toHaveCount(0);
  await expect(season).toBeFocused();
  await page.goForward();
  await expect(page.getByTestId('season-screen')).toBeVisible();
  expect(pathOf(page)).toBe(seasonPath);

  await page.goBack();
  await page.goBack();
  await expect(card).toBeFocused();
  expect(pathOf(page)).toBe('/nas');
  await page.locator('[data-testid="title-shelf"][data-shelf="movie"]').click();
  await expect(page.getByTestId('title-card')).toHaveCount(1);
  expect(pathOf(page)).toBe('/nas?shelf=movie');

  // A search reaches the address bar once typing pauses, and a reload shows it.
  await page.getByTestId('title-search').fill('moonlit');
  await expect.poll(() => pathOf(page)).toBe('/nas?shelf=movie&q=moonlit');
  await page.reload();
  await expect(page.getByTestId('title-search')).toHaveValue('moonlit', { timeout: 15_000 });
  await expect(page.getByTestId('title-row')).toHaveAttribute('data-name', 'Moonlit Harbor');

  // Back within the typing delay: the pending search write must not overwrite the entry Back landed on.
  await page.getByTestId('title-search').fill('zzz');
  await page.goBack();
  await expect.poll(() => pathOf(page)).toBe('/nas');
  await page.waitForTimeout(1000);
  expect(pathOf(page)).toBe('/nas');
});

test('a library path opens straight onto its screen after a reload', async ({ page, browserName }) => {
  await openTitles(page, browserName);
  await page.locator('[data-testid="title-card"][data-name="Starfall Wanderer"]').click();
  await page.locator('[data-testid="season-row"][data-label="Season 1"]').click();
  await expect(page.getByTestId('season-screen')).toBeVisible();
  const seasonPath = pathOf(page);
  // Notes whether the library's own screen (its search field) ever shows during the reload.
  await page.addInitScript(() => {
    const w = window as unknown as { __librarySeen: boolean };
    w.__librarySeen = false;
    new MutationObserver(() => {
      if (document.querySelector('[data-testid="title-search"]')) w.__librarySeen = true;
    }).observe(document, { childList: true, subtree: true });
  });
  await page.reload();
  await expect(page.getByTestId('season-screen').locator('h2')).toHaveText('Season 1', { timeout: 15_000 });
  expect(pathOf(page)).toBe(seasonPath);
  expect(await page.evaluate(() => (window as unknown as { __librarySeen: boolean }).__librarySeen)).toBe(false);
  // In-app Back from a screen opened by a reload (no app entry behind it) goes to its parent in place.
  await page.getByRole('button', { name: 'Back to Starfall Wanderer' }).click();
  await expect(page.getByTestId('series-screen')).toBeVisible();
  expect(pathOf(page)).toBe(seasonPath.slice(0, seasonPath.lastIndexOf('/season/')));
});

test('the folder browser has its folder in the address bar', async ({ page, browserName }) => {
  await openLibrary(page, browserName);
  expect(pathOf(page)).toBe('/nas/folders');
  await page.locator('[data-testid="nas-folder"][data-name="Anime"]').click();
  await expect(page.getByTestId('nas-crumbs')).toHaveText('NAS › syn › Anime');
  expect(pathOf(page)).toBe('/nas/folders/syn/Anime');
  await expect(page.locator('[data-testid="nas-folder"][data-name^="Starfall Wanderer"]')).toBeVisible();
  const folders = await page.getByTestId('nas-folder').allTextContents();
  await page.reload();
  await expect(page.getByTestId('nas-crumbs')).toHaveText('NAS › syn › Anime', { timeout: 15_000 });
  await expect(page.getByTestId('nas-folder')).toHaveText(folders);
  await page.goBack();
  await expect(page.getByTestId('nas-crumbs')).toHaveText('NAS');
  expect(pathOf(page)).toBe('/nas/folders');
});

/** A 1×1 PNG, standing in for posters where a test must not reach the NAS for them. */
const ONE_PIXEL_PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=', 'base64');

test('a device unpaired while on a NAS path goes back to the landing page', async ({ page, browserName }) => {
  // Posters load in the background and can still be in flight when the device is revoked: one answered 401 fails to load,
  // and the poster's retry opens a new session, which finds the device gone before the click does. They are answered
  // here (with the NAS's CORP header, as the page is cross-origin isolated), so the click is the first to reach the NAS.
  await page.route('**/api/art/**', (route) =>
    route.fulfill({ status: 200, contentType: 'image/png', headers: { 'Cross-Origin-Resource-Policy': 'cross-origin' }, body: ONE_PIXEL_PNG }),
  );
  await libraryReady();
  await allowLocalNetwork(page, browserName);
  const redeemed = page.waitForResponse((r) => r.url().endsWith('/api/pair/redeem') && r.request().method() === 'POST');
  await pairByLink(page);
  const { deviceId } = (await (await redeemed).json()) as { deviceId: string };
  // Continue watching asks for its places once the titles are shown; it must be answered before the device is revoked,
  // or that request, not the click, finds the device gone.
  const places = page.waitForResponse((r) => new URL(r.url()).pathname.endsWith('/api/me/playback') && r.request().method() === 'GET');
  await page.getByTestId('nas-open').click();
  await expect(page.getByTestId('title-library')).toBeVisible({ timeout: 15_000 });
  expect(pathOf(page)).toBe('/nas');

  // The library's own requests are answered before the device is revoked, so the click is what finds it revoked.
  const card = page.locator('[data-testid="title-card"][data-name="Starfall Wanderer"]');
  await expect(card).toBeVisible();
  expect((await places).status()).toBe(200);
  const res = await ownerApi(`admin/devices/${encodeURIComponent(deviceId)}`, { method: 'DELETE' });
  expect(res.status).toBe(204);
  await card.click();
  await expect(page.getByTestId('error')).toHaveText('This device is no longer paired with the NAS.');
  await expect(page.getByTestId('pair-screen')).toBeVisible();
  expect(pathOf(page)).toBe('/');
  await page.reload();
  await expect(page.getByTestId('pair-screen')).toBeVisible({ timeout: 15_000 });
  expect(pathOf(page)).toBe('/');
  await expect(page.getByTestId('title-library')).toHaveCount(0);
});

/** The `f.` link key of disc1 (and its copies), as the app works it out from a manifest (whose paths are upper-case). */
function disc1Key(): string {
  return syntheticDiscKey('disc1');
}

/** The `f.` link key of a synthetic disc, worked out as `disc1Key` is. */
function syntheticDiscKey(name: string): string {
  const dir = join(REPO_ROOT, 'fixtures/synthetic', name, 'BDMV/STREAM');
  const files = readdirSync(dir).map((name) => ({ path: `BDMV/STREAM/${name.toUpperCase()}`, size: statSync(join(dir, name)).size }));
  const key = discKeyOf('0000000000000000', files);
  expect(key).toMatch(/^f\.[0-9A-F]{32}$/);
  return key;
}

/** The name of the disc a key opens (the copy the NAS picks). */
async function resolvedName(key: string): Promise<string> {
  const res = await ownerApi(`discs/resolve/${encodeURIComponent(key)}`);
  expect(res.status).toBe(200);
  return ((await res.json()) as { disc: { name: string } }).disc.name;
}

const waitForPlaying = (page: Page): Promise<unknown> =>
  page.waitForFunction(() => document.querySelector('[data-testid="player"]')?.getAttribute('data-state') === 'playing', undefined, { polling: 'raf', timeout: 15_000 });

/** The address bar's play route: its path, playlist and time. */
const playLinkOf = (page: Page): { path: string; pl: string | null; t: number | null } => {
  const url = new URL(page.url());
  const t = url.searchParams.get('t');
  return { path: url.pathname, pl: url.searchParams.get('pl'), t: t === null ? null : Number(t) };
};

test('playing a NAS episode keeps a play link in the address bar', async ({ page, browserName }) => {
  await openTitles(page, browserName);
  await skipWithoutH264(page);
  await page.locator('[data-testid="title-card"][data-name="Starfall Wanderer"]').click();
  await page.locator('[data-testid="season-row"][data-label="Season 1"]').click();
  await page.locator('[data-testid="episode-row"][data-number="1"]').click();
  await page.getByTestId('nas-play').click();
  await waitForPlaying(page);
  // The episode is 4 s long (the fixture's), so the time is checked on a pause, which writes it at once.
  await expect.poll(() => playLinkOf(page).pl).toBe('00001');
  expect(playLinkOf(page).path).toMatch(/^\/nas\/play\/f\.[0-9A-F]{32}$/);
  expect(playLinkOf(page).path).toBe(`/nas/play/${disc1Key()}`);
  await expect.poll(async () => (await telemetry(page))?.clockUs ?? 0, { timeout: 10_000 }).toBeGreaterThanOrEqual(2_000_000);
  await page.getByTestId('video-canvas').click();
  await expect(playerState(page)).toHaveAttribute('data-state', 'paused');
  await expect.poll(() => playLinkOf(page).t ?? -1).toBeGreaterThanOrEqual(2);
  expect(playLinkOf(page).pl).toBe('00001');
});

test('watching a NAS episode saves its place on the NAS', async ({ page, browserName }) => {
  await openTitles(page, browserName, '&placemin=1');
  await skipWithoutH264(page);
  const key = disc1Key();
  await ownerApi(`me/playback/${encodeURIComponent(key)}`, { method: 'DELETE' });
  await page.locator('[data-testid="title-card"][data-name="Starfall Wanderer"]').click();
  await page.locator('[data-testid="season-row"][data-label="Season 1"]').click();
  await page.locator('[data-testid="episode-row"][data-number="1"]').click();
  await page.getByTestId('nas-play').click();
  await waitForPlaying(page);
  await expect.poll(async () => (await telemetry(page))?.clockUs ?? 0, { timeout: 10_000 }).toBeGreaterThanOrEqual(2_000_000);
  await page.getByTestId('video-canvas').click(); // a pause saves at once
  await expect(playerState(page)).toHaveAttribute('data-state', 'paused');
  const place = async (): Promise<{ timeUs: number; deviceName: string; playlistId: string } | null> => {
    const res = await ownerApi(`me/playback/${encodeURIComponent(key)}`);
    if (res.status === 404) return null;
    return ((await res.json()) as { places: Record<string, { timeUs: number; deviceName: string; playlistId: string }> }).places['00001'] ?? null;
  };
  await expect.poll(async () => (await place())?.timeUs ?? 0, { timeout: 5_000 }).toBeGreaterThanOrEqual(2_000_000);
  expect(await place()).toMatchObject({ playlistId: '00001', deviceName: expect.any(String) });
  await ownerApi(`me/playback/${encodeURIComponent(key)}`, { method: 'DELETE' });
});

// Resume (spec 2026-10-20 §6). Places are per person: each browser's project plays as its own owner person, so the
// other tests' places (every episode launch makes one for the project's owner person) never show in these.

const RESUME_COPY = 'This disc has changed since you stopped.';
const personSessions = new Map<string, Promise<string>>();

/** A NAS API route as a device of `person` (an owner person, made when there is none). */
async function personApi(person: string, path: string, init: RequestInit = {}): Promise<Response> {
  let session = personSessions.get(person);
  if (!session) personSessions.set(person, (session = sessionFor(ownerCode(person))));
  const headers = new Headers(init.headers);
  headers.set('Authorization', `Bearer ${await session}`);
  return fetch(`${NAS_API}${path}`, { ...init, headers });
}

/** A place as the app saves one: direct playback of `playlistId` at `timeUs`. */
function placeBody(discKey: string, discId: string, playlistId: string, timeUs: number, durationUs: number, updatedAt = Date.now()): unknown {
  return {
    discKey, discId, playlistId, timeUs, durationUs, finished: false, mode: 'none', title: null, psrs: [], gprs: null,
    settings: { audioLanguage: null, pgLanguage: null, textFiles: [], psr1: 1, psr2: 0, psr3: 1, textOn: false, textScale: 1, shaderSet: null, volume: 1, muted: false },
    updatedAt, deviceName: 'Test Tablet',
  };
}

/** Stores a place for `person` through the API, as another of its devices would. */
async function putPlace(api: (path: string, init?: RequestInit) => Promise<Response>, discKey: string, playlistId: string, timeUs: number, durationUs: number): Promise<void> {
  const resolved = await api(`discs/resolve/${encodeURIComponent(discKey)}`);
  expect(resolved.status).toBe(200);
  const { disc } = (await resolved.json()) as { disc: { id: string } };
  const res = await api(`me/playback/${encodeURIComponent(discKey)}/${playlistId}`, {
    method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(placeBody(discKey, disc.id, playlistId, timeUs, durationUs)),
  });
  expect(res.status).toBe(204);
}

const resumePerson = (browserName: string): string => `Resume Viewer ${browserName}`;

/** Pairs as this project's resume person with no places on disc1, and opens the title library. */
async function openTitlesAsResumePerson(page: Page, browserName: string): Promise<(path: string, init?: RequestInit) => Promise<Response>> {
  const person = resumePerson(browserName);
  const api = (path: string, init?: RequestInit): Promise<Response> => personApi(person, path, init);
  expect((await api(`me/playback/${encodeURIComponent(disc1Key())}`, { method: 'DELETE' })).status).toBe(204);
  await openTitles(page, browserName, '&placemin=1', ownerCode(person));
  return api;
}

async function openEpisode1(page: Page): Promise<void> {
  await page.locator('[data-testid="title-card"][data-name="Starfall Wanderer"]').click();
  await page.locator('[data-testid="season-row"][data-label="Season 1"]').click();
  await page.locator('[data-testid="episode-row"][data-number="1"]').click();
  await expect(page.getByTestId('nas-preflight')).toBeVisible();
}

const clockUs = async (page: Page): Promise<number> => (await telemetry(page))?.clockUs ?? 0;

/** Whether the person's place for disc1's `playlistId` is finished (null: none). */
async function finishedOn(api: (path: string, init?: RequestInit) => Promise<Response>, playlistId: string): Promise<boolean | null> {
  const res = await api(`me/playback/${encodeURIComponent(disc1Key())}`);
  return res.status === 200 ? ((await res.json()) as { places: Record<string, { finished: boolean }> }).places[playlistId]?.finished ?? null : null;
}

async function placeTimeUs(api: (path: string, init?: RequestInit) => Promise<Response>, playlistId: string): Promise<number | null> {
  const res = await api(`me/playback/${encodeURIComponent(disc1Key())}`);
  return res.status === 200 ? ((await res.json()) as { places: Record<string, { timeUs: number }> }).places[playlistId]?.timeUs ?? null : null;
}

test('reopening a NAS episode offers to resume it', async ({ page, browserName }) => {
  const api = await openTitlesAsResumePerson(page, browserName);
  await skipWithoutH264(page);
  await openEpisode1(page);
  await expect(page.getByTestId('resume-prompt')).toHaveCount(0);
  await page.getByTestId('nas-play').click();
  await waitForPlaying(page);
  // well clear of the short place (0.2 s) and of finished (95%, 3.8 s), however late the pause lands on a slow runner
  await expect.poll(() => clockUs(page), { timeout: 10_000, intervals: [50] }).toBeGreaterThanOrEqual(1_500_000);
  await page.getByTestId('video-canvas').click(); // a pause saves at once
  await expect(playerState(page)).toHaveAttribute('data-state', 'paused');
  await page.goBack();
  await expect(page.getByTestId('season-screen')).toBeVisible({ timeout: 15_000 });

  // the label follows the place the pause saved (telemetry's clock can lag the snapshot it was saved from)
  await expect.poll(() => placeTimeUs(api, '00001'), { timeout: 5_000 }).toBeGreaterThanOrEqual(1_500_000);
  const pausedS = Math.floor((await placeTimeUs(api, '00001'))! / 1_000_000);
  await page.locator('[data-testid="episode-row"][data-number="1"]').click();
  const prompt = page.getByTestId('resume-prompt');
  await expect(prompt).toContainText('Pick up where you left off?', { timeout: 10_000 });
  await expect(page.getByTestId('resume-at')).toHaveText(`Resume at 0:0${pausedS}`);
  await expect(page.getByTestId('nas-play')).toHaveCount(0);
  await page.getByTestId('resume-at').click();
  await expect(playerState(page)).toHaveAttribute('data-playlist', '00001', { timeout: 15_000 });
  await expect.poll(() => clockUs(page), { timeout: 1_000, intervals: [50] }).toBeGreaterThanOrEqual(pausedS * 1_000_000);
  // The 4 s episode plays to its end, which finishes its place: another device stops at 0:03 again.
  await expect(playerState(page)).toHaveAttribute('data-state', 'ended', { timeout: 10_000 });
  await page.goBack();
  await expect(page.getByTestId('season-screen')).toBeVisible({ timeout: 15_000 });
  await expect.poll(() => finishedOn(api, '00001'), { timeout: 5_000 }).toBe(true);
  await putPlace(api, disc1Key(), '00001', 3_000_000, 4_000_000);

  await page.locator('[data-testid="episode-row"][data-number="1"]').click();
  await page.getByTestId('resume-start-over').click({ timeout: 10_000 });
  await waitForPlaying(page);
  await expect(playerState(page)).toHaveAttribute('data-playlist', '00001');
  expect(await clockUs(page)).toBeLessThan(1_000_000);
});

test('Continue watching shows the episode and resumes it without asking', async ({ page, browserName }) => {
  const api = await openTitlesAsResumePerson(page, browserName);
  await skipWithoutH264(page);
  await putPlace(api, disc1Key(), '00001', 3_000_000, 4_000_000);
  await page.goto('/nas?telemetry=1&placemin=1');
  await expect(page.getByTestId('title-library')).toBeVisible({ timeout: 15_000 });
  const card = page.locator('[data-testid="continue-card"][data-playlist="00001"]');
  await expect(card).toHaveCount(1, { timeout: 10_000 });
  await expect(card).toHaveAttribute('data-kind', 'resume');
  await expect(card).toContainText('Starfall Wanderer');
  await expect(card).toContainText('S1 · Episode 1');
  await card.click();
  await expect(page.getByTestId('resume-at')).toHaveText('Resume at 0:03', { timeout: 15_000 });
  // no question: the one way on is Resume (and Back)
  await expect(page.getByTestId('resume-start-over')).toHaveCount(0);
  await expect(page.getByTestId('nas-play')).toHaveCount(0);
  await page.getByTestId('resume-at').click();
  await expect(playerState(page)).toHaveAttribute('data-playlist', '00001', { timeout: 15_000 });
  await expect.poll(() => clockUs(page), { timeout: 1_000, intervals: [50] }).toBeGreaterThanOrEqual(3_000_000);
});

test('a finished episode leaves Continue watching', async ({ page, browserName }) => {
  const api = await openTitlesAsResumePerson(page, browserName);
  await skipWithoutH264(page);
  await putPlace(api, disc1Key(), '00001', 1_000_000, 4_000_000);
  await page.goto('/nas?telemetry=1&placemin=1');
  await expect(page.locator('[data-testid="continue-card"][data-playlist="00001"]')).toHaveCount(1, { timeout: 15_000 });
  await openEpisode1(page);
  await page.getByTestId('resume-start-over').click({ timeout: 10_000 });
  await waitForPlaying(page);
  await expect(playerState(page)).toHaveAttribute('data-state', 'ended', { timeout: 15_000 });
  await expect.poll(() => finishedOn(api, '00001'), { timeout: 5_000 }).toBe(true);
  await page.goto('/nas');
  await expect(page.getByTestId('title-library')).toBeVisible({ timeout: 15_000 });
  await expect(page.getByTestId('title-card').first()).toBeVisible();
  await expect(page.locator('[data-testid="continue-card"][data-playlist="00001"]')).toHaveCount(0);
  await openEpisode1(page);
  await expect(page.getByTestId('nas-play')).toBeEnabled({ timeout: 10_000 });
  await expect(page.getByTestId('resume-prompt')).toHaveCount(0);
});

test('a place on a disc that changed offers only Start from beginning', async ({ page, browserName }) => {
  const api = await openTitlesAsResumePerson(page, browserName);
  // a playlist the disc doesn't have (Review Focus 2)
  await putPlace(api, disc1Key(), '00042', 120_000_000, 600_000_000);
  await page.goto(`/nas/play/${disc1Key()}`);
  await expect(page.getByTestId('resume-prompt')).toContainText(RESUME_COPY, { timeout: 15_000 });
  await expect(page.getByTestId('resume-at')).toHaveCount(0);
  await expect(page.getByTestId('resume-start-over')).toBeVisible();
  expect((await api(`me/playback/${encodeURIComponent(disc1Key())}`, { method: 'DELETE' })).status).toBe(204);
});

test('a pre-flight whose places request hangs offers Play after a few seconds', async ({ page, browserName }) => {
  await openTitlesAsResumePerson(page, browserName);
  // the disc's places never answer (a stalled WebRTC route, say)
  await page.route(/\/api\/me\/playback\/[^/?]+(\?.*)?$/, () => {});
  await openEpisode1(page);
  await expect(page.getByTestId('nas-play')).toBeEnabled({ timeout: 8_000 });
  await expect(page.getByTestId('resume-prompt')).toHaveCount(0);
});

test('an owner and a guest each see only their own Continue watching', async ({ page, browser, browserName }) => {
  // Review Focus 5: the owner's place is on episode 1's playlist, the guest's on disc1's other one.
  const api = await openTitlesAsResumePerson(page, browserName);
  await putPlace(api, disc1Key(), '00001', 2_000_000, 4_000_000);
  const minted = await ownerApi('admin/codes', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ newPerson: { name: `Resume Guest ${browserName}`, owner: false }, invite: true }),
  });
  expect(minted.status).toBe(200);
  const { code, personId } = (await minted.json()) as { code: string; personId: string };
  const second = await ownerApi('admin/codes', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ personId }) });
  expect(second.status).toBe(200);
  const guestToken = sessionFor(((await second.json()) as { code: string }).code);
  const guestApi = async (path: string, init: RequestInit = {}): Promise<Response> => {
    const headers = new Headers(init.headers);
    headers.set('Authorization', `Bearer ${await guestToken}`);
    return fetch(`${NAS_API}${path}`, { ...init, headers });
  };
  await putPlace(guestApi, disc1Key(), '00000', 2_000_000, 8_000_000);
  const guestContext = await browser.newContext();
  try {
    const guest = await guestContext.newPage();
    await allowLocalNetwork(guest, browserName);
    await guest.goto('/');
    await guest.getByTestId('pair-code').fill(code);
    await guest.getByTestId('pair-button').click();
    await expect(guest.getByTestId('nas-paired')).toBeVisible({ timeout: 25_000 });
    await exclusivelyAsync('gate', async () => {
      try {
        await setGate('everyone');
        await guest.getByTestId('nas-open').click();
        await expect(guest.getByTestId('title-library')).toBeVisible({ timeout: 15_000 });
        await expect(guest.getByTestId('continue-card')).toHaveCount(1, { timeout: 10_000 });
        await expect(guest.getByTestId('continue-card')).toHaveAttribute('data-playlist', '00000');
        await page.reload();
        await expect(page.getByTestId('title-library')).toBeVisible({ timeout: 15_000 });
        await expect(page.getByTestId('continue-card')).toHaveCount(1, { timeout: 10_000 });
        await expect(page.getByTestId('continue-card')).toHaveAttribute('data-playlist', '00001');
      } finally {
        await setGate('owners');
      }
    });
  } finally {
    await guestContext.close();
    await ownerApi(`admin/people/${encodeURIComponent(personId)}`, { method: 'DELETE' });
  }
});

test('a play link opens the pre-flight, then plays from its time', async ({ page, browserName }) => {
  await openTitles(page, browserName);
  await skipWithoutH264(page);
  const key = disc1Key();
  await page.goto(`/nas/play/${key}?pl=00000&t=5&telemetry=1`);
  await expect(page.getByTestId('nas-preflight').locator('h3')).toHaveText(await resolvedName(key), { timeout: 15_000 });
  await page.getByTestId('nas-play').click();
  await waitForPlaying(page);
  await expect(playerState(page)).toHaveAttribute('data-playlist', '00000');
  // 5 s into the 8 s playlist within 2 s of playing: only the link's seek gets there that soon.
  await expect.poll(async () => (await telemetry(page))?.clockUs ?? 0, { timeout: 2_000, intervals: [100] }).toBeGreaterThanOrEqual(5_000_000);
  // The link's time stays in the address bar while the playlist starts, then the seek writes it.
  expect(playLinkOf(page).t).toBeGreaterThanOrEqual(5);

  // Paused a little later, the address bar has the time; a reload lands on the pre-flight with it, not on playback.
  await expect.poll(async () => (await telemetry(page))?.clockUs ?? 0, { timeout: 5_000 }).toBeGreaterThanOrEqual(6_000_000);
  await page.getByTestId('video-canvas').click();
  await expect(playerState(page)).toHaveAttribute('data-state', 'paused');
  await expect.poll(() => playLinkOf(page).t ?? -1).toBeGreaterThanOrEqual(6);
  const last = playLinkOf(page);
  expect(last).toMatchObject({ path: `/nas/play/${key}`, pl: '00000' });
  await page.reload();
  await expect(page.getByTestId('nas-preflight')).toBeVisible({ timeout: 15_000 });
  await expect(playerState(page)).toHaveCount(0);
  expect(playLinkOf(page)).toEqual(last);
});

test('Back during NAS playback closes the disc and returns to the season', async ({ page, browserName }) => {
  await openTitles(page, browserName);
  await skipWithoutH264(page, { realtime: false });
  await page.locator('[data-testid="title-card"][data-name="Starfall Wanderer"]').click();
  await page.locator('[data-testid="season-row"][data-label="Season 1"]').click();
  await expect(page.getByTestId('season-screen')).toBeVisible();
  const seasonPath = pathOf(page);
  await page.locator('[data-testid="episode-row"][data-number="1"]').click();
  await page.getByTestId('nas-play').click();
  await waitForPlaying(page);
  await page.goBack();
  await expect(page.getByTestId('season-screen')).toBeVisible({ timeout: 15_000 });
  await expect(playerState(page)).toHaveCount(0);
  expect(pathOf(page)).toBe(seasonPath);

  // A link opened cold has no app entry behind it: the player's close lands on the library, still in the app.
  await page.goto(`/nas/play/${disc1Key()}?pl=00000`);
  await page.getByTestId('nas-play').click({ timeout: 15_000 });
  await waitForPlaying(page);
  await page.getByRole('button', { name: 'Playlists' }).click();
  await page.getByRole('button', { name: 'Open another disc' }).click();
  await expect(page.getByTestId('title-library')).toBeVisible({ timeout: 15_000 });
  await expect(playerState(page)).toHaveCount(0);
  expect(pathOf(page)).toBe('/nas');
});

test("Back while a play link's disc opens closes it, and the screen Back went to stays", async ({ page, context, browserName }) => {
  await openTitles(page, browserName);
  await skipWithoutH264(page, { realtime: false });
  await page.locator('[data-testid="title-card"][data-name="Starfall Wanderer"]').click();
  await page.locator('[data-testid="season-row"][data-label="Season 1"]').click();
  await expect(page.getByTestId('season-screen')).toBeVisible();
  const seasonPath = pathOf(page);
  await page.locator('[data-testid="episode-row"][data-number="1"]').click();
  await page.getByTestId('nas-play').click();
  await waitForPlaying(page);
  await page.goBack();
  await expect(page.getByTestId('season-screen')).toBeVisible({ timeout: 15_000 });
  // Forward onto the play link: its own pre-flight, in the same page.
  await page.goForward();
  await expect(page.getByTestId('nas-play-link')).toBeVisible({ timeout: 15_000 });
  // The disc's reads are held, so the open is still in flight when Back comes.
  const held: Route[] = [];
  await context.route(/\/api\/discs\/[^/]+\/files\//, (route) => void held.push(route));
  // the episode's place (saved as Back closed it) is offered, unless it is too near the start: either opens the disc
  await page.getByTestId('resume-at').or(page.getByTestId('nas-play')).click();
  await expect(page.getByText('Reading disc…')).toBeVisible();
  await expect.poll(() => held.length).toBeGreaterThan(0);
  await page.goBack();
  await expect(page.getByTestId('season-screen')).toBeVisible({ timeout: 15_000 });
  expect(pathOf(page)).toBe(seasonPath);
  await context.unroute(/\/api\/discs\/[^/]+\/files\//);
  for (const route of held) await route.continue().catch(() => {});
  // Nothing comes of the abandoned open, and the address bar stays where Back went.
  await page.waitForTimeout(3000);
  await expect(playerState(page)).toHaveCount(0);
  await expect(page.getByTestId('season-screen')).toBeVisible();
  expect(pathOf(page)).toBe(seasonPath);
});

test('a play link starts at its time even when First Play plays something first', async ({ page, browserName }) => {
  await openTitles(page, browserName);
  await skipWithoutH264(page);
  // disc-menu's First Play runs its top menu (playlist 00001); the link names the feature, 00000.
  await page.goto(`/nas/play/${syntheticDiscKey('disc-menu')}?pl=00000&t=2&telemetry=1`);
  await page.getByTestId('nas-play').click({ timeout: 15_000 });
  await waitForPlaying(page);
  await expect(playerState(page)).toHaveAttribute('data-playlist', '00000');
  await expect.poll(async () => (await telemetry(page))?.clockUs ?? 0, { timeout: 1_000, intervals: [100] }).toBeGreaterThanOrEqual(2_000_000);
  await expect(playerState(page)).toHaveAttribute('data-playlist', '00000');
});

test('a play link with a bad time or playlist opens the disc without seeking', async ({ page, browserName }) => {
  await openTitles(page, browserName);
  await skipWithoutH264(page);
  const key = disc1Key();
  for (const t of ['-5', '99999']) {
    await page.goto(`/nas/play/${key}?pl=00000&t=${t}&telemetry=1`);
    await page.getByTestId('nas-play').click({ timeout: 15_000 });
    await waitForPlaying(page);
    await expect(playerState(page)).toHaveAttribute('data-playlist', '00000');
    // Playing from the start: well short of any seek once it has played a moment.
    await expect.poll(async () => (await telemetry(page))?.clockUs ?? 0, { timeout: 5_000 }).toBeGreaterThan(500_000);
    expect((await telemetry(page))!.clockUs).toBeLessThan(2_500_000);
  }
  await page.goto(`/nas/play/${key}?pl=99999`);
  await page.getByTestId('nas-play').click({ timeout: 15_000 });
  await expect(page.getByTestId('playlist-00000')).toBeVisible({ timeout: 15_000 });
  await expect(page.getByText("This episode isn't on this disc; it opened normally.")).toBeVisible();
});

// The owner screens. Each browser files its own discs (nas-server.ts `ownerDiscs`); the tests that change the catalogue
// hold the 'catalogue' lock and put it back as it was, so the browse test's shelf counts hold.

type Project = (typeof PROJECTS)[number];
const projectOf = (name: string): Project => name as Project;
const lastSegment = (folder: string): string => folder.slice(folder.lastIndexOf('/') + 1);
const shelfChip = (page: Page, id: string) => page.locator(`[data-testid="title-shelf"][data-shelf="${id}"]`);
const unsortedCard = (page: Page, folder: string) => page.locator(`[data-testid="unsorted-card"][data-folder="${folder}"]`);
const artistTile = (page: Page, name: string) => page.locator(`[data-testid="artist-tile"][data-name="${name}"]`);
const musicRelease = (page: Page, name: string) => page.locator(`[data-testid="music-release"][data-name="${name}"]`);
/** An owner disc marked as Music is a release whose artist is its parent folder (the project's name for the stray disc). */
async function openArtist(page: Page, artist: string): Promise<void> {
  await artistTile(page, artist).click();
  await expect(page.getByTestId('artist-name')).toHaveText(artist);
}

/** Opens the title library, then Unsorted. */
async function openUnsorted(page: Page, browserName: string): Promise<void> {
  await openTitles(page, browserName);
  await shelfChip(page, 'unsorted').click();
  await expect(page.getByTestId('unsorted-screen')).toBeVisible();
}

/** Clears discs' owner choices through the API, as they were before the test. */
async function clearChoices(discIds: readonly (string | null)[]): Promise<void> {
  for (const id of discIds) if (id !== null) await ownerApi(`admin/discs/${encodeURIComponent(id)}/choice`, { method: 'DELETE' });
}

test('Unsorted files a disc under a suggestion, then the other discs of its folder', async ({ page, browserName }, testInfo) => {
  const project = projectOf(testInfo.project.name);
  const name = OWNER_SERIES[project];
  const [first, second] = ownerDiscs(project).series.map(lastSegment) as [string, string];
  await exclusivelyAsync('catalogue', async () => {
    const ids: (string | null)[] = [];
    try {
      await openUnsorted(page, browserName);
      const card = unsortedCard(page, first);
      ids.push(await card.getAttribute('data-disc-id'), await unsortedCard(page, second).getAttribute('data-disc-id'));
      await expect(card.getByTestId('unsorted-reason')).toHaveText('Why unsure: No disc number');
      await expect(card).toContainText(`Owner/${project}/${name}`);
      const lookUp = card.getByTestId('unsorted-bluray-com');
      await expect(lookUp).toHaveText('Look up ZMXA-1101 on Blu-ray.com');
      await expect(lookUp).toHaveAttribute('href', 'https://www.blu-ray.com/search/?quicksearch=1&quicksearch_keyword=ZMXA-1101&section=bluraymovies');
      await expect(lookUp).toHaveAttribute('target', '_blank');

      await card.locator(`[data-testid="title-option"][data-name="${name}"]`).click();
      await expect(card.getByTestId('unsorted-season')).toHaveValue('1');
      await card.getByTestId('unsorted-disc').fill('1');
      await card.getByTestId('unsorted-file').click();
      const notice = page.getByTestId('unsorted-notice');
      await expect(notice).toContainText(`Filed under ${name}.`);
      await expect(notice).toBeFocused();
      await expect(page.getByTestId('unsorted-apply-disc')).toHaveValue('1');
      await expect(unsortedCard(page, first)).toHaveCount(0);
      await page.getByTestId('unsorted-apply').filter({ hasText: 'Apply to the other 1 disc in this folder' }).click();
      await expect(notice).toContainText('Filed 1 more disc from this folder.');
      await expect(unsortedCard(page, second)).toHaveCount(0);

      // Back in the library, the series holds both discs.
      await page.getByRole('button', { name: 'Back to the library' }).click();
      await page.locator(`[data-testid="title-card"][data-name="${name}"]`).click();
      await expect(page.getByTestId('series-name')).toHaveText(name);
      await page.getByTestId('season-row').first().click();
      await expect(page.getByTestId('season-screen')).toBeVisible();
      // the Discs tab, when the season has an Episodes tab too
      const discsTab = page.locator('[data-testid="season-tab"][data-tab="discs"]');
      if ((await discsTab.count()) > 0) await discsTab.click();
      await expect(page.getByTestId('disc-card')).toHaveText([/^Disc 1/, /^Disc 2/]);
    } finally {
      await clearChoices(ids);
    }
  });
});

test('an owner files a disc differently from its season, into Music, and out of the library from the Music shelf', async ({ page, browserName }, testInfo) => {
  const project = projectOf(testInfo.project.name);
  const name = OWNER_SERIES[project];
  const [first] = ownerDiscs(project).series.map(lastSegment) as [string, string];
  await exclusivelyAsync('catalogue', async () => {
    let id: string | null = null;
    try {
      // File the series' first disc from Unsorted: Season starts at the suggestion's season (ruling F2).
      await openUnsorted(page, browserName);
      const card = unsortedCard(page, first);
      id = await card.getAttribute('data-disc-id');
      await card.locator(`[data-testid="title-option"][data-name="${name}"]`).click();
      await expect(card.getByTestId('unsorted-season')).toHaveValue('1');
      await card.getByTestId('unsorted-disc').fill('1');
      await card.getByTestId('unsorted-file').click();
      await expect(page.getByTestId('unsorted-notice')).toContainText(`Filed under ${name}.`);
      await page.getByRole('button', { name: 'Back to the library' }).click();

      // From the season, "File differently…" moves it to Music; the series, now empty, is gone (the release, found by its
      // folder's title, has the series' name).
      const seriesCard = page.locator(`[data-testid="title-card"][data-name="${name}"]`);
      const seriesId = (await seriesCard.getAttribute('data-title-id'))!;
      await seriesCard.click();
      await page.getByTestId('season-row').first().click();
      const discsTab = page.locator('[data-testid="season-tab"][data-tab="discs"]');
      if ((await discsTab.count()) > 0) await discsTab.click();
      const discCard = page.getByTestId('disc-card');
      await expect(discCard).toHaveCount(1);
      await discCard.getByTestId('disc-refile').click();
      await discCard.getByTestId('unsorted-card').getByTestId('unsorted-music').click();
      await expect(page.getByRole('heading', { name: 'Library' })).toBeVisible();
      await expect(page.locator(`[data-testid="title-card"][data-title-id="${seriesId}"]`)).toHaveCount(0);

      // On the Music shelf, "File differently…" and "Don't list" take it out of the library: the release is under its
      // folder's artist, the series' folder; its only release gone, the artist page goes back to the shelf.
      await shelfChip(page, 'music').click();
      await openArtist(page, name);
      const release = musicRelease(page, name);
      await expect(release).toBeVisible();
      await release.getByTestId('music-release-menu').click();
      await release.getByTestId('music-refile-open').click();
      await page.getByTestId('music-owner-panel').getByTestId('unsorted-card').getByTestId('unsorted-hide').click();
      await expect(page.getByTestId('artist-grid')).toBeVisible();
      await expect(artistTile(page, name)).toHaveCount(0);
      const hidden = (await (await ownerApi('admin/hidden')).json()) as { discs: { discId: string }[] };
      expect(hidden.discs.map((d) => d.discId)).toContain(id);

      // Filed under the series again, in the same visit: the series that went away opens again.
      await clearChoices([id]);
      await shelfChip(page, 'unsorted').click();
      const again = unsortedCard(page, first);
      await again.locator(`[data-testid="title-option"][data-name="${name}"]`).click();
      await again.getByTestId('unsorted-disc').fill('1');
      await again.getByTestId('unsorted-file').click();
      await expect(page.getByTestId('unsorted-notice')).toContainText(`Filed under ${name}.`);
      await page.getByRole('button', { name: 'Back to the library' }).click();
      await shelfChip(page, 'music').click(); // the Music shelf was picked: unpick it, back to the whole library
      await page.locator(`[data-testid="title-card"][data-name="${name}"]`).click();
      await expect(page.getByTestId('series-name')).toHaveText(name);
      await expect(page.getByTestId('season-row')).toHaveCount(1);
    } finally {
      await clearChoices([id]);
    }
  });
});

test("an owner files a bonus disc with a season's extras, then with the title's extras", async ({ page, browserName }, testInfo) => {
  const project = projectOf(testInfo.project.name);
  const name = OWNER_SERIES[project];
  const [first, second] = ownerDiscs(project).series.map(lastSegment) as [string, string];
  await exclusivelyAsync('catalogue', async () => {
    const ids: (string | null)[] = [];
    try {
      await openUnsorted(page, browserName);
      const card = unsortedCard(page, first);
      ids.push(await card.getAttribute('data-disc-id'), await unsortedCard(page, second).getAttribute('data-disc-id'));
      await card.locator(`[data-testid="title-option"][data-name="${name}"]`).click();
      await card.getByTestId('unsorted-disc').fill('1');
      await card.getByTestId('unsorted-file').click();
      await expect(page.getByTestId('unsorted-notice')).toContainText(`Filed under ${name}.`);

      // The other disc goes with season 1's extras: Disc / volume doesn't apply to extras.
      const bonus = unsortedCard(page, second);
      await bonus.locator(`[data-testid="title-option"][data-name="${name}"]`).click();
      await bonus.getByTestId('unsorted-extras').check();
      await expect(bonus.getByTestId('unsorted-disc')).toBeDisabled();
      await bonus.getByTestId('unsorted-season').fill('1');
      await bonus.getByTestId('unsorted-file').click();
      await expect(page.getByTestId('unsorted-notice')).toContainText(`Filed with the extras of season 1 of ${name}.`);

      await page.getByRole('button', { name: 'Back to the library' }).click();
      await page.locator(`[data-testid="title-card"][data-name="${name}"]`).click();
      await page.getByTestId('season-row').first().click();
      const discsTab = page.locator('[data-testid="season-tab"][data-tab="discs"]');
      if ((await discsTab.count()) > 0) await discsTab.click();
      await expect(page.getByRole('heading', { name: 'Extras' })).toBeVisible();
      const discCards = page.getByTestId('disc-card');
      await expect(discCards).toHaveCount(2);

      // "File differently…" on the extras disc, with Season blank, moves it to the title's own extras.
      const extrasCard = discCards.nth(1);
      await extrasCard.getByTestId('disc-refile').click();
      const refile = extrasCard.getByTestId('unsorted-card');
      await refile.getByTestId('unsorted-search').fill(name);
      await refile.getByTestId('unsorted-search-button').click();
      await refile.locator(`[data-testid="title-option"][data-name="${name}"]`).first().click();
      await refile.getByTestId('unsorted-extras').check();
      await refile.getByTestId('unsorted-season').fill('');
      await refile.getByTestId('unsorted-file').click();
      await expect(page.getByTestId('disc-card')).toHaveCount(1);
      await expect(page.getByRole('heading', { name: 'Extras' })).toHaveCount(0);
      await page.getByRole('button', { name: /^Back/ }).first().click();
      await expect(page.getByTestId('extras-row')).toContainText('1 disc');
    } finally {
      await clearChoices(ids);
    }
  });
});

test('"New title…" makes a Music title; "Don\'t list" hides a disc and Unhide brings it back', async ({ page, browserName }, testInfo) => {
  const project = projectOf(testInfo.project.name);
  const stray = ownerStray(project);
  await exclusivelyAsync('catalogue', async () => {
    let strayId: string | null = null;
    try {
      await openUnsorted(page, browserName);
      const card = unsortedCard(page, stray);
      strayId = await card.getAttribute('data-disc-id');
      await expect(card.getByTestId('unsorted-reason')).toHaveText('Why unsure: No title found');
      await card.getByRole('button', { name: 'New title…' }).click();
      const form = card.getByTestId('new-title-form');
      await form.getByRole('radio', { name: 'Music' }).check();
      await expect(form.getByTestId('new-title-seasons')).toHaveCount(0);
      await form.getByLabel('Name').fill('Live 2024');
      await form.getByTestId('new-title-create').click();
      await expect(card.getByTestId('new-title-created')).toContainText('Created “Live 2024”. File this disc under it?');
      await card.getByTestId('new-title-later').click();

      await page.getByRole('button', { name: 'Back to the library' }).click();
      // an own music title has no artist: it is under Various artists
      await shelfChip(page, 'music').click();
      await openArtist(page, 'Various artists');
      await expect(musicRelease(page, 'Live 2024')).toBeVisible();
      await page.getByRole('button', { name: 'Back to Music' }).click();
      await shelfChip(page, 'music').click();

      // Don't list, then Hidden and Unhide.
      await shelfChip(page, 'unsorted').click();
      await unsortedCard(page, stray).getByTestId('unsorted-hide').click();
      await expect(page.getByTestId('unsorted-notice')).toContainText('Not listed.');
      await expect(unsortedCard(page, stray)).toHaveCount(0);
      await page.getByTestId('open-hidden').click();
      const row = page.locator(`[data-testid="hidden-row"][data-folder="${stray}"]`);
      await expect(row).toBeVisible();
      await row.getByTestId('hidden-unhide').click();
      await expect(row).toHaveCount(0);
      // focus goes to the next row or the heading, not back to the top of the page
      await expect.poll(() => page.evaluate(() => document.activeElement?.closest('[data-testid="hidden-screen"]') !== null)).toBe(true);
      await page.getByRole('button', { name: 'Back to Unsorted' }).click();
      await expect(unsortedCard(page, stray)).toBeVisible();
    } finally {
      await clearChoices([strayId]);
      const own = (await (await ownerApi(`admin/lookup?q=${encodeURIComponent('Live 2024')}&source=own`)).json()) as { titles: { id: string }[] };
      for (const t of own.titles) await ownerApi(`admin/titles/${encodeURIComponent(t.id)}`, { method: 'DELETE' });
    }
  });
});

test('renaming a music title shows the new name on the Music shelf and in search', async ({ page, browserName }, testInfo) => {
  const project = projectOf(testInfo.project.name);
  const stray = ownerStray(project);
  await exclusivelyAsync('catalogue', async () => {
    let strayId: string | null = null;
    let musicId: string | null = null;
    try {
      await openUnsorted(page, browserName);
      const card = unsortedCard(page, stray);
      strayId = await card.getAttribute('data-disc-id');
      await card.getByTestId('unsorted-music').click();
      await expect(page.getByTestId('unsorted-notice')).toContainText('Marked as Music.');
      await page.getByRole('button', { name: 'Back to the library' }).click();
      await shelfChip(page, 'music').click();

      // The stray disc's artist is its parent folder, the project's.
      await openArtist(page, project);
      const release = musicRelease(page, stray);
      musicId = await release.getAttribute('data-title-id');
      await release.getByRole('button', { name: `Change ${stray}` }).click();
      await release.getByRole('menuitem', { name: 'Rename…' }).click();
      const form = page.getByTestId('music-rename-form');
      await form.getByLabel('Display name').fill('Reel Session');
      await form.getByTestId('music-save').click();
      const renamed = musicRelease(page, 'Reel Session');
      await expect(renamed).toBeVisible();
      await expect(renamed.getByTestId('music-release-menu')).toBeFocused();

      // The Music shelf's search finds the artist by the new name of its release.
      await page.getByRole('button', { name: 'Back to Music' }).click();
      await page.getByTestId('title-search').fill('reel session');
      await expect(page.getByTestId('artist-tile')).toHaveCount(1);
      await expect(page.getByTestId('artist-tile')).toHaveAttribute('data-name', project);
      await page.getByTestId('title-search').fill('');

      // "Use found name" takes the rename back.
      await openArtist(page, project);
      await renamed.getByTestId('music-release-menu').click();
      await renamed.getByTestId('music-rename').click();
      await page.getByTestId('music-rename-form').getByTestId('music-folder-name').click();
      await expect(musicRelease(page, stray)).toBeVisible();
    } finally {
      if (musicId !== null) await ownerApi(`admin/names/${encodeURIComponent(musicId)}`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: null }) });
      await clearChoices([strayId]);
    }
  });
});

test("the Music shelf shows artists and opens a release's pre-flight", async ({ page, browserName }) => {
  // Another browser's owner test moves this release for a while: the browsers take turns with it.
  await exclusivelyAsync('catalogue', async () => {
    await openTitles(page, browserName);
    await shelfChip(page, 'music').click();
    const tile = artistTile(page, 'Lantern Parade');
    await expect(tile.getByTestId('artist-count')).toHaveText('1 release');
    // the release folder's cover.png, in the tile's collage and on the card
    await expect(tile.locator('img')).toHaveCount(1);
    await expect(tile.locator('img')).toBeVisible();
    await tile.click();
    await expect(page.getByTestId('artist-page')).toBeVisible();
    await expect(page.getByTestId('artist-name')).toHaveText('Lantern Parade');
    await expect(page.getByTestId('artist-name')).toBeFocused();
    expect(pathOf(page)).toMatch(/^\/nas\/artist\/[^/]+$/);
    // the recorded release is a live one: Concerts, and no empty sections
    await expect(page.getByTestId('artist-section')).toHaveCount(1);
    const concerts = page.locator('[data-testid="artist-section"][data-section="concerts"]');
    await expect(concerts.getByRole('heading')).toHaveText('Concerts');
    const card = concerts.locator('[data-testid="music-release"][data-name="Night Lights Live 2024"]');
    await expect(card).toContainText('2024');
    await expect(card.locator('img')).toBeVisible();
    // one disc: its pre-flight
    await card.locator('button.title-card').click();
    await expect(page.getByTestId('nas-preflight')).toBeVisible();
    await page.goBack();
    await expect(page.getByTestId('artist-grid')).toBeVisible();
    await expect(tile).toBeFocused();
  });
});

test('on a phone the Music shelf and an artist page fit the screen', async ({ browser, browserName }) => {
  const phone = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, ...(browserName === 'firefox' ? {} : { isMobile: true }) });
  try {
    const page = await phone.newPage();
    await exclusivelyAsync('catalogue', async () => {
      await openTitles(page, browserName);
      await shelfChip(page, 'music').click();
      await expect(artistTile(page, 'Lantern Parade')).toBeVisible();
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      await openArtist(page, 'Lantern Parade');
      await expect(musicRelease(page, 'Night Lights Live 2024')).toBeVisible();
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    });
  } finally {
    await phone.close();
  }
});

test("an owner sets a release's artist and drops its match from the release's menu", async ({ page, browserName }) => {
  await exclusivelyAsync('catalogue', async () => {
    let id: string | null = null;
    try {
      await openTitles(page, browserName);
      await shelfChip(page, 'music').click();
      await openArtist(page, 'Lantern Parade');
      const card = musicRelease(page, 'Night Lights Live 2024');
      id = await card.getAttribute('data-title-id');

      // Set artist… moves the release to that artist's tile; the page, now empty, goes back to the shelf.
      await card.getByTestId('music-release-menu').click();
      await expect(card.getByTestId('music-unreject')).toHaveCount(0);
      await card.getByTestId('music-set-artist').click();
      const artistForm = page.getByTestId('music-artist-form');
      await artistForm.getByTestId('music-artist').fill('Neon Harbor');
      await artistForm.getByTestId('music-artist-save').click();
      await expect(artistTile(page, 'Neon Harbor')).toBeVisible();
      await expect(artistTile(page, 'Lantern Parade')).toHaveCount(0);
      await openArtist(page, 'Neon Harbor');
      await card.getByTestId('music-release-menu').click();
      await card.getByTestId('music-set-artist').click();
      await page.getByTestId('music-artist-found').click();
      await expect(artistTile(page, 'Lantern Parade')).toBeVisible();
      await expect(artistTile(page, 'Neon Harbor')).toHaveCount(0);

      // Not this release: the folder's title ("Night Lights", not the lookup's "Night Lights Live 2024") and date, with no kind
      // known, so Other; Use this release again undoes it.
      await openArtist(page, 'Lantern Parade');
      await card.getByTestId('music-release-menu').click();
      await card.getByTestId('music-reject').click();
      const other = page.locator('[data-testid="artist-section"][data-section="other"] [data-testid="music-release"][data-name="Night Lights"]');
      // the lookup's artist id is gone with it: the page goes back to the shelf, where the folder's artist has a tile
      await openArtist(page, 'Lantern Parade');
      await expect(other).toBeVisible();
      await expect(other).toContainText('2024');
      await expect(musicRelease(page, 'Night Lights Live 2024')).toHaveCount(0);
      await other.getByTestId('music-release-menu').click();
      await expect(other.getByTestId('music-reject')).toHaveCount(0);
      await other.getByTestId('music-unreject').click();
      await openArtist(page, 'Lantern Parade');
      await expect(page.locator('[data-testid="artist-section"][data-section="concerts"] [data-testid="music-release"][data-name="Night Lights Live 2024"]')).toBeVisible();
    } finally {
      if (id !== null) await ownerApi(`admin/music/${encodeURIComponent(id)}`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ artist: null, rejectMatch: false }) });
    }
  });
});

test('NAS settings show the matching status, the TMDB attribution, and the gate switch asks first', async ({ page, browserName }) => {
  // The switch shows the server's gate, which the guest test opens for a while: the browsers take turns with it.
  await exclusivelyAsync('gate', () => gateSettings(page, browserName));
});

async function gateSettings(page: Page, browserName: string): Promise<void> {
  await openTitles(page, browserName);
  await page.getByTestId('nas-settings').click();
  await expect(page.getByTestId('nas-matching')).toContainText(/Last matched|Matching…/);
  await expect(page.getByTestId('nas-matching')).toContainText(/\d+ discs? filed · \d+ unsorted · \d+ music/);
  await expect(page.getByTestId('nas-tmdb-text')).toHaveText('This product uses the TMDB API but is not endorsed or certified by TMDB');
  const logo = page.getByTestId('nas-tmdb').getByRole('img', { name: 'TMDB' });
  await expect(logo).toBeVisible();
  await expect.poll(() => logo.evaluate((img: HTMLImageElement) => img.naturalWidth)).toBeGreaterThan(0);

  // The answer is stubbed: opening the gate for real would show guests the library in the other browsers' tests.
  const origin = new URL(page.url()).origin;
  const sent: unknown[] = [];
  await page.route('**/api/admin/settings/title-library', async (route) => {
    if (route.request().method() !== 'PUT') return route.fallback();
    sent.push(route.request().postDataJSON());
    await route.fulfill({ status: 204, headers: { 'Access-Control-Allow-Origin': origin } });
  });
  const gate = page.getByRole('switch', { name: 'Show the title library to everyone' });
  await expect(gate).not.toBeChecked();
  await gate.click();
  await page.getByTestId('nas-gate-cancel').click();
  await expect(gate).not.toBeChecked();
  expect(sent).toEqual([]);
  await gate.click();
  await page.getByTestId('nas-gate-confirm').click();
  await expect(gate).toBeChecked();
  expect(sent).toEqual([{ gate: 'everyone' }]);
  // Turning it off is the safe direction: no confirm (ruling T11j).
  await gate.click();
  await expect(gate).not.toBeChecked();
  await expect(page.getByTestId('nas-gate-confirm')).toHaveCount(0);
  expect(sent).toEqual([{ gate: 'everyone' }, { gate: 'owners' }]);
}

test('a hidden copy explains what it follows, and "apply to the folder" lists the discs it left', async ({ page, browserName }, testInfo) => {
  const project = projectOf(testInfo.project.name);
  const name = OWNER_SERIES[project];
  const [first, second] = ownerDiscs(project).series.map(lastSegment) as [string, string];
  let secondId: string | null = null;
  const applied: unknown[] = [];
  const cors = (): Record<string, string> => ({ 'Access-Control-Allow-Origin': new URL(page.url()).origin });
  // Stubbed answers: the NAS's own refusals (copies need two discs with one fingerprint) and nothing changed for real.
  await page.route('**/api/admin/discs/*/choice', async (route) => {
    const req = route.request();
    if (req.method() === 'DELETE') return route.fulfill({ status: 409, headers: cors(), json: { error: 'copy-follows-source', source: 'src-disc' } });
    const body = req.postDataJSON() as { choice: unknown; applyToGroup?: boolean };
    if (body.applyToGroup) applied.push(body.choice);
    if (!body.applyToGroup) return route.fulfill({ status: 204, headers: cors() });
    return route.fulfill({ status: 200, headers: cors(), json: { skipped: [{ discId: secondId, reason: 'direct' }] } });
  });
  await page.route('**/api/admin/hidden', (route) =>
    route.fulfill({
      status: 200,
      headers: cors(),
      json: {
        discs: [
          { discId: 'src-disc', root: 'syn', folder: 'Owner/Source Disc', displayName: null },
          { discId: 'copy-disc', root: 'syn', folder: 'Owner/Copy Disc', displayName: null },
        ],
      },
    }),
  );
  await openUnsorted(page, browserName);
  secondId = await unsortedCard(page, second).getAttribute('data-disc-id');
  const card = unsortedCard(page, first);
  await card.locator(`[data-testid="title-option"][data-name="${name}"]`).click();
  // Filed with no disc number: Apply waits for one (ruling T11h), and numbers the others from it.
  await card.getByTestId('unsorted-file').click();
  const apply = page.getByTestId('unsorted-apply');
  await expect(apply).toBeDisabled();
  await expect(page.getByTestId('unsorted-apply-hint')).toHaveText("Enter this disc's number first");
  await page.getByTestId('unsorted-apply-disc').fill('0');
  await expect(apply).toBeDisabled();
  await page.getByTestId('unsorted-apply-disc').fill('3');
  await expect(page.getByTestId('unsorted-apply-hint')).toHaveCount(0);
  await apply.click();
  await expect(page.getByTestId('unsorted-notice')).toContainText('No other disc in this folder was filed.');
  expect(applied).toEqual([{ kind: 'title', titleId: `anilist:${900111 + PROJECTS.indexOf(project)}`, season: 1, disc: 3 }]);
  await expect(page.getByTestId('unsorted-skipped')).toHaveText(`${second} (filed separately)`);

  await page.getByTestId('open-hidden').click();
  const copy = page.locator('[data-testid="hidden-row"][data-folder="Copy Disc"]');
  await copy.getByTestId('hidden-unhide').click();
  await expect(copy.getByTestId('hidden-follows')).toContainText('This disc follows its copy at syn/Owner/Source Disc');
  await expect(copy.getByTestId('hidden-own')).toHaveText("Don't list this copy");
  await copy.getByTestId('hidden-file').click();
  await expect(copy.getByTestId('unsorted-card')).toBeVisible();
});

test('NAS settings list own titles, to rename, change seasons and delete after a confirm', async ({ page, browserName }, testInfo) => {
  const project = projectOf(testInfo.project.name);
  const name = `Harbor Tales ${project}`;
  await exclusivelyAsync('catalogue', async () => {
    const created = (await (await ownerApi('admin/titles', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ kind: 'series', name, seasons: 2 }) })).json()) as { id: string };
    try {
      await openTitles(page, browserName);
      await page.getByTestId('nas-settings').click();
      const row = page.locator(`[data-testid="nas-own-title"][data-name="${name}"]`);
      await expect(row).toContainText('Series · 2 seasons');

      await row.getByRole('button', { name: `Rename ${name}` }).click();
      await row.getByRole('textbox', { name: 'Name' }).fill(`${name} Redux`);
      await row.getByTestId('nas-own-save').click();
      const renamed = page.locator(`[data-testid="nas-own-title"][data-name="${name} Redux"]`);
      await expect(renamed).toBeVisible();

      await renamed.getByRole('button', { name: `Seasons of ${name} Redux` }).click();
      await renamed.getByRole('textbox', { name: 'Seasons' }).fill('3');
      await renamed.getByTestId('nas-own-save').click();
      await expect(renamed).toContainText('Series · 3 seasons');

      await renamed.getByRole('button', { name: `Delete ${name} Redux` }).click();
      await expect(renamed).toContainText(`Delete ${name} Redux? Its discs go back to Unsorted.`);
      await renamed.getByRole('button', { name: 'Cancel' }).click();
      await expect(renamed).toBeVisible();
      await renamed.getByRole('button', { name: `Delete ${name} Redux` }).click();
      await renamed.getByTestId('nas-own-delete-confirm').click();
      await expect(renamed).toHaveCount(0);

      // the library fetches its titles again: the deleted title is gone from search
      await page.getByRole('button', { name: 'Back', exact: true }).click();
      await page.getByTestId('title-search').fill(name);
      await expect(page.getByTestId('title-row')).toHaveCount(0);
    } finally {
      await ownerApi(`admin/titles/${encodeURIComponent(created.id)}`, { method: 'DELETE' });
    }
  });
});

const NOT_FOUND_COPY = "This link is for a NAS this device isn't paired with. Ask its owner to send you an invite.";
const MISSING_COPY = "This NAS doesn't have what this link points to. It may have been removed or renamed, or the link may be for another NAS.";
const CLOSED_COPY = "The NAS owner hasn't opened the title library to this device, so this link can't open here. You can still browse the NAS by folder.";

test('a NAS link on an unpaired device asks for an invite', async ({ page }) => {
  await page.goto('/nas/title/anilist%3A1');
  await expect(page.getByTestId('nas-not-found')).toBeVisible({ timeout: 15_000 });
  await expect(page.getByTestId('nas-not-found').locator('p')).toHaveText(NOT_FOUND_COPY);
  await expect(page.getByTestId('pair-screen')).toHaveCount(0);
  await page.getByRole('button', { name: 'Pair with a NAS' }).click();
  await expect(page.getByTestId('pair-screen')).toBeVisible();
  await expect(page.getByTestId('nas-not-found')).toHaveCount(0);
  expect(pathOf(page)).toBe('/');
});

test('a link to something the NAS does not have says so, and leads back to the library', async ({ page, browserName }) => {
  await libraryReady();
  await allowLocalNetwork(page, browserName);
  await pairByLink(page);
  await page.goto('/nas/play/d.0000000000000000');
  await expect(page.getByTestId('nas-not-found').locator('p')).toHaveText(MISSING_COPY, { timeout: 15_000 });
  await page.goto('/nas/title/anilist%3A999999999');
  await expect(page.getByTestId('nas-not-found').locator('p')).toHaveText(MISSING_COPY, { timeout: 15_000 });
  // Paired, the button leads back to the library instead of the pair screen.
  await page.getByRole('button', { name: 'Back to the library' }).click();
  await expect(page.getByTestId('title-library')).toBeVisible({ timeout: 15_000 });
  await expect(page.getByTestId('nas-paired')).toBeVisible();
  expect(pathOf(page)).toBe('/nas');
});

test('a guest behind the closed title gate gets not-found for a title link', async ({ page, browser, browserName }) => {
  await libraryReady();
  await allowLocalNetwork(page, browserName);
  await pairByLink(page);
  const res = await ownerApi('admin/codes', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ newPerson: { name: 'Noor', owner: false }, invite: true }),
  });
  expect(res.status).toBe(200);
  const { code } = (await res.json()) as { code: string };
  const guestContext = await browser.newContext();
  try {
    const guest = await guestContext.newPage();
    await allowLocalNetwork(guest, browserName);
    await guest.goto('/');
    await guest.getByTestId('pair-code').fill(code);
    await guest.getByTestId('pair-button').click();
    await expect(guest.getByTestId('nas-paired')).toBeVisible({ timeout: 25_000 });
    await exclusivelyAsync('gate', async () => {
      await setGate('owners');
      await guest.goto('/nas/title/anilist%3A1');
      await expect(guest.getByTestId('nas-not-found').locator('p')).toHaveText(CLOSED_COPY, { timeout: 15_000 });
      await expect(guest.getByTestId('nas-crumbs')).toHaveCount(0);
      await guest.getByRole('button', { name: 'Browse by folder' }).click();
      await expect(guest.getByTestId('nas-crumbs')).toHaveText('NAS', { timeout: 15_000 });
      expect(new URL(guest.url()).pathname).toBe('/nas/folders');
      await guest.goto('/nas');
      await expect(guest.getByTestId('nas-crumbs')).toHaveText('NAS', { timeout: 15_000 });
      await expect(guest.getByTestId('nas-not-found')).toHaveCount(0);
    });
  } finally {
    await guestContext.close();
  }
});

// The subtitle store (piece 3): owners upload subtitles with their fonts on a season or movie; everyone sees languages.

const STARFALL = 'anilist:900001';
const subtitleRow = (page: Page, name: string) => page.locator(`[data-testid="subtitle-row"][data-name="${name}"]`);
const episodeTags = (page: Page, number: number) => page.locator(`[data-testid="episode-row"][data-number="${number}"] [data-testid="episode-subtitle-tag"]`);

/** Starfall Wanderer's Season 1, from the title library. */
async function openStarfallSeason(page: Page): Promise<void> {
  await page.locator('[data-testid="title-card"][data-name="Starfall Wanderer"]').click();
  await page.locator('[data-testid="season-row"][data-label="Season 1"]').click();
  await expect(page.getByTestId('episode-row')).toHaveCount(1);
}

/**
 * Runs `fn` while no other project's test touches Starfall Wanderer's stored subtitles (the server is shared), with
 * none stored at its start or end.
 */
async function withStarfallSubtitles(fn: () => Promise<void>): Promise<void> {
  const clear = async (): Promise<void> => {
    const res = await ownerApi(`subtitles?titleId=${encodeURIComponent(STARFALL)}`);
    expect(res.status).toBe(200);
    for (const s of (await res.json()) as { id: string }[]) await ownerApi(`subtitles/${encodeURIComponent(s.id)}`, { method: 'DELETE' });
  };
  await exclusivelyAsync('subtitles', async () => {
    await clear();
    try {
      await fn();
    } finally {
      await clear();
    }
  });
}

/** Stores ep1.ass for Starfall Wanderer's episode 1 through the owner API, as `name`, in English. */
async function storeEpisode1Subtitle(name: string, offsetMs = 0): Promise<string> {
  const detail = (await (await ownerApi(`titles/${encodeURIComponent(STARFALL)}`)).json()) as { seasons: { id: string; number: number | null }[] };
  const seasonId = detail.seasons.find((s) => s.number === 1)!.id;
  const created = await ownerApi('subtitles', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name, language: 'en', offsetMs, for: { kind: 'episode', titleId: STARFALL, seasonId, episode: 1 } }),
  });
  expect(created.status).toBe(201);
  const { id } = (await created.json()) as { id: string };
  const file = await ownerApi(`subtitles/${encodeURIComponent(id)}/file/ep1.ass`, { method: 'PUT', body: readFileSync(join(REPO_ROOT, 'tests/e2e/fixtures/ep1.ass')) });
  expect(file.status).toBe(200);
  return id;
}

test('an owner uploads subtitles with a font for an episode, and everyone sees its language', async ({ page, browser, browserName }) => {
  await openTitles(page, browserName);
  await withStarfallSubtitles(async () => {
    await openStarfallSeason(page);
    await expect(episodeTags(page, 1)).toHaveCount(0);
    await page.getByTestId('subtitle-add').click();
    const form = page.getByTestId('subtitle-upload');
    await expect(form).toBeVisible();
    await page.getByTestId('subtitle-upload-files').setInputFiles([join(REPO_ROOT, 'tests/e2e/fixtures/ep1.ass'), join(REPO_ROOT, 'fixtures/ass/fonts/DejaVuSans.ttf')]);
    await page.getByTestId('subtitle-upload-for').selectOption({ label: 'Episode 1' });
    await page.getByTestId('subtitle-upload-language').fill('en');
    await page.getByTestId('subtitle-upload-name').fill(`Fansub ${browserName}`);
    await page.getByTestId('subtitle-upload-offset').fill('0.4');
    await page.getByTestId('subtitle-upload-submit').click();
    await expect(form).toHaveCount(0, { timeout: 15_000 });
    const row = subtitleRow(page, `Fansub ${browserName}`);
    await expect(row).toBeVisible();
    await expect(row).toContainText('EN');
    await expect(row).toContainText('Episode 1');
    await expect(row).toContainText('ep1.ass');
    await expect(row).toContainText('DejaVuSans.ttf');
    await expect(row).toContainText('+0.4 s');
    await expect(episodeTags(page, 1)).toHaveText(['EN']);
    const stored = (await (await ownerApi(`subtitles?titleId=${encodeURIComponent(STARFALL)}`)).json()) as { name: string; offsetMs: number; fonts: { name: string }[] }[];
    expect(stored).toEqual([expect.objectContaining({ name: `Fansub ${browserName}`, offsetMs: 400, fonts: [expect.objectContaining({ name: 'DejaVuSans.ttf' })] })]);

    // A guest sees the language on the episode, and neither the button nor the list.
    const minted = await ownerApi('admin/codes', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ newPerson: { name: `Subtitle Guest ${browserName}`, owner: false }, invite: true }),
    });
    expect(minted.status).toBe(200);
    const { code, personId } = (await minted.json()) as { code: string; personId: string };
    const guestContext = await browser.newContext();
    try {
      const guest = await guestContext.newPage();
      await allowLocalNetwork(guest, browserName);
      await guest.goto('/');
      await guest.getByTestId('pair-code').fill(code);
      await guest.getByTestId('pair-button').click();
      await expect(guest.getByTestId('nas-paired')).toBeVisible({ timeout: 25_000 });
      await exclusivelyAsync('gate', async () => {
        try {
          await setGate('everyone');
          await guest.getByTestId('nas-open').click();
          await expect(guest.getByTestId('title-library')).toBeVisible({ timeout: 15_000 });
          await openStarfallSeason(guest);
          await expect(episodeTags(guest, 1)).toHaveText(['EN']);
          await expect(guest.getByTestId('subtitle-add')).toHaveCount(0);
          await expect(guest.getByTestId('subtitle-list')).toHaveCount(0);
        } finally {
          await setGate('owners');
        }
      });
    } finally {
      await guestContext.close();
      await ownerApi(`admin/people/${encodeURIComponent(personId)}`, { method: 'DELETE' });
    }
  });
});

test('an owner deletes an upload', async ({ page, browserName }) => {
  await openTitles(page, browserName);
  await withStarfallSubtitles(async () => {
    await storeEpisode1Subtitle(`Delete me ${browserName}`);
    await openStarfallSeason(page);
    const row = subtitleRow(page, `Delete me ${browserName}`);
    await expect(row).toBeVisible();
    await expect(episodeTags(page, 1)).toHaveText(['EN']);
    await row.getByTestId('subtitle-delete').click();
    await expect(row.getByTestId('subtitle-delete-confirm')).toBeVisible();
    await row.getByTestId('subtitle-delete-confirm').click();
    await expect(row).toHaveCount(0);
    await expect(episodeTags(page, 1)).toHaveCount(0);
    const left = (await (await ownerApi(`subtitles?titleId=${encodeURIComponent(STARFALL)}`)).json()) as unknown[];
    expect(left).toEqual([]);
  });
});

test('an upload with two subtitle files is refused before anything is sent', async ({ page, browserName }) => {
  await openTitles(page, browserName);
  await openStarfallSeason(page);
  const writes: string[] = [];
  page.on('request', (r) => {
    if (r.url().includes('/api/subtitles') && r.method() !== 'GET') writes.push(`${r.method()} ${r.url()}`);
  });
  await page.getByTestId('subtitle-add').click();
  await page.getByTestId('subtitle-upload-files').setInputFiles([join(REPO_ROOT, 'tests/e2e/fixtures/ep1.ass'), join(REPO_ROOT, 'tests/e2e/fixtures/ep2.ass')]);
  await page.getByTestId('subtitle-upload-for').selectOption({ label: 'Episode 1' });
  await page.getByTestId('subtitle-upload-language').fill('en');
  await page.getByTestId('subtitle-upload-submit').click();
  await expect(page.getByTestId('subtitle-upload-error')).toHaveText('Pick one subtitle file (SRT or ASS) at a time.');
  await expect(page.getByTestId('subtitle-upload')).toBeVisible();
  expect(writes).toEqual([]);
});

test('everyone picks a stored subtitle in the player, at its default offset', async ({ page, browserName }) => {
  await openTitles(page, browserName);
  await skipWithoutH264(page, { realtime: false });
  await withStarfallSubtitles(async () => {
    const id = await storeEpisode1Subtitle(`Player pick ${browserName}`, 400);
    await openEpisode1(page);
    await page.getByTestId('nas-play').click();
    // the episode is disc1's 4-second playlist: once it ends the controls stay up
    await expect(playerState(page)).toHaveAttribute('data-state', 'ended', { timeout: 15_000 });
    await expect(playerState(page)).toHaveAttribute('data-playlist', '00001');
    await page.getByTestId('subtitle-menu').click();
    await expect(page.getByTestId('subtitle-stored')).toHaveText('From the NAS');
    const row = page.getByTestId(`subtitle-stored-${id}`);
    await expect(row).toHaveText(`Player pick ${browserName} · English`);
    await expect(row).toHaveAttribute('aria-checked', 'false');
    await row.click();
    await page.getByTestId('subtitle-menu').click();
    await expect(page.getByTestId('subtitle-file-0')).toContainText('ep1.ass', { timeout: 10_000 });
    await expect(page.getByTestId('subtitle-offset')).toHaveText('+0.4 s');
    await expect(page.getByTestId('subtitle-text')).toHaveAttribute('aria-checked', 'true');
    await expect(row).toHaveAttribute('aria-checked', 'true');
    await expect(page.getByTestId('subtitle-file-1')).toHaveCount(0);
  });
});

test('owner finds fansubs for a season', async ({ page, browserName }) => {
  await openTitles(page, browserName);
  await skipWithoutH264(page, { realtime: false });
  await withStarfallSubtitles(async () => {
    await openStarfallSeason(page);
    await expect(page.getByTestId('fansub-line')).toBeVisible();
    await page.getByTestId('fansub-run').click();
    const row = page.locator('[data-testid="episode-row"][data-number="1"]');
    const item = page.locator('li', { has: row });
    await expect(item.getByTestId('fansub-mark')).toBeVisible({ timeout: 90_000 });
    await expect(item.getByTestId('fansub-chip').first()).toBeVisible();
    await expect(page.getByTestId('fansub-line')).toContainText('GroupA');
    const stored = (await (await ownerApi(`subtitles?titleId=${encodeURIComponent(STARFALL)}`)).json()) as { id: string; source?: unknown }[];
    const fansub = stored.find((s) => s.source !== undefined);
    expect(fansub).toBeDefined();
    // the button beside the row opens its fansubs; a tap on the row itself plays
    await page.getByTestId('fansub-open').click();
    await expect(page.getByTestId('fansub-panel')).toBeVisible();
    await row.click();
    await expect(page.getByTestId('nas-preflight')).toBeVisible();
    await page.getByTestId('nas-play').click();
    await expect(playerState(page)).toHaveAttribute('data-state', 'ended', { timeout: 15_000 });
    await page.getByTestId('subtitle-menu').click();
    await expect(page.getByTestId('subtitle-stored')).toHaveText('From the NAS');
    await expect(page.getByTestId(`subtitle-stored-${fansub!.id}`)).toBeVisible();
  });
});

/** Moves the seek bar to `us` (as a drag would). */
async function seekTo(page: Page, us: number): Promise<void> {
  await page.getByTestId('seek').evaluate((el, value) => {
    const input = el as HTMLInputElement;
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, String(value));
    input.dispatchEvent(new Event('input', { bubbles: true }));
  }, us);
}

test('a guest searches Anime Tosho from the player', async ({ page, browser, browserName }) => {
  await libraryReady();
  await skipWithoutH264(page, { realtime: false });
  const minted = await ownerApi('admin/codes', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ newPerson: { name: `Tosho Guest ${browserName}`, owner: false }, invite: true }),
  });
  expect(minted.status).toBe(200);
  const { code, personId } = (await minted.json()) as { code: string; personId: string };
  // the guest's browser is this project's (a phone's screen and touch, when the project is one)
  const { viewport, screen, hasTouch, isMobile, deviceScaleFactor, userAgent } = test.info().project.use;
  const guestContext = await browser.newContext({ viewport, screen, hasTouch, isMobile, deviceScaleFactor, userAgent });
  try {
    const guest = await guestContext.newPage();
    await allowLocalNetwork(guest, browserName);
    await guest.goto('/?telemetry=1');
    await guest.getByTestId('pair-code').fill(code);
    await guest.getByTestId('pair-button').click();
    await expect(guest.getByTestId('nas-paired')).toBeVisible({ timeout: 25_000 });
    await withStarfallSubtitles(() =>
      exclusivelyAsync('gate', async () => {
        try {
          await setGate('everyone');
          await guest.getByTestId('nas-open').click();
          await expect(guest.getByTestId('title-library')).toBeVisible({ timeout: 15_000 });
          await openEpisode1(guest);
          await guest.getByTestId('nas-play').click();
          await waitForPlaying(guest);
          await guest.getByTestId('play-toggle').click();
          await expect(playerState(guest)).toHaveAttribute('data-state', 'paused');
          await guest.getByTestId('subtitle-menu').click();
          // nothing is attached to the episode: the search is the way to subtitles
          await expect(guest.getByTestId('subtitle-stored-none')).toHaveText('Nothing for this episode');
          await guest.getByTestId('subtitle-tosho').click();
          await expect(guest.getByTestId('tosho-query')).toHaveValue('Starfall Wanderer');
          const first = guest.locator('[data-testid^="tosho-release-"]').first();
          await expect(first).toContainText('[GroupA] Starfall Wanderer (BD 1080p)', { timeout: 15_000 });
          await expect(first).toContainText('SeaDex best');
          await first.click();
          const full = guest.getByTestId('tosho-track-7101-0');
          await expect(full).toHaveText('English · Full', { timeout: 15_000 });
          await full.click();
          await expect(full).toHaveAttribute('aria-checked', 'true', { timeout: 90_000 });
          await guest.keyboard.press('Escape');
          await expect(guest.getByTestId('tosho-query')).toHaveCount(0);
          // within the first line (0.2–1.9 s), through 0 so the sample is a fresh one
          for (const us of [0, 1_000_000]) {
            await seekTo(guest, us);
            await expect.poll(async () => (await telemetry(guest))?.clockUs ?? -1, { timeout: 5_000, intervals: [50] }).toBe(us);
          }
          await expect
            .poll(async () => {
              const t = (await telemetry(guest)) as { textCue?: boolean; ass?: { events: number } | null } | null;
              return t?.textCue === true && (t.ass?.events ?? 0) > 0;
            }, { timeout: 10_000 })
            .toBe(true);
          await guest.getByTestId('subtitle-menu').click();
          await expect(guest.getByTestId('subtitle-text')).toHaveAttribute('aria-checked', 'true');
        } finally {
          await setGate('owners');
        }
      }),
    );
  } finally {
    await guestContext.close();
    await ownerApi(`admin/people/${encodeURIComponent(personId)}`, { method: 'DELETE' });
  }
});

test('a stored subtitle and my offset come back when I resume', async ({ page, browserName }) => {
  const api = await openTitlesAsResumePerson(page, browserName);
  await skipWithoutH264(page);
  await withStarfallSubtitles(async () => {
    const id = await storeEpisode1Subtitle(`Resume pick ${browserName}`, 400);
    await openEpisode1(page);
    await page.getByTestId('nas-play').click();
    await waitForPlaying(page);
    await expect.poll(() => clockUs(page), { timeout: 10_000, intervals: [50] }).toBeGreaterThanOrEqual(3_300_000);
    await page.getByTestId('video-canvas').click();
    await expect(playerState(page)).toHaveAttribute('data-state', 'paused');
    await page.getByTestId('subtitle-menu').click();
    await page.getByTestId(`subtitle-stored-${id}`).click();
    await page.getByTestId('subtitle-menu').click();
    await expect(page.getByTestId('subtitle-offset')).toHaveText('+0.4 s', { timeout: 10_000 });
    for (let i = 0; i < 5; i++) await page.getByTestId('subtitle-offset-plus').click();
    await expect(page.getByTestId('subtitle-offset')).toHaveText('+0.9 s');
    // an offset change saves at once
    const saved = async (): Promise<unknown> => {
      const res = await api(`me/playback/${encodeURIComponent(disc1Key())}`);
      return res.status === 200 ? ((await res.json()) as { places: Record<string, { settings: { textFiles: unknown[] } }> }).places['00001']?.settings.textFiles ?? null : null;
    };
    await expect.poll(saved, { timeout: 5_000 }).toEqual([expect.objectContaining({ name: 'ep1.ass', offsetMs: 900, subtitleId: id, language: 'en' })]);
    await page.goBack();
    await expect(page.getByTestId('season-screen')).toBeVisible({ timeout: 15_000 });

    await page.locator('[data-testid="episode-row"][data-number="1"]').click();
    await expect(page.getByTestId('resume-at')).toHaveText('Resume at 0:03', { timeout: 10_000 });
    await page.getByTestId('resume-at').click();
    await expect(playerState(page)).toHaveAttribute('data-playlist', '00001', { timeout: 15_000 });
    // the 4 s episode ends a moment later, and the controls stay up
    await expect(playerState(page)).toHaveAttribute('data-state', 'ended', { timeout: 15_000 });
    await page.getByTestId('subtitle-menu').click();
    await expect(page.getByTestId('subtitle-file-0')).toContainText('ep1.ass', { timeout: 10_000 });
    await expect(page.getByTestId('subtitle-offset')).toHaveText('+0.9 s');
    await expect(page.getByTestId('subtitle-text')).toHaveAttribute('aria-checked', 'true');
    await expect(page.getByTestId(`subtitle-stored-${id}`)).toHaveAttribute('aria-checked', 'true');
    await expect(page.getByTestId('subtitle-file-1')).toHaveCount(0);
  });
});
