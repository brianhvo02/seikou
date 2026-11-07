/// <reference types="node" />
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { expect, test, type BrowserContext, type Page } from '@playwright/test';
import { readTar } from '../../src/engine/bdj/store/tar';
import { normalizeCode } from '@seikou/nas/pairing-code';
import { createDiscHandler, servedDiscBase } from '../../tools/disc-server/server';
import { settlesOn } from './bdj-support';
import { NAS_E2E_DIR, NAS_ENV, NAS_PORT, SERVER } from './nas-server';
import { setFolder, skipWithoutH264 } from './support';

// fixtures/synthetic/disc-bdj-store (scripts/make-bdj-store-disc.ts): StoreXlet counts its own openings. It reads
// /persistent/<org>/<app>/count (the path built from dvb.persistent.root and its xlet properties, as libbluray's
// BDJAppProxy makes it) and the lines of the organisation's loose BUDA file /buda/<org>/x.log, draws both
// ("count <c>  log <l>"), writes c + 1 and a line more, and only then plays playlist 00000. What it saved lasts in
// IndexedDB (BdjStore, ruling R1): the next opening in the same browser shows the next count.
//
// The plane hashes are libbluray's for three openings on one storage (tests/bdj/golden/disc-bdj-store.open.<n>.jsonl,
// npm run bdj-trace:golden): equal hashes prove both numbers came back, and that the plane matches libbluray's.

const STORE_DISC = 'fixtures/synthetic/disc-bdj-store';
const ORG = '7fff0002';

/** The settled plane libbluray drew at its n-th opening (0: "count 0  log 0"). */
const OPENED: readonly string[] = [1, 2, 3].map((n) => {
  const lines = readFileSync(new URL(`../bdj/golden/disc-bdj-store.open.${n}.jsonl`, import.meta.url), 'utf8').trim().split('\n');
  const end = lines.map((l) => JSON.parse(l) as { script?: string; hash?: string }).find((e) => e.script === 'end');
  if (!end?.hash) throw new Error(`disc-bdj-store.open.${n}.jsonl has no end hash`);
  return end.hash;
});

/** Opens the disc from the folder input of a page on the landing screen (the `local` source). */
async function openLocal(page: Page): Promise<void> {
  await expect(page.getByTestId('folder-input')).toBeAttached({ timeout: 15_000 });
  await setFolder(page.getByTestId('folder-input'), STORE_DISC);
}

/** Loads the player (fresh, as a viewing starts) and opens the disc from the folder. */
async function view(page: Page): Promise<void> {
  await page.goto('/?telemetry=1');
  await skipWithoutH264(page);
  await openLocal(page);
}

/**
 * Waits for StoreXlet's playlist, which it starts right after its write (a `playlist` event, not telemetry, so it is
 * seen tens of milliseconds after Java wrote), and returns Date.now() then.
 */
async function written(page: Page): Promise<number> {
  await page.waitForFunction(() => document.querySelector('[data-testid="player"]')?.getAttribute('data-playlist') === '00000', null, { polling: 'raf', timeout: 30_000 });
  return Date.now();
}

/** Back to the landing screen, as a person closes the disc (the BD-J stop saves before the next boot loads). */
async function closeDisc(page: Page): Promise<void> {
  // the count shows as a BD-J menu, over which a pointer or a tap wakes the controls only at the bottom edge
  const box = (await page.getByTestId('player').boundingBox())!;
  const edge = { x: box.x + box.width / 2, y: box.y + box.height - 4 };
  if (await page.evaluate(() => matchMedia('(pointer: coarse)').matches)) await page.touchscreen.tap(edge.x, edge.y);
  else await page.mouse.move(edge.x, edge.y);
  await page.getByRole('button', { name: 'Playlists' }).click();
  await page.getByRole('button', { name: 'Open another disc' }).click();
  await expect(page.getByTestId('landing')).toBeVisible();
}

interface StoredFile {
  readonly path: string;
  readonly mtime: number;
  readonly text: string;
}

/**
 * A scope's record in the page's IndexedDB (database bdj-store, src/engine/bdj/store/idb-store.ts): its files and when
 * it was saved; null when there is none. Never creates the database (an upgrade is aborted), so the engine's own open
 * still makes it with its object store.
 */
async function storedScope(page: Page, source: string, scope: string): Promise<{ savedAt: number; pending?: boolean; files: StoredFile[] } | null> {
  return page.evaluate(
    ({ key }) =>
      new Promise<{ savedAt: number; pending?: boolean; files: StoredFile[] } | null>((resolve, reject) => {
        const r = indexedDB.open('bdj-store');
        r.onupgradeneeded = () => r.transaction!.abort(); // no database yet: leave it so
        r.onerror = (e) => {
          e.preventDefault();
          resolve(null);
        };
        r.onsuccess = () => {
          const db = r.result;
          if (!db.objectStoreNames.contains('scopes')) {
            db.close();
            resolve(null);
            return;
          }
          const get = db.transaction('scopes', 'readonly').objectStore('scopes').get(key);
          get.onerror = () => reject(get.error);
          get.onsuccess = () => {
            db.close();
            const rec = get.result as { savedAt: number; pending?: boolean; files: { path: string; mtime: number; bytes: Uint8Array }[] } | undefined;
            resolve(rec ? { savedAt: rec.savedAt, pending: rec.pending, files:rec.files.map((f) => ({ path: f.path, mtime: f.mtime, text: new TextDecoder().decode(f.bytes) })) } : null);
          };
        };
      }),
    { key: `${source}|${scope}` },
  );
}

/** Waits until the app's count `want` is stored for `source`: a navigation after it starts the next viewing from it. */
async function stored(page: Page, source: string, want: number): Promise<void> {
  await expect
    .poll(async () => (await storedScope(page, source, `persistent/${ORG}`))?.files.find((f) => f.path === '4001/count')?.text ?? null, { timeout: 15_000 })
    .toBe(String(want));
}

test.describe('saved data across viewings (disc-bdj-store)', () => {
  test('a count saved in one viewing is there in the next: the disc closed and reopened, then the page reloaded', async ({ page }) => {
    test.setTimeout(120_000);
    await view(page);
    await written(page);
    await settlesOn(page, OPENED[0]!);
    await closeDisc(page);
    await openLocal(page);
    await settlesOn(page, OPENED[1]!, 30_000);
    await stored(page, 'local', 2);
    await page.reload();
    await openLocal(page);
    await settlesOn(page, OPENED[2]!, 30_000);
    // what the browser keeps: the app's count and the organisation's loose BUDA file (ruling R14), each in its scope
    await stored(page, 'local', 3);
    expect((await storedScope(page, 'local', `persistent/${ORG}`))?.files.map((f) => f.path)).toEqual(['4001/count']);
    expect((await storedScope(page, 'local', `buda/${ORG}`))?.files.map((f) => [f.path, f.text])).toEqual([['x.log', 'opened\n'.repeat(3)]]);
  });

  // Review Focus 3 (ruling R1): the page goes 0.5 s after Java's write, well inside the plan's 2 s debounce. The flush
  // on pagehide cannot keep it in Chrome and Safari (they drop IndexedDB transactions started then, and terminate the
  // workers the flush crosses): the browser's store saves 100 ms after the write instead (IDB_SAVE_DEBOUNCE_MS), so the
  // save is on disk before the page goes. Two ways a page goes: its tab closes, or it navigates away.
  for (const how of ['closed', 'navigated away'] as const) {
    test(`a page ${how} 0.5 s after the disc saved keeps the save`, async ({ context, page }) => {
      await view(page);
      const at = await written(page);
      await page.waitForTimeout(Math.max(0, at + 500 - Date.now()));
      const goneAt = Date.now();
      let next: Page;
      if (how === 'closed') {
        // the tab goes without its unload handlers (Playwright's default), as a killed tab does: the save cannot lean on
        // pagehide. (With runBeforeUnload, WebKit never closes a page that plays.) Another tab stays open.
        next = await context.newPage();
        await page.close();
      } else {
        await page.goto('about:blank');
        next = page;
      }
      await next.goto('/?telemetry=1');
      // the first viewing's record, before the second viewing replaces it: Java's write (the file's mtime, the BD-J
      // worker's clock) and the save, against the moment the page went (the same machine's clock)
      const scope = await storedScope(next, 'local', `persistent/${ORG}`);
      const count = scope?.files.find((f) => f.path === '4001/count');
      expect(count?.text).toBe('1');
      const wrote = count!.mtime;
      console.log(`bdj-store ${how} (${test.info().project.name}): saved ${Math.round(scope!.savedAt - wrote)} ms after the write, the page went ${Math.round(goneAt - wrote)} ms after it`);
      expect(goneAt - wrote).toBeLessThan(2_000); // inside the plan's debounce: a 2 s save would have been lost
      expect(scope!.savedAt).toBeLessThanOrEqual(goneAt);
      await openLocal(next);
      await settlesOn(next, OPENED[1]!, 30_000);
    });
  }
});

test.describe('saved data per source (disc-bdj-store on the dev disc server)', () => {
  // tools/disc-server serves the built player and the disc on one origin, so the picked folder (`local`) and the
  // server's copy (`nas:<discId>`) share one IndexedDB and differ only in their source
  const TOKEN = 'e2e-bdj-store-token';
  let server: Server;
  let origin: string;

  test.beforeAll(async () => {
    server = createServer(createDiscHandler({ roots: ['fixtures/synthetic'], token: TOKEN, distDir: 'dist' }));
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  test.afterAll(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  test('the picked folder and the server copy of one disc keep their own counts', async ({ page }) => {
    test.setTimeout(180_000);
    const base = await servedDiscBase(origin, TOKEN, 'disc-bdj-store');
    const discId = new URL(base).pathname.split('/').filter(Boolean).at(-1)!;
    const link = `${origin}/?telemetry=1&disc=${encodeURIComponent(base)}&token=${TOKEN}`;
    const openServer = async (): Promise<void> => {
      await page.goto(link);
      const button = page.getByTestId('server-discs').getByRole('button', { name: 'disc-bdj-store' });
      await expect(button).toBeEnabled({ timeout: 15_000 });
      await button.click();
    };
    const openFolder = async (): Promise<void> => {
      await page.goto(`${origin}/?telemetry=1`);
      await openLocal(page);
    };
    await page.goto(`${origin}/?telemetry=1`);
    await skipWithoutH264(page);
    const nas = `nas:${discId}`;
    await openFolder();
    await settlesOn(page, OPENED[0]!, 30_000);
    await stored(page, 'local', 1);
    await openServer();
    await settlesOn(page, OPENED[0]!, 30_000); // the server copy starts at 0: the folder's count is not its own
    await stored(page, nas, 1);
    await openFolder();
    await settlesOn(page, OPENED[1]!, 30_000);
    await stored(page, 'local', 2);
    await openServer();
    await settlesOn(page, OPENED[1]!, 30_000);
    await stored(page, nas, 2);
    await openServer();
    await settlesOn(page, OPENED[2]!, 30_000);
    await stored(page, nas, 3);
    await stored(page, 'local', 2);
  });
});

test.describe('saved data per person on the NAS (disc-bdj-store, tests/e2e/nas-server.ts)', () => {
  // The NAS is the real server that tests/e2e/nas-server.ts runs over a copy of fixtures/synthetic. Each person is made
  // by the server's `owner-code --person <name>` (an owner, so the title library and its folder browser are always open
  // to them), under a name unique to the run and the browser: the browsers' projects share the server.
  const CODE_LOCK = join(NAS_E2E_DIR, 'owner-code.lock');
  const NAS_API = `http://localhost:${NAS_PORT}/api/`;

  /** Runs `fn` while no other test worker mints a code (nas.spec.ts takes the same lock). */
  function exclusively<T>(fn: () => T): T {
    for (let tries = 0; ; tries++) {
      try {
        mkdirSync(CODE_LOCK);
        break;
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== 'EEXIST' || tries > 600) throw err;
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50);
      }
    }
    try {
      return fn();
    } finally {
      rmSync(CODE_LOCK, { recursive: true, force: true });
    }
  }

  /**
   * A fresh code for the owner person named `person` (made by its first code), or the first owner, as
   * `node server.mjs owner-code` mints it; each under a new rendezvous key, as nas.spec.ts does (the rendezvous holds
   * 5 live codes per NAS).
   */
  function codeFor(person?: string): string {
    const out = exclusively(() => {
      rmSync(join(NAS_ENV.DATA_DIR!, 'rendezvous-key.json'), { force: true });
      return execFileSync(process.execPath, [SERVER, 'owner-code', ...(person ? ['--person', person] : [])], { env: { ...process.env, ...NAS_ENV }, encoding: 'utf8' });
    });
    expect(out).toContain('Rendezvous: registered');
    return /Owner pairing code: ([0-9A-Z-]+)/.exec(out)![1]!;
  }

  /** Waits for the server's first scan and title run (until then the folder listing is empty), as an owner device. */
  async function libraryReady(): Promise<void> {
    const post = async (path: string, body: unknown): Promise<Record<string, string>> => {
      const res = await fetch(`${NAS_API}${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      expect(res.status, `POST ${path}`).toBe(200);
      return (await res.json()) as Record<string, string>;
    };
    const key = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign', 'verify']);
    const { kty, crv, x, y } = await crypto.subtle.exportKey('jwk', key.publicKey);
    const { deviceId } = await post('pair/redeem', { code: normalizeCode(codeFor())!, deviceName: 'E2E store API', publicKeyJwk: { kty, crv, x, y } });
    const { challenge } = await post('session/challenge', { deviceId });
    const signature = Buffer.from(await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, key.privateKey, new TextEncoder().encode(challenge!))).toString('base64url');
    const { token } = await post('session', { deviceId, challenge, signature });
    await expect
      .poll(
        async () => {
          const res = await fetch(`${NAS_API}admin/metadata/status`, { headers: { Authorization: `Bearer ${token}` } });
          const status = (await res.json()) as { running: boolean; lastRunAt: number | null; filed: number };
          return !status.running && status.lastRunAt !== null ? status.filed : 0;
        },
        { timeout: 30_000 },
      )
      .toBeGreaterThanOrEqual(3);
  }

  /** The person's id, from the server's auth.json (the CLI prints only the name). */
  function personId(name: string): string {
    const auth = JSON.parse(readFileSync(join(NAS_ENV.DATA_DIR!, 'auth.json'), 'utf8')) as { people: { id: string; name: string }[] };
    return auth.people.find((p) => p.name === name)!.id;
  }

  /** The app's count in the person's NAS store (its ustar file on the server), or null. */
  function nasCount(person: string): string | null {
    const file = join(NAS_ENV.DATA_DIR!, 'users', personId(person), 'bdj', 'persistent', `${ORG}.tar`);
    if (!existsSync(file)) return null;
    const count = readTar(new Uint8Array(readFileSync(file))).find((f) => f.path === '4001/count');
    return count ? new TextDecoder().decode(count.bytes) : null;
  }

  async function nasHas(person: string, want: number): Promise<void> {
    await expect.poll(() => nasCount(person), { timeout: 20_000 }).toBe(String(want));
  }

  /** A page of a browser of its own (another device), paired as `person` with a fresh code. */
  async function device(context: BrowserContext, browserName: string, person: string): Promise<Page> {
    if (browserName === 'chromium') await context.grantPermissions(['local-network-access']);
    const page = await context.newPage();
    const code = codeFor(person);
    await page.goto(`/?pair=${code}&telemetry=1`);
    await expect(page.getByTestId('pair-code')).toHaveValue(code);
    await page.getByTestId('pair-button').click();
    await expect(page.getByTestId('nas-paired')).toBeVisible({ timeout: 25_000 });
    return page;
  }

  /** From the landing screen of a paired page: the NAS's folder browser, disc-bdj-store's pre-flight, Play. */
  async function openFromNas(page: Page): Promise<void> {
    await page.getByTestId('nas-open').click();
    await expect(page.getByTestId('title-library')).toBeVisible({ timeout: 15_000 });
    await page.getByTestId('browse-folders').click();
    await expect(page.getByTestId('nas-crumbs')).toHaveText('NAS');
    await page.locator('[data-testid="nas-disc"][data-name="disc-bdj-store"]').click();
    await expect(page.getByTestId('nas-preflight')).toBeVisible();
    await page.getByTestId('nas-play').click();
  }

  test("one person's devices share the count, a page closed before the NAS put loses nothing, and another person's devices do not see it", async ({ browser, browserName }, testInfo) => {
    test.skip(testInfo.project.name === 'mobile-chromium', 'the NAS screens are tested on the desktop projects (nas.spec.ts)');
    test.setTimeout(240_000);
    await libraryReady();
    const run = `${testInfo.project.name} ${Date.now().toString(36)}`;
    const kai = `Store Kai ${run}`;
    const den = `Store Den ${run}`;
    const contexts: BrowserContext[] = [];
    const context = async (): Promise<BrowserContext> => {
      const c = await browser.newContext();
      contexts.push(c);
      return c;
    };
    try {
      // Kai's phone: the first viewing writes 1, and the page goes 0.5 s later, inside the NAS put's 2 s debounce
      const phone = await context();
      const first = await device(phone, browserName, kai);
      await skipWithoutH264(first);
      await openFromNas(first);
      const at = await written(first);
      await first.waitForTimeout(Math.max(0, at + 500 - Date.now()));
      const next = await phone.newPage();
      await first.close();
      // ruling R17: the write-ahead copy kept it; the next opening on the phone starts from 1 and the NAS gets it
      await next.goto('/?telemetry=1');
      await expect(next.getByTestId('nas-paired')).toBeVisible({ timeout: 25_000 });
      await openFromNas(next);
      await settlesOn(next, OPENED[1]!, 30_000);
      await nasHas(kai, 2);
      const source = `nas-person:${personId(kai)}`;
      await expect.poll(async () => (await storedScope(next, source, `persistent/${ORG}`))?.pending, { timeout: 15_000 }).toBe(false);

      // Kai's tablet, a browser that never opened the disc: it starts from the NAS's 2
      const tablet = await device(await context(), browserName, kai);
      await openFromNas(tablet);
      await settlesOn(tablet, OPENED[2]!, 30_000);
      await nasHas(kai, 3);

      // Den's phone starts from nothing, and Kai's count stays
      const dens = await device(await context(), browserName, den);
      await openFromNas(dens);
      await settlesOn(dens, OPENED[0]!, 30_000);
      await nasHas(den, 1);
      expect(nasCount(kai)).toBe('3');
      expect(await storedScope(dens, source, `persistent/${ORG}`)).toBeNull();
    } finally {
      for (const c of contexts) await c.close();
    }
  });
});
