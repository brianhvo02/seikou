/**
 * Light and dark mode (spec 2026-10-27): the device's choice (Auto, Light, Dark) in localStorage, the theme it gives
 * with the device's `prefers-color-scheme` and whether a disc is open (the player, and the page with it, stay dark),
 * and applying it to <html>. `index.html`'s `#theme-boot` script repeats `readThemeChoice`, `effectiveTheme` and
 * `applyTheme` before first paint; `theme-boot.test.ts` keeps the two in step.
 */

export type ThemeChoice = 'auto' | 'light' | 'dark';
export type EffectiveTheme = 'light' | 'dark';

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

export function effectiveTheme(choice: ThemeChoice, prefersLight: boolean, discOpen: boolean): EffectiveTheme {
  if (discOpen) return 'dark';
  if (choice === 'auto') return prefersLight ? 'light' : 'dark';
  return choice;
}

export function applyTheme(doc: Document, theme: EffectiveTheme): void {
  const root = doc.documentElement;
  root.dataset.theme = theme;
  root.style.colorScheme = theme;
  for (const meta of doc.querySelectorAll('meta[name="theme-color"]')) meta.setAttribute('content', THEME_COLORS[theme]);
}

export interface ThemeDeps {
  readonly storage: () => Storage | null;
  readonly matchMedia: (query: string) => MediaQueryList;
  readonly target: Pick<Window, 'addEventListener' | 'removeEventListener'>;
  readonly doc: Document;
}

export interface ThemeSnapshot {
  readonly choice: ThemeChoice;
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
