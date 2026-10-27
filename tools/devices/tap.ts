/**
 * Touches that land where they are aimed (gate.ts and live-check.ts). A real touch on a phone goes to screen
 * coordinates taken from the page a moment earlier; when the page still scrolls (a smooth scroll, a `scrollTo` undone
 * after a tap, Safari's toolbar collapsing or growing back and resizing the viewport, a pinch zoom settling) those
 * coordinates are stale by the time the finger comes down, and the touch lands beside its target. So before a tap
 * the page is read until its scroll offsets, its visual viewport and the target's box have held still for a few
 * reads; the target is scrolled into view first when it is not on screen, and its box is read again after; the finger
 * stays down a moment (a zero-length touch is not one a person makes); and a listener in the page records where the
 * touch arrived, so a miss is known and logged instead of guessed from what happened after.
 *
 * The helpers here are pure, or build the page expressions; Page in gate.ts drives them.
 */

/** How long the finger stays down in a tap (W3C pointer actions: a pause between pointerDown and pointerUp). */
export const TAP_HOLD_MS = 60;

/** The page's layout as one read sees it: scroll offsets, viewport sizes, the visual viewport and a target's box. */
export interface LayoutReading {
  readonly scrollX: number;
  readonly scrollY: number;
  readonly innerWidth: number;
  readonly innerHeight: number;
  /** visualViewport (null where the browser has none). */
  readonly vv: { offsetLeft: number; offsetTop: number; pageLeft: number; pageTop: number; width: number; height: number; scale: number } | null;
  /** The target's box in client (layout viewport) coordinates; null with no target or none visible. */
  readonly rect: { x: number; y: number; width: number; height: number } | null;
  /** Whether the target's centre lies inside the visual viewport (true with no target). */
  readonly inView: boolean;
}

/** Whether two readings agree to within `tol` CSS pixels (and the zoom scale to within 0.001). */
export function sameLayout(a: LayoutReading, b: LayoutReading, tol = 0.5): boolean {
  const near = (p: number, q: number): boolean => Math.abs(p - q) <= tol;
  if (!near(a.scrollX, b.scrollX) || !near(a.scrollY, b.scrollY) || !near(a.innerWidth, b.innerWidth) || !near(a.innerHeight, b.innerHeight)) return false;
  if ((a.vv === null) !== (b.vv === null)) return false;
  if (a.vv && b.vv) {
    const v = a.vv;
    const w = b.vv;
    if (!near(v.offsetLeft, w.offsetLeft) || !near(v.offsetTop, w.offsetTop) || !near(v.pageLeft, w.pageLeft) || !near(v.pageTop, w.pageTop)) return false;
    if (!near(v.width, w.width) || !near(v.height, w.height) || Math.abs(v.scale - w.scale) > 0.001) return false;
  }
  if ((a.rect === null) !== (b.rect === null)) return false;
  if (a.rect && b.rect) {
    const r = a.rect;
    const s = b.rect;
    if (!near(r.x, s.x) || !near(r.y, s.y) || !near(r.width, s.width) || !near(r.height, s.height)) return false;
  }
  return a.inView === b.inView;
}

export interface SettleOptions {
  /** Consecutive reads that must agree with the first of them (default 3: two intervals of stillness). */
  readonly stableReads?: number;
  /** Pause between reads (default 80 ms, about five frames). */
  readonly intervalMs?: number;
  /** Give up after this long and go with the last read (default 3000 ms). */
  readonly timeoutMs?: number;
  readonly sleep?: (ms: number) => Promise<void>;
  readonly now?: () => number;
}

export interface Settled<T> {
  readonly value: T;
  /** False when the time ran out before the reads agreed: the value is the last read, possibly still moving. */
  readonly settled: boolean;
  readonly reads: number;
  readonly waitedMs: number;
}

/**
 * Reads until `stableReads` consecutive reads are `same` as each other, `intervalMs` apart, or `timeoutMs` passes.
 * Every read is compared with the one before it, so a slow drift (a scroll easing out) keeps it waiting.
 */
export async function waitSettled<T>(read: () => Promise<T>, same: (a: T, b: T) => boolean, o: SettleOptions = {}): Promise<Settled<T>> {
  const stableReads = Math.max(1, o.stableReads ?? 3);
  const intervalMs = o.intervalMs ?? 80;
  const timeoutMs = o.timeoutMs ?? 3000;
  const sleep = o.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const now = o.now ?? Date.now;
  const t0 = now();
  let last = await read();
  let reads = 1;
  let run = 1;
  for (;;) {
    if (run >= stableReads) return { value: last, settled: true, reads, waitedMs: now() - t0 };
    if (now() - t0 >= timeoutMs) return { value: last, settled: false, reads, waitedMs: now() - t0 };
    await sleep(intervalMs);
    const next = await read();
    reads++;
    run = same(last, next) ? run + 1 : 1;
    last = next;
  }
}

const firstVisible = (selector: string): string =>
  `[...document.querySelectorAll(${JSON.stringify(selector)})].find((x) => x.getClientRects().length > 0)`;

/**
 * A page expression giving a LayoutReading of `selector`'s first visible match (or of the page alone with null). With
 * `scroll`, a target whose centre is outside the visual viewport is first scrolled to its middle, at once.
 */
export function layoutExpr(selector: string | null, scroll = false): string {
  const target = selector === null ? 'null' : firstVisible(selector);
  return (
    `(() => { const e = ${target}; const v = window.visualViewport;` +
    ' const inside = (r) => { const cx = r.x + r.width / 2; const cy = r.y + r.height / 2;' +
    '  const ox = v ? v.offsetLeft : 0; const oy = v ? v.offsetTop : 0; const w = v ? v.width : innerWidth; const h = v ? v.height : innerHeight;' +
    '  return cx >= ox && cy >= oy && cx <= ox + w && cy <= oy + h; };' +
    (scroll ? " if (e && !inside(e.getBoundingClientRect())) e.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' });" : '') +
    ' const b = e ? e.getBoundingClientRect() : null;' +
    ' return { scrollX, scrollY, innerWidth, innerHeight,' +
    '  vv: v ? { offsetLeft: v.offsetLeft, offsetTop: v.offsetTop, pageLeft: v.pageLeft, pageTop: v.pageTop, width: v.width, height: v.height, scale: v.scale } : null,' +
    '  rect: b ? { x: b.x, y: b.y, width: b.width, height: b.height } : null, inView: b ? inside(b) : true }; })()'
  );
}

/** Where a tap was aimed, and (for an element) what at. */
export interface TapAim {
  readonly x: number;
  readonly y: number;
  readonly selector: string | null;
}

/** What the page's listener saw of the tap: the first pointerdown (or touchstart) after it was armed. */
export interface TapLanding {
  readonly type: string;
  readonly x: number;
  readonly y: number;
  /** The event target's data-testid, class or tag. */
  readonly target: string;
  /** Whether the target lies inside an element the aim's selector matches (null with no selector). */
  readonly hit: boolean | null;
}

/**
 * A page expression that arms a one-shot capture listener for the next tap: the first pointerdown or touchstart is
 * recorded in window.__tapLanding (a touch's pointerdown comes first; touchstart covers a browser without one).
 */
export function armExpr(selector: string | null): string {
  return (
    '(() => { if (window.__tapDisarm) window.__tapDisarm(); window.__tapLanding = null;' +
    ' const describe = (t) => t instanceof Element ? (t.getAttribute(\'data-testid\') || (typeof t.className === \'string\' && t.className) || t.tagName.toLowerCase()) : String(t && t.nodeName);' +
    ` const sel = ${JSON.stringify(selector)};` +
    ' const on = (ev) => { if (window.__tapLanding) return; const p = ev.touches ? ev.touches[0] : ev; const t = ev.target;' +
    '  window.__tapLanding = { type: ev.type, x: p ? p.clientX : NaN, y: p ? p.clientY : NaN, target: describe(t), hit: sel === null ? null : t instanceof Element && t.closest(sel) !== null }; };' +
    " const opts = { capture: true, passive: true }; window.addEventListener('pointerdown', on, opts); window.addEventListener('touchstart', on, opts);" +
    " window.__tapDisarm = () => { window.removeEventListener('pointerdown', on, opts); window.removeEventListener('touchstart', on, opts); window.__tapDisarm = null; };" +
    ' return true; })()'
  );
}

/** A page expression that reads (and, once something arrived, disarms) what the armed listener recorded. */
export const LANDING_EXPR = '(() => { const l = window.__tapLanding ?? null; if (l && window.__tapDisarm) window.__tapDisarm(); return l; })()';

/** A page expression that drops the listener without reading it. */
export const DISARM_EXPR = '(() => { if (window.__tapDisarm) window.__tapDisarm(); return true; })()';

export interface TapVerdict {
  readonly landed: boolean;
  /** One line for the log: where the touch arrived against where it was aimed. */
  readonly note: string;
}

/**
 * Whether a tap landed: with a selector, its first touch event's target lies inside a match; without one, the event
 * arrived within `tol` CSS pixels of the aim. No event at all is a miss (the touch reached nothing in the page, or
 * arrived while the page was elsewhere).
 */
export function tapVerdict(aim: TapAim, landing: TapLanding | null, tol = 8): TapVerdict {
  const at = `(${Math.round(aim.x)}, ${Math.round(aim.y)})`;
  if (!landing) return { landed: false, note: `no touch reached the page (aimed at ${at})` };
  const got = `${landing.type} at (${Math.round(landing.x)}, ${Math.round(landing.y)}) on ${landing.target}`;
  if (aim.selector !== null) {
    return landing.hit
      ? { landed: true, note: `${got}` }
      : { landed: false, note: `${got}, not on ${aim.selector} (aimed at ${at})` };
  }
  const ok = Number.isFinite(landing.x) && Number.isFinite(landing.y) && Math.hypot(landing.x - aim.x, landing.y - aim.y) <= tol;
  return ok ? { landed: true, note: got } : { landed: false, note: `${got}, ${tol} px or more from ${at}` };
}

/** The centre of a reading's target box, or null. */
export function centreOf(r: LayoutReading): { x: number; y: number } | null {
  return r.rect ? { x: r.rect.x + r.rect.width / 2, y: r.rect.y + r.rect.height / 2 } : null;
}
