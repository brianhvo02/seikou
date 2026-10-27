/**
 * The 5d device gate (spec docs/superpowers/specs/2026-10-17-m5d-bdj-menus-design.md §4.5 and §7): for each BD-J disc,
 * on one device or browser,
 *   1. open the disc through the disc server's URL and tap/click its button (the gesture that lets audio start);
 *   2. wait for the first frame of Java's first playlist and record telemetry bdj.firstFrameMs;
 *   3. drive the menu to the feature with the disc's key script (tests/bdj/scripts/<disc>.play.keys), with the keyboard
 *      on a computer and with taps on a touch target (a tap on the menu, then the on-screen remote), checking the plane
 *      at every `wait still` against libbluray's settled hashes (tests/bdj/golden/local/);
 *   4. record bdj.inputLatencyMs for every input;
 *   5. before the script's last key (the one that starts the feature), stay in the menu for --stay-ms, moving the focus
 *      every --cycle-ms and sampling bdjMemory, then check the menu settled back on its golden plane;
 *   6. detect a reload of the page (on iOS, a tab killed for memory) at every poll.
 * One JSON result per disc and target goes to --out (default the SDD workspace's gate/ folder, which is gitignored).
 * Tokens never go into results.
 *
 *   npx tsx tools/devices/gate.ts --target <target> [--disc A_NEW_ERA] [--disc RENTAL_FAMILY] [--stay-ms 600000] …
 *
 * Targets:
 *   sim:<name> | <udid>   Safari on an iOS Simulator (or a real iPhone/iPad), through Appium (session.ts; touch input)
 *   ios:<udid>            Safari on a real iPhone/iPad through safaridriver (Web Inspector and Remote Automation on;
 *                         touch input); the real-device route
 *   chrome                installed Google Chrome through Playwright (keyboard; --touch for mobile emulation)
 *   firefox               installed Firefox through Playwright's WebDriver BiDi channel (moz-firefox)
 *   firefox-pw            Playwright's own Firefox build
 *   webkit                Playwright's own WebKit build
 *   safari                Safari on this Mac through safaridriver (needs Develop → Allow Remote Automation); the gate
 *                         brings Safari to the front after each navigation, as safaridriver needs
 * Options:
 *   --server <origin> --token <t>   an already running disc server (real devices: its HTTPS LAN origin); without them
 *                                   the gate serves dist/ and --root on http://127.0.0.1:--port itself
 *   --port <n> (default 4183)  --root <dir> (default fixtures/local)  --dist <dir> (default dist)
 *   --startup-runs <n>    open the disc n more times first, recording firstFrameMs each time (the first is cold)
 *   --cycle-ms <ms> (default 3000)  --sample-ms <ms> (default 30000)  --headless  --touch  --out <dir>  --tag <text>
 *   --call-timeout <ms>   for Appium (default 120000)
 */

import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';
import type { MenuKey } from '../../src/engine/protocol';
import { parseKeyScript, type KeyStep } from '../../tests/bdj/key-script';
import { createDiscHandler, servedDiscBase } from '../disc-server/server';
import { ensureAppium, parseMs, resolveDevice, safariCaps } from './run';
import { DeviceSession, PageReloadedError, write } from './session';
import { armExpr, centreOf, DISARM_EXPR, LANDING_EXPR, layoutExpr, sameLayout, TAP_HOLD_MS, tapVerdict, waitSettled, type LayoutReading, type TapAim, type TapLanding, type TapVerdict } from './tap';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const APPIUM_URL = process.env.APPIUM_URL ?? 'http://127.0.0.1:4723';
const DEFAULT_OUT = join(REPO, '.superpowers/sdd/2026-10-17-m5d-bdj-menus/gate');
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------------------------------------------------------------
// The plan: a disc's key script with libbluray's settled hashes

export interface DiscConfig {
  /** tests/bdj/scripts/<script>.keys and tests/bdj/golden/local/<script>.jsonl */
  readonly script: string;
  readonly hevc: boolean;
  /** Plane point a touch target taps to reach the remote: the disc ignores a tap there (ignored-tap rule). */
  readonly tapPoint: readonly [number, number];
  /** The focus moves of the stay, sent alternately so the focus ends where it began. */
  readonly cycle: readonly [MenuKey, MenuKey];
}

export const DISCS: Readonly<Record<string, DiscConfig>> = {
  A_NEW_ERA: { script: 'a_new_era.play', hevc: true, tapPoint: [960, 540], cycle: ['right', 'left'] },
  RENTAL_FAMILY: { script: 'rental_family.play', hevc: false, tapPoint: [960, 540], cycle: ['right', 'left'] },
};

export interface PlanStep {
  readonly n: number;
  readonly step: KeyStep;
  /** libbluray's settled plane at this `wait still` step; null for other steps. */
  readonly hash: string | null;
}

export interface GatePlan {
  readonly steps: readonly PlanStep[];
  /** Index of the step the stay runs before: the script's last key (the one that starts the feature). */
  readonly stayBefore: number;
  /** The settled hash the menu must return to after the stay: the last `wait still` before that key. */
  readonly stayHash: string | null;
  /** libbluray's last flushed plane. */
  readonly endHash: string | null;
}

/** Pairs a key script's steps with the golden's settled hashes, checking that both name the same steps. */
export function buildPlan(keysSource: string, goldenSource: string): GatePlan {
  const parsed = parseKeyScript(keysSource);
  const golden = new Map<number, { step: string; hash?: string }>();
  let endHash: string | null = null;
  for (const line of goldenSource.split('\n')) {
    if (!line.trim()) continue;
    const e = JSON.parse(line) as { script?: string; n?: number; step?: string; hash?: string };
    if (e.script === 'step' && e.n !== undefined && e.step !== undefined) golden.set(e.n, { step: e.step, hash: e.hash });
    else if (e.script === 'end') endHash = e.hash ?? null;
  }
  const steps = parsed.map((step, n): PlanStep => {
    const g = golden.get(n);
    if (!g || g.step !== step.text) throw new Error(`golden step ${n} is "${g?.step ?? 'missing'}", the script's is "${step.text}"`);
    return { n, step, hash: step.kind === 'waitStill' ? (g.hash ?? null) : null };
  });
  if (golden.size !== steps.length) throw new Error(`the golden has ${golden.size} steps, the script ${steps.length}`);
  const stayBefore = steps.map((s) => s.step.kind).lastIndexOf('key');
  if (stayBefore < 0) throw new Error('the script has no key step');
  const still = steps.slice(0, stayBefore).reverse().find((s) => s.step.kind === 'waitStill');
  return { steps, stayBefore, stayHash: still?.hash ?? null, endHash };
}

export function loadPlan(disc: string): GatePlan {
  const cfg = DISCS[disc];
  if (!cfg) throw new Error(`no gate plan for ${disc} (known: ${Object.keys(DISCS).join(', ')})`);
  return buildPlan(readFileSync(join(REPO, `tests/bdj/scripts/${cfg.script}.keys`), 'utf8'), readFileSync(join(REPO, `tests/bdj/golden/local/${cfg.script}.jsonl`), 'utf8'));
}

/** Median and max of a list (null when empty). */
export function stats(values: readonly number[]): { n: number; median: number; max: number; min: number } | null {
  if (values.length === 0) return null;
  const s = [...values].sort((a, b) => a - b);
  const mid = s.length >> 1;
  return { n: s.length, median: s.length % 2 ? s[mid]! : (s[mid - 1]! + s[mid]!) / 2, max: s.at(-1)!, min: s[0]! };
}

// ---------------------------------------------------------------------------------------------------------------------
// Options

export interface GateOptions {
  target: string;
  discs: string[];
  stayMs: number;
  cycleMs: number;
  sampleMs: number;
  startupRuns: number;
  server: string | null;
  token: string | null;
  port: number;
  roots: string[];
  dist: string;
  out: string;
  headless: boolean;
  touch: boolean;
  tag: string | null;
  callTimeoutMs: number;
}

const USAGE =
  'usage: gate.ts --target <sim:<name>|ios:<udid>|udid|chrome|firefox|firefox-pw|webkit|safari> [--disc <name>]… [--stay-ms ms] [--cycle-ms ms] [--sample-ms ms] ' +
  '[--startup-runs n] [--server origin --token t | --port n --root dir --dist dir] [--headless] [--touch] [--out dir] [--tag text] [--call-timeout ms]';

export function parseGateArgs(argv: readonly string[]): GateOptions {
  const o: GateOptions = {
    target: '', discs: [], stayMs: 600_000, cycleMs: 3000, sampleMs: 30_000, startupRuns: 0, server: null, token: null, port: 4183,
    roots: [], dist: join(REPO, 'dist'), out: DEFAULT_OUT, headless: false, touch: false, tag: null, callTimeoutMs: 120_000,
  };
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i]!;
    if (flag === '--headless') { o.headless = true; continue; }
    if (flag === '--touch') { o.touch = true; continue; }
    const v = argv[++i];
    if (v === undefined) throw new Error(`${flag} needs a value\n${USAGE}`);
    switch (flag) {
      case '--target': o.target = v; break;
      case '--disc': o.discs.push(v); break;
      case '--stay-ms': o.stayMs = v === '0' ? 0 : parseMs(flag, v); break;
      case '--cycle-ms': o.cycleMs = parseMs(flag, v); break;
      case '--sample-ms': o.sampleMs = parseMs(flag, v); break;
      case '--startup-runs': o.startupRuns = v === '0' ? 0 : parseMs(flag, v); break;
      case '--server': o.server = v.replace(/\/+$/, ''); break;
      case '--token': o.token = v; break;
      case '--port': o.port = parseMs(flag, v); break;
      case '--root': o.roots.push(v); break;
      case '--dist': o.dist = v; break;
      case '--out': o.out = v; break;
      case '--tag': o.tag = v; break;
      case '--call-timeout': o.callTimeoutMs = parseMs(flag, v); break;
      default: throw new Error(`unknown option ${flag}\n${USAGE}`);
    }
  }
  if (!o.target) throw new Error(USAGE);
  if ((o.server === null) !== (o.token === null)) throw new Error('--server and --token go together');
  if (o.discs.length === 0) o.discs = Object.keys(DISCS);
  for (const d of o.discs) if (!DISCS[d]) throw new Error(`no gate plan for ${d} (known: ${Object.keys(DISCS).join(', ')})`);
  if (o.roots.length === 0) o.roots.push(join(REPO, 'fixtures/local'));
  return o;
}

// ---------------------------------------------------------------------------------------------------------------------
// Drivers: one page in one browser or device

export interface GateDriver {
  readonly touch: boolean;
  /** What drove the browser, for the result. */
  readonly via: string;
  open(url: string): Promise<void>;
  evaluate<T>(expression: string): Promise<T>;
  evaluateAsync<T>(expression: string): Promise<T>;
  /** A touch on a touch target, a mouse click otherwise, at page (CSS viewport) coordinates. */
  tap(x: number, y: number): Promise<void>;
  /** A touch held for `ms` at page coordinates (touch targets whose driver can hold one). */
  longPress?(x: number, y: number, ms: number): Promise<void>;
  /** A key on the keyboard (computers only). */
  press(key: MenuKey): Promise<void>;
  /** A click on the first element `selector` matches, where coordinates are not enough (Safari on the Mac). */
  click?(selector: string): Promise<void>;
  screenshot(out: string): Promise<void>;
  consoleLog(): Promise<string[]>;
  close(): Promise<void>;
}

const PW_KEYS: Partial<Record<MenuKey, string>> = { up: 'ArrowUp', down: 'ArrowDown', left: 'ArrowLeft', right: 'ArrowRight', ok: 'Enter' };
const WD_KEYS: Partial<Record<MenuKey, string>> = { up: '', down: '', left: '', right: '', ok: '' };

class AppiumDriver implements GateDriver {
  readonly touch = true;
  private constructor(
    private readonly session: DeviceSession,
    private readonly stopAppium: () => void,
    readonly via: string,
  ) {}

  static async start(device: string, callTimeoutMs: number): Promise<AppiumDriver> {
    const target = await resolveDevice(device);
    const stop = await ensureAppium();
    try {
      const session = await DeviceSession.start(target, { appiumUrl: APPIUM_URL, callTimeoutMs }, safariCaps(target));
      return new AppiumDriver(session, stop, `Appium XCUITest, Safari on ${target.simulator ? 'Simulator ' : ''}${target.name}`);
    } catch (err) {
      stop();
      throw err;
    }
  }

  open(url: string): Promise<void> { return this.session.open(url); }
  evaluate<T>(e: string): Promise<T> { return this.session.evaluate<T>(e); }
  evaluateAsync<T>(e: string): Promise<T> { return this.session.evaluateAsync<T>(e); }
  tap(x: number, y: number): Promise<void> { return this.session.tap(x, y); }
  press(): Promise<void> { return Promise.reject(new Error('no keyboard on a touch device: use the remote')); }
  screenshot(out: string): Promise<void> { return this.session.screenshot(out); }
  consoleLog(): Promise<string[]> { return this.session.consoleLog(); }
  async close(): Promise<void> {
    await this.session.close();
    this.stopAppium();
  }
}

type PwModule = typeof import('@playwright/test');
type PwBrowser = Awaited<ReturnType<PwModule['chromium']['launch']>>;
type PwPage = Awaited<ReturnType<PwBrowser['newPage']>>;

class PlaywrightDriver implements GateDriver {
  private readonly log: string[] = [];
  private constructor(
    private readonly browser: PwBrowser,
    private readonly page: PwPage,
    readonly touch: boolean,
    readonly via: string,
  ) {
    page.on('console', (m) => this.log.push(`${new Date().toISOString()} ${m.type()} ${m.text()}`));
    page.on('crash', () => this.log.push(`${new Date().toISOString()} PAGE CRASHED`));
  }

  static async start(kind: string, headless: boolean, touch: boolean): Promise<PlaywrightDriver> {
    const pw = await import('@playwright/test');
    let browser: PwBrowser;
    if (kind === 'chrome') browser = await pw.chromium.launch({ channel: 'chrome', headless });
    else if (kind === 'firefox') browser = await pw.firefox.launch({ channel: 'moz-firefox', headless });
    else if (kind === 'firefox-pw') browser = await pw.firefox.launch({ headless, firefoxUserPrefs: { 'media.autoplay.default': 0 } });
    else browser = await pw.webkit.launch({ headless });
    const device = touch ? pw.devices['Pixel 7'] : {};
    // as the E2E projects: the service worker's precache would compete with the start-up being measured
    const context = await browser.newContext({ ...device, ...(kind.startsWith('firefox') ? { isMobile: undefined } : {}), serviceWorkers: 'block' });
    const page = await context.newPage();
    const name = kind === 'chrome' ? 'Google Chrome' : kind === 'firefox' ? 'Firefox' : kind === 'firefox-pw' ? "Playwright's Firefox" : "Playwright's WebKit";
    const how = kind === 'firefox' ? 'Playwright over WebDriver BiDi' : 'Playwright';
    return new PlaywrightDriver(browser, page, touch, `${how}, ${name} ${browser.version()}${headless ? ' (headless)' : ''}${touch ? ', Pixel 7 emulation' : ''}`);
  }

  async open(url: string): Promise<void> { await this.page.goto(url); }
  evaluate<T>(e: string): Promise<T> { return this.page.evaluate(`(${e})`) as Promise<T>; }
  evaluateAsync<T>(e: string): Promise<T> { return this.page.evaluate(`Promise.resolve(${e})`) as Promise<T>; }
  async tap(x: number, y: number): Promise<void> {
    if (this.touch) await this.page.touchscreen.tap(x, y);
    else await this.page.mouse.click(x, y);
  }
  /** A held touch through the DevTools Protocol (Chrome's touch emulation: pointerType 'touch'). */
  async longPress(x: number, y: number, ms: number): Promise<void> {
    const cdp = await this.page.context().newCDPSession(this.page);
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y }] });
    await sleep(ms);
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    await cdp.detach();
  }
  async press(key: MenuKey): Promise<void> {
    const k = PW_KEYS[key];
    if (!k) throw new Error(`no keyboard key for ${key}`);
    await this.page.keyboard.press(k);
  }
  async screenshot(out: string): Promise<void> { write(out, await this.page.screenshot()); }
  async consoleLog(): Promise<string[]> { return [...this.log]; }
  async close(): Promise<void> { await this.browser.close(); }
}

/**
 * Safari through safaridriver, as plain W3C WebDriver: on this Mac (mouse and keyboard), or on a real iPhone or iPad
 * whose Web Inspector and Remote Automation are on (touch). iPadOS 27: an element click never lifts the finger and
 * several taps in one action list merge into one, so every tap is its own pointer action, released after.
 */
class SafariDriver implements GateDriver {
  private constructor(
    private readonly child: ChildProcess,
    private readonly base: string,
    readonly via: string,
    /** The real device's UDID; null for Safari on this Mac. */
    private readonly udid: string | null,
  ) {}

  get touch(): boolean {
    return this.udid !== null;
  }

  static async start(port: number, udid: string | null): Promise<SafariDriver> {
    // with the Mac's screen locked, safaridriver opens pages but never delivers a click or a key (the call hangs)
    if (!udid && (await screenLocked())) throw new Error('the Mac\'s screen is locked: safaridriver cannot deliver input to Safari; unlock it and run again');
    const child = spawn('safaridriver', ['-p', String(port)], { stdio: 'ignore' });
    const root = `http://127.0.0.1:${port}`;
    try {
      for (let i = 0; ; i++) {
        const ok = await fetch(`${root}/status`).then((r) => r.ok, () => false);
        if (ok) break;
        if (i > 50) throw new Error('safaridriver did not start');
        await sleep(200);
      }
      const r = await fetch(`${root}/session`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ capabilities: { alwaysMatch: udid ? { browserName: 'Safari', platformName: 'iOS', 'safari:deviceUDID': udid } : { browserName: 'safari' } } }) });
      const body = (await r.json()) as { value: { sessionId?: string; message?: string; capabilities?: { browserVersion?: string } } };
      if (!body.value.sessionId) throw new Error(`Safari automation refused: ${body.value.message ?? r.status} (enable Develop → Allow Remote Automation, or run safaridriver --enable)`);
      const where = udid ? ` on the device ${udid.slice(0, 8)}…` : ' on this Mac';
      const d = new SafariDriver(child, `${root}/session/${body.value.sessionId}`, `safaridriver (W3C WebDriver), Safari ${body.value.capabilities?.browserVersion ?? '?'}${where}`, udid);
      await d.call('POST', '/timeouts', { script: 60_000, pageLoad: 120_000 });
      if (!udid) await d.call('POST', '/window/rect', { width: 1280, height: 860 }).catch(() => undefined);
      return d;
    } catch (err) {
      child.kill();
      throw err;
    }
  }

  private async call<T>(method: string, path: string, payload?: unknown): Promise<T> {
    const r = await fetch(`${this.base}${path}`, {
      method,
      headers: payload === undefined ? {} : { 'content-type': 'application/json' },
      body: payload === undefined ? undefined : JSON.stringify(payload),
      signal: AbortSignal.timeout(130_000),
    });
    const body = (await r.json().catch(() => ({ value: null }))) as { value: unknown };
    if (!r.ok) throw new Error(`${method} ${path}: ${JSON.stringify(body.value).slice(0, 300)}`);
    return body.value as T;
  }

  async open(url: string): Promise<void> {
    await this.call('POST', '/url', { url });
    // safaridriver stops delivering input to a Safari window that is not frontmost
    if (!this.udid) await new Promise<void>((res) => execFile('osascript', ['-e', 'tell application "Safari" to activate'], () => res()));
  }
  evaluate<T>(e: string): Promise<T> { return this.call<T>('POST', '/execute/sync', { script: `return (${e});`, args: [] }); }
  async evaluateAsync<T>(e: string): Promise<T> {
    const script = `const done = arguments[arguments.length - 1]; Promise.resolve().then(() => (${e})).then((value) => done({ value }), (err) => done({ error: String(err) }));`;
    const r = await this.call<{ value?: T; error?: string }>('POST', '/execute/async', { script, args: [] });
    if (r.error !== undefined) throw new Error(r.error);
    return r.value as T;
  }
  async tap(x: number, y: number): Promise<void> {
    await this.call('POST', '/actions', {
      actions: [{
        type: 'pointer', id: this.udid ? 'finger' : 'mouse', parameters: { pointerType: this.udid ? 'touch' : 'mouse' },
        actions: [
          { type: 'pointerMove', x: Math.round(x), y: Math.round(y), origin: 'viewport', duration: 0 },
          { type: 'pointerDown', button: 0 },
          { type: 'pause', duration: TAP_HOLD_MS }, // a finger stays down a moment: a zero-length touch is not a person's
          { type: 'pointerUp', button: 0 },
        ],
      }],
    });
    await this.call('DELETE', '/actions').catch(() => undefined);
  }
  async longPress(x: number, y: number, ms: number): Promise<void> {
    if (!this.udid) throw new Error('a long press is a touch: only on a device');
    await this.call('POST', '/actions', {
      actions: [{
        type: 'pointer', id: 'finger', parameters: { pointerType: 'touch' },
        actions: [
          { type: 'pointerMove', x: Math.round(x), y: Math.round(y), origin: 'viewport', duration: 0 },
          { type: 'pointerDown', button: 0 },
          { type: 'pause', duration: ms },
          { type: 'pointerUp', button: 0 },
        ],
      }],
    });
    await this.call('DELETE', '/actions').catch(() => undefined);
  }
  /** Element click: Safari on the Mac. (On iPadOS 27 an element click never lifts the finger: see tap.) */
  async click(selector: string): Promise<void> {
    if (this.udid) throw new Error('element clicks are unreliable on iOS: tap instead');
    const el = await this.call<Record<string, string>>('POST', '/element', { using: 'css selector', value: selector });
    await this.call('POST', `/element/${Object.values(el)[0]}/click`, {});
  }
  async press(key: MenuKey): Promise<void> {
    if (this.udid) throw new Error('no keyboard on a touch device: use the remote');
    const value = WD_KEYS[key];
    if (!value) throw new Error(`no keyboard key for ${key}`);
    await this.call('POST', '/actions', { actions: [{ type: 'key', id: 'keyboard', actions: [{ type: 'keyDown', value }, { type: 'keyUp', value }] }] });
    await this.call('DELETE', '/actions').catch(() => undefined);
  }
  async screenshot(out: string): Promise<void> { write(out, Buffer.from(await this.call<string>('GET', '/screenshot'), 'base64')); }
  async consoleLog(): Promise<string[]> { return []; }
  async close(): Promise<void> {
    await fetch(this.base, { method: 'DELETE', signal: AbortSignal.timeout(10_000) }).catch(() => undefined);
    this.child.kill();
  }
}

/** The Mac's login session reports a locked screen (ioreg's CGSSessionScreenIsLocked). */
function screenLocked(): Promise<boolean> {
  return new Promise((res) => execFile('ioreg', ['-n', 'Root', '-d1', '-a'], (err, out) => res(!err && /<key>CGSSessionScreenIsLocked<\/key>\s*<true\/>/.test(out))));
}

export interface DriverOptions {
  /** safaridriver's port (ios:<udid> and safari). */
  readonly driverPort: number;
  readonly headless: boolean;
  readonly touch: boolean;
  /** Appium's per-call timeout. */
  readonly callTimeoutMs: number;
}

/** A driver for one target (see the targets above); live-check.ts uses it too. */
export function startTargetDriver(target: string, o: DriverOptions): Promise<GateDriver> {
  if (target.startsWith('ios:')) return SafariDriver.start(o.driverPort, target.slice(4));
  if (target.startsWith('sim:') || /^[0-9A-Fa-f-]{20,}$/.test(target)) return AppiumDriver.start(target, o.callTimeoutMs);
  if (['chrome', 'firefox', 'firefox-pw', 'webkit'].includes(target)) return PlaywrightDriver.start(target, o.headless, o.touch);
  if (target === 'safari') return SafariDriver.start(o.driverPort, null);
  throw new Error(`unknown target ${target}\n${USAGE}`);
}

function startDriver(o: GateOptions): Promise<GateDriver> {
  return startTargetDriver(o.target, { driverPort: o.port + 1, headless: o.headless, touch: o.touch, callTimeoutMs: o.callTimeoutMs });
}

// ---------------------------------------------------------------------------------------------------------------------
// The page, through a driver: every poll checks the page is still the one the gate opened

interface Telemetry {
  clockUs?: number;
  framesPresented?: number;
  decoderErrors?: number;
  bdj?: { bootMs: number | null; firstPlaylistMs: number | null; firstFrameMs: number | null; inputLatencyMs: { last: number; max: number; count: number } | null } | null;
  bdjPlane?: { flushes: number; tapsIgnored: number; hash?: string | null } | null;
  bdjMemory?: unknown;
}

interface Snapshot {
  t: Telemetry | null;
  playlist: string | null;
  bdjMenu: string | null;
  state: string | null;
}

const SNAPSHOT =
  "(() => { const p = document.querySelector('[data-testid=player]'); return { t: window.__blurayTelemetry ?? null," +
  " playlist: p?.getAttribute('data-playlist') ?? null, bdjMenu: p?.getAttribute('data-bdj-menu') ?? null, state: p?.getAttribute('data-state') ?? null }; })()";

const firstVisibleExpr = (sel: string): string => `[...document.querySelectorAll(${JSON.stringify(sel)})].find((x) => x.getClientRects().length > 0)`;

const visibleExpr = (sel: string): string =>
  `(() => { const e = ${firstVisibleExpr(sel)}; if (!e) return null;` +
  ` const r = e.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; })()`;

/** Whether the control bar is shown: an idled-out bar (class hidden) still has a box, but its buttons take no taps. */
const BAR_SHOWN = "(() => { const b = document.querySelector('[data-testid=control-bar]'); return !!b && !b.classList.contains('hidden'); })()";

/** A point in a band of the canvas off the 1920x1080 picture (top letterbox, else left pillarbox), or null. */
export const BAND_POINT =
  "(() => { const r = document.querySelector('[data-testid=video-canvas]').getBoundingClientRect(); const s = Math.min(r.width / 1920, r.height / 1080);" +
  ' const top = (r.height - 1080 * s) / 2; const left = (r.width - 1920 * s) / 2;' +
  ' return top > 12 ? { x: r.x + r.width / 2, y: r.y + top / 2 } : left > 12 ? { x: r.x + left / 2, y: r.y + r.height / 2 } : null; })()';

export class Page {
  private marker = '';
  /** `log` takes the page's notes: a touch that missed, a page that would not settle. */
  constructor(readonly d: GateDriver, private readonly log: (line: string) => void = (line) => console.error(line)) {}

  async open(url: string): Promise<void> {
    await this.d.open(url);
    this.marker = randomBytes(8).toString('hex');
    await this.d.evaluate(`(window.__gateMarker = ${JSON.stringify(this.marker)}, true)`);
  }

  /** Evaluates `expression`, failing with PageReloadedError when the page is no longer the one opened. */
  async probe<T>(expression: string, during: string): Promise<T> {
    const r = await this.d.evaluate<{ same: boolean; v?: T; error?: string }>(
      `(() => { const same = window.__gateMarker === ${JSON.stringify(this.marker)}; try { return { same, v: (${expression}) }; } catch (e) { return { same, error: String(e) }; } })()`,
    );
    if (!r.same) throw new PageReloadedError(during);
    if (r.error !== undefined) throw new Error(`${during}: ${r.error}`);
    return r.v as T;
  }

  snapshot(during: string): Promise<Snapshot> { return this.probe<Snapshot>(SNAPSHOT, during); }

  async until<T>(expression: string, during: string, timeoutMs: number, pollMs = 200): Promise<T> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const v = await this.probe<T>(expression, during).catch((err: unknown) => {
        if (err instanceof PageReloadedError) throw err;
        return null;
      });
      if (v) return v;
      if (Date.now() > deadline) throw new Error(`${during}: not reached in ${timeoutMs} ms`);
      await sleep(pollMs);
    }
  }

  /**
   * Reads the page's layout (and `selector`'s box) until it holds still, scrolling the target into view first when it
   * is off screen (tap.ts). A layout that never settles in time is used as last read, and logged.
   */
  async settle(selector: string | null, during: string): Promise<LayoutReading> {
    let first = true;
    const s = await waitSettled(() => {
      const scroll = first && selector !== null;
      first = false;
      return this.probe<LayoutReading>(layoutExpr(selector, scroll), during);
    }, sameLayout);
    if (!s.settled) this.log(`${during}: the page was still moving after ${s.waitedMs} ms; tapping where it was last`);
    return s.value;
  }

  /**
   * A tap at a page point, checked by a listener in the page: says whether a touch arrived there, and logs a miss.
   * `locate` reads the point from the page once it has stopped moving (a point read before could be stale); null
   * when there is none, and nothing is tapped.
   */
  async tapAt(locate: () => Promise<{ x: number; y: number } | null>, during: string): Promise<{ x: number; y: number; verdict: TapVerdict } | null> {
    await this.settle(null, during);
    const p = await locate();
    if (!p) return null;
    const verdict = await this.tapChecked({ x: p.x, y: p.y, selector: null }, during, () => this.d.tap(p.x, p.y));
    return { ...p, verdict };
  }

  /**
   * Taps (clicks) the centre of the first visible element matching `selector`, once it is on screen and the page has
   * stopped moving, its box read after that. Says whether the touch reached it, and logs a miss.
   */
  async tapOn(selector: string, during: string): Promise<TapVerdict> {
    await this.until<{ x: number; y: number }>(visibleExpr(selector), during, 30_000);
    const r = await this.settle(selector, during);
    const p = centreOf(r) ?? (await this.until<{ x: number; y: number }>(visibleExpr(selector), during, 30_000));
    const aim: TapAim = { x: p.x, y: p.y, selector };
    const click = this.d.click && !this.d.touch ? this.d.click.bind(this.d) : null;
    return this.tapChecked(aim, during, () => (click ? click(selector) : this.d.tap(p.x, p.y)));
  }

  /**
   * A real touch on `selector`, tried `touches` times while it misses, then a DOM click, logged: for inputs that must
   * arrive but need no user gesture (the remote's keys). Says which reached it.
   */
  async tapOnOrClick(selector: string, during: string, touches = 2): Promise<'touch' | 'click'> {
    for (let i = 0; i < touches; i++) {
      if ((await this.tapOn(selector, during)).landed) return 'touch';
    }
    this.log(`${during}: ${touches} touches missed; clicking it in the DOM`);
    await this.until<boolean>(`(() => { const e = ${firstVisibleExpr(selector)}; if (!e) return false; e.click(); return true; })()`, during, 30_000);
    return 'click';
  }

  private async tapChecked(aim: TapAim, during: string, tap: () => Promise<void>): Promise<TapVerdict> {
    await this.probe<boolean>(armExpr(aim.selector), during);
    await tap();
    // the event can reach the page a little after the driver's call returns (a device's round trip)
    let landing: TapLanding | null = null;
    for (let i = 0; i < 6 && !landing; i++) {
      landing = await this.probe<TapLanding | null>(LANDING_EXPR, during).catch((err: unknown) => {
        if (err instanceof PageReloadedError) throw err;
        return null;
      });
      if (!landing) await sleep(80);
    }
    if (!landing) await this.probe<boolean>(DISARM_EXPR, during).catch(() => undefined);
    const v = tapVerdict(aim, landing);
    if (!v.landed) this.log(`${during}: the touch missed: ${v.note}`);
    return v;
  }

  visible(selector: string, during: string): Promise<{ x: number; y: number } | null> { return this.probe(visibleExpr(selector), during); }

  /** Page coordinates of a point of the 1920x1080 plane, as the player letterboxes it in the video canvas. */
  planePoint(x: number, y: number, during: string): Promise<{ x: number; y: number }> {
    return this.probe(
      `(() => { const r = document.querySelector('[data-testid=video-canvas]').getBoundingClientRect(); const s = Math.min(r.width / 1920, r.height / 1080);` +
        ` return { x: r.x + (r.width - 1920 * s) / 2 + ${x} * s, y: r.y + (r.height - 1080 * s) / 2 + ${y} * s }; })()`,
      during,
    );
  }
}

// ---------------------------------------------------------------------------------------------------------------------
// One disc on one target

interface InputRecord {
  key: MenuKey;
  via: 'keyboard' | 'remote';
  /** bdj.inputLatencyMs.last when the input was answered within 6 s; null when nothing changed. */
  latencyMs: number | null;
  during: 'script' | 'stay';
}

interface StepRecord {
  n: number;
  step: string;
  ms: number;
  expected?: string | null;
  actual?: string | null;
  ok: boolean;
  note?: string;
}

interface MemorySample {
  atMs: number;
  bdjMemory: unknown;
  jsHeapBytes: number | null;
  playlist: string | null;
}

/** The gate's first tap on the menu, as it happened. */
export interface FirstTap {
  tapsIgnoredBefore: number;
  tapsIgnoredAfter: number;
  /** Whether the engine counted the tap as ignored by the disc (bdjPlane.tapsIgnored grew). */
  ignored: boolean;
  /** What was under the tap point just before the tap (a data-testid or a class): the canvas, or what took it. */
  tapTarget: string | null;
  remoteOpened: boolean;
  how: string;
}

/** What openRemote needs from the page on a touch target (the gate's Page; a model in gate.test.ts). */
export interface RemoteOps {
  remoteOpen(): Promise<boolean>;
  tapsIgnored(): Promise<number>;
  /** Taps the menu at the disc's tap point; returns what was under it (see FirstTap.tapTarget). */
  tapMenu(): Promise<string | null>;
  /** Waits up to `ms` for the remote to show; whether it did. */
  waitRemote(ms: number): Promise<boolean>;
  /** Whether the control bar is shown, so its buttons take taps (an idled-out bar lets them fall through). */
  barShown(): Promise<boolean>;
  /** Shows the controls without reaching the disc (a tap off the picture, or a long press); says how. */
  showControls(): Promise<string>;
  tapRemoteToggle(): Promise<void>;
}

/** How long the first tap is given to open the remote: the ignored-tap window and the engine's telemetry, with margin. */
const FIRST_TAP_WAIT_MS = 4000;
/** How long a tap on the Remote toggle is given. */
const TOGGLE_WAIT_MS = 3000;

/**
 * Makes sure the on-screen remote shows (touch targets): a tap on the menu that the disc ignores opens it (5d spec §4.2);
 * otherwise the controls are shown first (they idle out after 3 s, and an idled-out bar lets a tap on its Remote button
 * fall through to the picture) and the Remote button is tapped, checking each time that the remote is not already open
 * (a second tap would close it). Returns the first tap as it happened, or null when the remote was already open.
 */
export async function openRemote(ops: RemoteOps, tries = 3): Promise<FirstTap | null> {
  if (await ops.remoteOpen()) return null;
  const before = await ops.tapsIgnored();
  const tapTarget = await ops.tapMenu();
  let opened = await ops.waitRemote(FIRST_TAP_WAIT_MS);
  const after = await ops.tapsIgnored();
  const ignored = after > before;
  let how = 'tap on the menu, ignored by the disc';
  const tried: string[] = [];
  for (let i = 0; !opened && i < tries; i++) {
    if (await ops.remoteOpen()) {
      opened = true;
      how = 'tap on the menu, ignored by the disc (the remote opened late)';
      break;
    }
    let shown = 'controls already shown';
    if (!(await ops.barShown())) shown = `controls shown by ${await ops.showControls()}`;
    if (!(await ops.barShown())) {
      tried.push(`${shown}, but the bar stayed hidden`);
      continue;
    }
    await ops.tapRemoteToggle();
    opened = await ops.waitRemote(TOGGLE_WAIT_MS);
    how = `Remote button in the controls (${shown}; the first tap ${ignored ? 'was' : 'was not'} counted as ignored)`;
    if (!opened) tried.push(`${shown}, Remote tapped, no remote`);
  }
  if (!opened) {
    throw new Error(
      `the remote did not open: the first tap (on ${tapTarget ?? 'nothing'}) was ${ignored ? '' : 'not '}counted as ignored, then ${tried.join('; ') || 'nothing'}`,
    );
  }
  return { tapsIgnoredBefore: before, tapsIgnoredAfter: after, ignored, tapTarget, remoteOpened: opened, how };
}

/**
 * The page operations openRemote needs, on a gate Page. `tapPoint` is the plane point (1920x1080) the first tap goes to:
 * a point the disc ignores, so the tap opens the remote (5d spec §4.2).
 */
export function remoteOpsFor(page: Page, tapPoint: readonly [number, number]): RemoteOps {
  const remoteShown = "!!document.querySelector('[data-testid=remote-pad]')";
  return {
    remoteOpen: async () => page.probe<boolean>(remoteShown, 'the remote'),
    tapsIgnored: async () => (await page.snapshot('the remote')).t?.bdjPlane?.tapsIgnored ?? 0,
    tapMenu: async () => {
      const [px, py] = tapPoint;
      let target: string | null = null;
      await page.tapAt(async () => {
        const p = await page.planePoint(px, py, 'a tap on the menu');
        // what the tap will land on: the canvas, or something over it (the buffering spinner took it on the iPhone)
        target = await page.probe<string | null>(
          `(() => { const e = document.elementFromPoint(${p.x}, ${p.y}); return e ? (e.getAttribute('data-testid') ?? (e.className || e.tagName.toLowerCase())) : null; })()`,
          'a tap on the menu',
        );
        return p;
      }, 'a tap on the menu');
      return target;
    },
    waitRemote: async (ms) =>
      page.until<boolean>(remoteShown, 'the remote', ms).catch((err: unknown) => {
        if (err instanceof PageReloadedError) throw err;
        return false;
      }),
    barShown: async () => page.probe<boolean>(BAR_SHOWN, 'the controls'),
    showControls: async () => {
      // a tap off the picture (a letterbox or pillarbox band) shows the controls without reaching the disc (R13, R14);
      // where the picture fills the canvas, a long press does (R15)
      const band = await page.tapAt(() => page.probe<{ x: number; y: number } | null>(BAND_POINT, 'the letterbox'), 'a tap off the picture');
      let how: string;
      if (band) {
        how = 'a tap off the picture';
      } else if (page.d.longPress) {
        const [px, py] = tapPoint;
        await page.settle(null, 'a long press on the menu');
        const p = await page.planePoint(px, py, 'a long press on the menu');
        await page.d.longPress(p.x, p.y, 800);
        how = 'a long press';
      } else {
        return 'nothing (no band and no long press on this driver)';
      }
      await page.until<boolean>(BAR_SHOWN, 'the controls', 1500).catch((err: unknown) => {
        if (err instanceof PageReloadedError) throw err;
        return false;
      });
      return how;
    },
    tapRemoteToggle: async () => {
      await page.tapOn('[data-testid=remote-toggle]', 'the remote button');
    },
  };
}

export interface GateResult {
  target: string;
  via: string;
  disc: string;
  tag: string | null;
  startedAt: string;
  finishedAt?: string;
  input: 'keyboard' | 'touch';
  environment?: unknown;
  hevc?: unknown;
  startupRuns: Array<{ run: number; bootMs: number | null; firstPlaylistMs: number | null; firstFrameMs: number | null }>;
  startup?: { bootMs: number | null; firstPlaylistMs: number | null; firstFrameMs: number | null };
  steps: StepRecord[];
  inputs: InputRecord[];
  firstTap?: FirstTap;
  latency: { telemetry: unknown; script: ReturnType<typeof stats>; stay: ReturnType<typeof stats>; all: ReturnType<typeof stats> } | null;
  stay?: { ms: number; inputs: number; answered: number; hashAfter: string | null; expected: string | null; ok: boolean };
  memory: MemorySample[];
  end?: { expected: string | null; actual: string | null; ok: boolean; playlist: string | null; framesPresented: number | null; decoderErrors: number | null };
  reloaded: boolean;
  skipped?: string;
  error?: string;
  /** On an error: what the page showed (state, playlist, error banner, notices, telemetry). */
  diagnostics?: unknown;
  pass: boolean;
  console?: string[];
}

const pad5 = (n: number): string => String(n).padStart(5, '0');

class DiscRun {
  readonly r: GateResult;
  private readonly t0 = Date.now();

  constructor(
    private readonly page: Page,
    private readonly o: GateOptions,
    readonly disc: string,
    private readonly cfg: DiscConfig,
    private readonly url: string,
    private readonly shots: string,
  ) {
    this.r = {
      target: o.target, via: page.d.via, disc, tag: o.tag, startedAt: new Date().toISOString(), input: page.d.touch ? 'touch' : 'keyboard',
      startupRuns: [], steps: [], inputs: [], latency: null, memory: [], reloaded: false, pass: false,
    };
  }

  private log(msg: string): void { console.error(`[${((Date.now() - this.t0) / 1000).toFixed(1)} s] ${this.disc}: ${msg}`); }

  /** Opens the disc: the landing page, then a tap or click on the disc server's button for it; then the first frame. */
  private async openToFirstFrame(): Promise<NonNullable<GateResult['startup']>> {
    await this.page.open(this.url);
    await this.page.tapOn('[data-testid=server-discs] button:not([disabled])', 'the disc button');
    const ff = await this.page.until<number>('window.__blurayTelemetry?.bdj?.firstFrameMs ?? null', 'the first frame of Java\'s first playlist', 90_000);
    const b = (await this.page.snapshot('start-up')).t?.bdj;
    return { bootMs: b?.bootMs ?? null, firstPlaylistMs: b?.firstPlaylistMs ?? null, firstFrameMs: b?.firstFrameMs ?? ff };
  }

  private async sample(): Promise<void> {
    const s = await this.page.probe<{ m: unknown; heap: number | null; playlist: string | null }>(
      "({ m: window.__blurayTelemetry?.bdjMemory ?? null, heap: performance.memory?.usedJSHeapSize ?? null, playlist: document.querySelector('[data-testid=player]')?.getAttribute('data-playlist') ?? null })",
      'a memory sample',
    );
    this.r.memory.push({ atMs: Date.now() - this.t0, bdjMemory: s.m, jsHeapBytes: s.heap, playlist: s.playlist });
  }

  /**
   * The harness's `wait still`: the plane has flushed since the step began (more than `after` flushes) and then not for
   * `quietMs`. The page sees playlist changes and flushes up to a telemetry interval late, and in a different order
   * than the harness sees the engine's events, so with a golden hash the step holds once the plane has settled on that
   * hash (as the E2E tests' settlesOn) and fails when it has not within 90 s; other planes it settled on on the way
   * are recorded in `seen`.
   */
  private async still(quietMs: number, expected: string | null, during: string, after: number, seen: string[] = []): Promise<string | null> {
    const deadline = Date.now() + 90_000;
    let last = -1;
    let since = Date.now();
    let hash: string | null = null;
    let settled = false;
    for (;;) {
      const snap = await this.page.snapshot(during);
      const f = snap.t?.bdjPlane?.flushes ?? 0;
      if (f !== last) {
        last = f;
        since = Date.now();
      }
      const quiet = Date.now() - since >= quietMs;
      const h = snap.t?.bdjPlane?.hash ?? null;
      if (quiet && h !== null) {
        hash = h;
        if (seen.at(-1) !== h) seen.push(h);
        if (expected !== null ? h === expected : f > after) return h;
      }
      settled ||= quiet && f > after;
      if (Date.now() > deadline) {
        this.log(`${during}: ${settled ? `settled on ${seen.join(', ') || 'no hash'}` : 'never settled'} in 90 s (expected ${expected})`);
        return hash;
      }
      await sleep(150);
    }
  }

  private async flushes(during: string): Promise<number> {
    return (await this.page.snapshot(during)).t?.bdjPlane?.flushes ?? 0;
  }

  /** On a touch target, makes sure the on-screen remote shows: a tap on the menu the disc ignores opens it. */
  private async ensureRemote(): Promise<void> {
    const ops = remoteOpsFor(this.page, this.cfg.tapPoint);
    const first = await openRemote(ops);
    if (!first) return;
    this.r.firstTap ??= first;
    this.log(`remote open (${first.how}; the tap landed on ${first.tapTarget})`);
  }

  private async input(key: MenuKey, during: 'script' | 'stay'): Promise<InputRecord> {
    const before = (await this.page.snapshot(`key ${key}`)).t?.bdj?.inputLatencyMs?.count ?? 0;
    if (this.page.d.touch) {
      await this.ensureRemote();
      await this.page.tapOnOrClick(`[data-testid=remote-${key}]`, `the remote's ${key}`);
    } else {
      await this.page.d.press(key);
    }
    const deadline = Date.now() + 6000; // telemetry drops an input unanswered for 5 s
    let latencyMs: number | null = null;
    while (Date.now() < deadline) {
      const l = (await this.page.snapshot(`key ${key}`)).t?.bdj?.inputLatencyMs;
      if (l && l.count > before) { latencyMs = l.last; break; }
      await sleep(50);
    }
    const rec: InputRecord = { key, via: this.page.d.touch ? 'remote' : 'keyboard', latencyMs, during };
    this.r.inputs.push(rec);
    return rec;
  }

  private async stay(hash: string | null): Promise<void> {
    const start = Date.now();
    const from = await this.flushes('the stay');
    const end = start + this.o.stayMs;
    let nextSample = start;
    let i = 0;
    this.log(`staying in the menu for ${this.o.stayMs / 1000} s`);
    while (Date.now() < end || i % 2 === 1) {
      if (Date.now() >= nextSample) {
        await this.sample();
        nextSample += this.o.sampleMs;
      }
      const t = Date.now();
      await this.input(this.cfg.cycle[i % 2]!, 'stay');
      i++;
      const wait = this.o.cycleMs - (Date.now() - t);
      if (wait > 0) await sleep(wait);
    }
    await this.sample();
    const after = await this.still(1500, hash, 'the menu after the stay', from);
    const stayInputs = this.r.inputs.filter((x) => x.during === 'stay');
    this.r.stay = { ms: Date.now() - start, inputs: stayInputs.length, answered: stayInputs.filter((x) => x.latencyMs !== null).length, hashAfter: after, expected: hash, ok: hash === null || after === hash };
    this.log(`stay done: ${stayInputs.length} inputs, plane ${after} (expected ${hash})`);
  }

  async run(plan: GatePlan): Promise<void> {
    for (let k = 0; k < this.o.startupRuns; k++) {
      const s = await this.openToFirstFrame();
      this.r.startupRuns.push({ run: k, ...s });
      this.log(`start-up run ${k}${k === 0 ? ' (cold)' : ''}: first frame ${s.firstFrameMs} ms`);
    }
    this.r.startup = await this.openToFirstFrame();
    this.log(`first frame ${this.r.startup.firstFrameMs} ms (boot ${this.r.startup.bootMs}, first playlist ${this.r.startup.firstPlaylistMs})`);
    await this.sample();
    // flushes when the step began, as the harness counts them (after a key, from the key on)
    let from = 0;
    for (const [idx, ps] of plan.steps.entries()) {
      if (idx === plan.stayBefore && this.o.stayMs > 0) await this.stay(plan.stayHash);
      const t = Date.now();
      const atStart = await this.flushes(ps.step.text);
      const s = ps.step;
      const rec: StepRecord = { n: ps.n, step: s.text, ms: 0, ok: true };
      switch (s.kind) {
        case 'waitPlaylist':
          // `wait playlist any`: some playlist is playing (the device page shows only the current one)
          await this.page.until(
            s.playlist === null
              ? `(document.querySelector('[data-testid=player]')?.getAttribute('data-playlist') ?? '') !== ''`
              : `document.querySelector('[data-testid=player]')?.getAttribute('data-playlist') === ${JSON.stringify(pad5(s.playlist))}`,
            s.text,
            180_000,
          );
          break;
        case 'waitFlush':
          await this.page.until(`(window.__blurayTelemetry?.bdjPlane?.flushes ?? 0) >= ${s.n}`, s.text, 90_000);
          break;
        case 'waitStill': {
          rec.expected = ps.hash;
          const seen: string[] = [];
          rec.actual = await this.still(s.ms, ps.hash, s.text, from, seen);
          if (seen.length > 1) rec.note = `settled on ${seen.join(', ')}`;
          rec.ok = ps.hash === null || rec.actual === ps.hash;
          await this.page.d.screenshot(`${this.shots}-step${ps.n}.png`).catch(() => undefined);
          break;
        }
        case 'key': {
          const i = await this.input(s.key, 'script');
          rec.note = `latency ${i.latencyMs ?? 'none'} ms`;
          break;
        }
        case 'pointer':
          throw new Error(`pointer steps are not in the gate's scripts (${s.text})`);
      }
      from = s.kind === 'key' ? atStart : await this.flushes(s.text);
      rec.ms = Date.now() - t;
      this.r.steps.push(rec);
      this.log(`${s.text}: ${rec.ok ? 'ok' : 'MISMATCH'}${rec.actual !== undefined ? ` ${rec.actual}` : ''}${rec.note ? ` (${rec.note})` : ''}`);
    }
    // libbluray's last plane: the feature with the menu gone
    const endHash = await this.still(1500, plan.endHash, 'the feature', -1);
    const snap = await this.page.snapshot('the end');
    this.r.end = { expected: plan.endHash, actual: endHash, ok: plan.endHash === null || endHash === plan.endHash, playlist: snap.playlist, framesPresented: snap.t?.framesPresented ?? null, decoderErrors: snap.t?.decoderErrors ?? null };
    await this.sample();
  }

  finish(): void {
    const l = this.r.inputs.map((x) => x.latencyMs).filter((x): x is number => x !== null);
    const of = (d: 'script' | 'stay'): number[] => this.r.inputs.filter((x) => x.during === d && x.latencyMs !== null).map((x) => x.latencyMs!);
    this.r.latency = { telemetry: null, script: stats(of('script')), stay: stats(of('stay')), all: stats(l) };
    this.r.finishedAt = new Date().toISOString();
    this.r.pass = !this.r.error && !this.r.reloaded && !this.r.skipped && this.r.steps.every((s) => s.ok) && (this.r.end?.ok ?? false) && (this.r.stay?.ok ?? true);
  }
}

export async function environment(page: Page): Promise<unknown> {
  return page.d.evaluateAsync(
    `(async () => { const hevc = async (codec) => { try { return (await VideoDecoder.isConfigSupported({ codec, codedWidth: 1920, codedHeight: 1080 })).supported === true; } catch { return false; } };` +
      ` return { userAgent: navigator.userAgent, crossOriginIsolated, hardwareConcurrency: navigator.hardwareConcurrency, deviceMemory: navigator.deviceMemory ?? null,` +
      ` viewport: [innerWidth, innerHeight, devicePixelRatio], hevcMain: await hevc('hvc1.1.6.L123.B0'), hevcMain10: await hevc('hvc1.2.4.L123.B0'), h264: await hevc('avc1.640028') }; })()`,
  );
}

async function serve(o: GateOptions): Promise<{ origin: string; token: string; close: () => Promise<void> }> {
  if (o.server && o.token) return { origin: o.server, token: o.token, close: async () => undefined };
  const token = randomBytes(18).toString('base64url');
  const server: Server = createServer(createDiscHandler({ roots: o.roots, token, distDir: o.dist }));
  await new Promise<void>((res, rej) => {
    server.once('error', rej);
    server.listen(o.port, '127.0.0.1', () => res());
  });
  return { origin: `http://127.0.0.1:${o.port}`, token, close: () => new Promise<void>((res) => { server.closeAllConnections(); server.close(() => res()); }) };
}

const slug = (s: string): string => s.replace(/^sim:/, 'sim-').replace(/[^A-Za-z0-9._-]+/g, '-');

async function main(): Promise<void> {
  const o = parseGateArgs(process.argv.slice(2));
  const server = await serve(o);
  let driver: GateDriver | null = null;
  let failed = false;
  try {
    driver = await startDriver(o);
    for (const disc of o.discs) {
      const cfg = DISCS[disc]!;
      const plan = loadPlan(disc);
      const discBase = await servedDiscBase(server.origin, server.token, disc);
      const url = `${server.origin}/?telemetry=1&disc=${encodeURIComponent(discBase)}&token=${encodeURIComponent(server.token)}`;
      const stamp = new Date().toISOString().replace(/[:.]/g, '-');
      const base = join(o.out, `${slug(o.target)}${o.touch ? '-touch' : ''}-${disc}-${stamp}`);
      const page = new Page(driver);
      const run = new DiscRun(page, o, disc, cfg, url, base);
      try {
        await page.open(url);
        run.r.environment = await environment(page);
        const env = run.r.environment as { hevcMain?: boolean; hevcMain10?: boolean };
        run.r.hevc = { main: env.hevcMain ?? null, main10: env.hevcMain10 ?? null };
        if (cfg.hevc && !env.hevcMain && !env.hevcMain10) run.r.skipped = 'the browser decodes no HEVC (VideoDecoder.isConfigSupported)';
        else await run.run(plan);
      } catch (err) {
        run.r.reloaded = err instanceof PageReloadedError;
        run.r.error = err instanceof Error ? err.message : String(err);
        console.error(`${disc}: ${run.r.error}`);
        await driver.screenshot(`${base}-error.png`).catch(() => undefined);
        run.r.diagnostics = await driver
          .evaluate(
            "(() => { const p = document.querySelector('[data-testid=player]'); return { href: location.pathname, state: p?.getAttribute('data-state') ?? null," +
              " playlist: p?.getAttribute('data-playlist') ?? null, error: document.querySelector('[data-testid=error]')?.textContent ?? null," +
              " notices: [...document.querySelectorAll('.notice')].map((n) => n.textContent), text: document.body.innerText.slice(0, 600), telemetry: window.__blurayTelemetry ?? null }; })()",
          )
          .catch((e: unknown) => String(e));
      }
      run.finish();
      run.r.latency!.telemetry = await page.probe('window.__blurayTelemetry?.bdj?.inputLatencyMs ?? null', 'latency').catch(() => null);
      run.r.console = (await driver.consoleLog().catch(() => [] as string[])).slice(-300);
      write(`${base}.json`, `${JSON.stringify(run.r, null, 2)}\n`);
      console.error(`${disc}: ${run.r.skipped ? `SKIPPED (${run.r.skipped})` : run.r.pass ? 'PASS' : 'FAIL'} → ${base}.json`);
      if (!run.r.pass && !run.r.skipped) failed = true;
    }
  } finally {
    await driver?.close().catch(() => undefined);
    await server.close();
  }
  process.exit(failed ? 1 : 0);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((err: unknown) => {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(2);
  });
}
