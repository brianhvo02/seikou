/**
 * Light and dark mode (spec 2026-10-27): the device's choice (Auto, Light, Dark) in localStorage, the theme it gives
 * with the device's `prefers-color-scheme` and whether a disc is open (the player, and the page with it, stay dark),
 * and applying it to <html>. `index.html`'s `#theme-boot` script repeats `readThemeChoice`, `effectiveTheme` and
 * `applyTheme` before first paint; `theme-boot.test.ts` keeps the two in step.
 */

/** The device's theme setting: follow the system, or force light or dark. */
export type ThemeChoice = 'auto' | 'light' | 'dark';
/** The theme actually applied: what the choice, the device and an open disc resolve to. */
export type EffectiveTheme = 'light' | 'dark';

/** `localStorage` key (a kept `bluray-web` name) of the device's choice. */
export const THEME_KEY = 'bluray-web:theme';

/** The page grounds (`--night`), for the browser's own bar. */
export const THEME_COLORS: Readonly<Record<EffectiveTheme, string>> = { light: '#f6f8fe', dark: '#0a1330' };

const LIGHT_QUERY = '(prefers-color-scheme: light)';

/** The stored choice; anything missing, unknown or unreadable is Auto. */
export function readThemeChoice(storage: Pick<Storage, 'getItem'> | null): ThemeChoice {
  try {
    const v = storage?.getItem(THEME_KEY);
    return v === 'light' || v === 'dark' ? v : 'auto';
  } catch {
    return 'auto';
  }
}

/** Resolves the choice: always dark while a disc is open; Auto follows `prefersLight`. */
export function effectiveTheme(choice: ThemeChoice, prefersLight: boolean, discOpen: boolean): EffectiveTheme {
  if (discOpen) return 'dark';
  if (choice === 'auto') return prefersLight ? 'light' : 'dark';
  return choice;
}

/** Sets `data-theme` and `color-scheme` on `<html>` and the `theme-color` meta tags to the theme's page colour. */
export function applyTheme(doc: Document, theme: EffectiveTheme): void {
  const root = doc.documentElement;
  root.dataset.theme = theme;
  root.style.colorScheme = theme;
  for (const meta of doc.querySelectorAll('meta[name="theme-color"]')) meta.setAttribute('content', THEME_COLORS[theme]);
}

/** What `ThemeController` reads from the page, injectable for tests. */
export interface ThemeDeps {
  /** `localStorage`, or null when it is unavailable (it can throw in some privacy modes). */
  readonly storage: () => Storage | null;
  /** `window.matchMedia`, for `prefers-color-scheme`. */
  readonly matchMedia: (query: string) => MediaQueryList;
  /** Where `storage` events from other tabs arrive. */
  readonly target: Pick<Window, 'addEventListener' | 'removeEventListener'>;
  /** The document whose `<html>` gets the theme. */
  readonly doc: Document;
}

/** The theme store's state. */
export interface ThemeSnapshot {
  /** What the user picked. */
  readonly choice: ThemeChoice;
  /** What is applied now. */
  readonly effective: EffectiveTheme;
}

/** The theme as an external store (useSyncExternalStore): the choice, the device's preference and an open disc. */
export class ThemeController {
  private choice: ThemeChoice;
  private discOpen = false;
  private snapshot: ThemeSnapshot;
  private readonly media: MediaQueryList;
  private readonly listeners = new Set<() => void>();

  constructor(private readonly deps: ThemeDeps) {
    this.choice = readThemeChoice(this.storage());
    this.media = deps.matchMedia(LIGHT_QUERY);
    this.media.addEventListener('change', this.update);
    deps.target.addEventListener('storage', this.onStorage);
    this.snapshot = this.compute();
    applyTheme(deps.doc, this.snapshot.effective);
  }

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  getSnapshot = (): ThemeSnapshot => this.snapshot;

  setChoice(choice: ThemeChoice): void {
    try {
      this.storage()?.setItem(THEME_KEY, choice);
    } catch {
      // kept for this page only (private mode, blocked site data)
    }
    this.choice = choice;
    this.update();
  }

  setDiscOpen(open: boolean): void {
    this.discOpen = open;
    this.update();
  }

  dispose(): void {
    this.media.removeEventListener('change', this.update);
    this.deps.target.removeEventListener('storage', this.onStorage);
    this.listeners.clear();
  }

  private storage(): Storage | null {
    try {
      return this.deps.storage();
    } catch {
      return null;
    }
  }

  private compute(): ThemeSnapshot {
    return { choice: this.choice, effective: effectiveTheme(this.choice, this.media.matches, this.discOpen) };
  }

  /** Another tab changed the choice. */
  private readonly onStorage = (e: Event): void => {
    if ((e as StorageEvent).key !== THEME_KEY) return;
    this.choice = readThemeChoice({ getItem: () => (e as StorageEvent).newValue });
    this.update();
  };

  private readonly update = (): void => {
    const next = this.compute();
    if (next.choice === this.snapshot.choice && next.effective === this.snapshot.effective) return;
    this.snapshot = next;
    applyTheme(this.deps.doc, next.effective);
    for (const l of this.listeners) l();
  };
}

let shared: ThemeController | null = null;

/** The page's one controller, over this window's localStorage and media query. */
export function themeController(): ThemeController {
  shared ??= new ThemeController({ storage: () => window.localStorage, matchMedia: (q) => window.matchMedia(q), target: window, doc: document });
  return shared;
}
