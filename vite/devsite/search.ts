// SPDX-License-Identifier: LGPL-3.0-or-later
/**
 * The developer pages' one script: the search box (the index is fetched the first time the field gets focus) and the
 * theme switch (the same `bluray-web:theme` choice the player keeps). The pages read the same without it.
 */
import type { SearchEntry } from './search-index.ts';

/** Where the search index is published. */
export const SEARCH_INDEX_URL = '/developers/search.json';
/** The most results the list shows. */
export const MAX_RESULTS = 12;

/**
 * The entries that match `query`, best first: names that start with it, then names that hold it, then summaries that
 * hold it (case ignored); within each, shorter names first, then by name. An empty query matches nothing.
 */
export function filterEntries(entries: readonly SearchEntry[], query: string, limit = MAX_RESULTS): SearchEntry[] {
  const q = query.trim().toLowerCase();
  if (!q) return [];
  const ranked: { e: SearchEntry; rank: number }[] = [];
  for (const e of entries) {
    const name = e.name.toLowerCase();
    const rank = name.startsWith(q) ? 0 : name.includes(q) ? 1 : e.summary.toLowerCase().includes(q) ? 2 : -1;
    if (rank >= 0) ranked.push({ e, rank });
  }
  ranked.sort((a, b) => a.rank - b.rank || a.e.name.length - b.e.name.length || a.e.name.localeCompare(b.e.name) || a.e.pkg.localeCompare(b.e.pkg));
  return ranked.slice(0, limit).map((r) => r.e);
}

/** What the search box needs from the page, injectable for tests. */
export interface SearchDeps {
  /** Reads the search index (fetched once, on the field's first focus). */
  readonly load: () => Promise<readonly SearchEntry[]>;
  /** Goes to a result. */
  readonly navigate: (href: string) => void;
}

/** The search box's behaviour on a page's `form.search`; `dispose` removes its listeners. */
export class SearchBox {
  private entries: readonly SearchEntry[] | null = null;
  private loading: Promise<void> | null = null;
  private results: SearchEntry[] = [];
  private active = -1;
  private readonly input: HTMLInputElement;
  private readonly list: HTMLUListElement;

  constructor(
    private readonly form: HTMLFormElement,
    private readonly deps: SearchDeps,
  ) {
    this.input = form.querySelector<HTMLInputElement>('.search-input')!;
    this.list = form.querySelector<HTMLUListElement>('.search-results')!;
    this.input.setAttribute('role', 'combobox');
    this.input.setAttribute('aria-autocomplete', 'list');
    this.input.addEventListener('focus', this.onFocus);
    this.input.addEventListener('input', this.onInput);
    this.input.addEventListener('keydown', this.onKey);
    form.addEventListener('focusout', this.onFocusOut);
  }

  /** Resolves once the index has loaded (or failed to): for tests and for a query typed before it arrived. */
  ready(): Promise<void> {
    return this.loading ?? this.load();
  }

  /** The results shown now. */
  shown(): readonly SearchEntry[] {
    return this.results;
  }

  /** The index of the highlighted result, or -1. */
  activeIndex(): number {
    return this.active;
  }

  dispose(): void {
    this.input.removeEventListener('focus', this.onFocus);
    this.input.removeEventListener('input', this.onInput);
    this.input.removeEventListener('keydown', this.onKey);
    this.form.removeEventListener('focusout', this.onFocusOut);
  }

  private load(): Promise<void> {
    this.loading ??= this.deps.load().then(
      (entries) => {
        this.entries = entries;
        if (this.input.value.trim()) this.update();
      },
      () => {
        this.entries = [];
      },
    );
    return this.loading;
  }

  private readonly onFocus = (): void => {
    void this.load();
  };

  private readonly onInput = (): void => {
    if (this.entries === null) void this.load();
    this.update();
  };

  private readonly onKey = (ev: KeyboardEvent): void => {
    const open = !this.list.hidden;
    if (ev.key === 'ArrowDown' || ev.key === 'ArrowUp') {
      if (!open) {
        if (this.input.value.trim()) this.update();
        return;
      }
      if (!this.results.length) return;
      ev.preventDefault();
      const n = this.results.length;
      this.select(ev.key === 'ArrowDown' ? (this.active + 1) % n : (this.active - 1 + n) % n);
    } else if (ev.key === 'Enter') {
      ev.preventDefault();
      const hit = this.results[this.active];
      if (open && hit) this.deps.navigate(hit.href);
    } else if (ev.key === 'Escape') {
      if (open) {
        ev.preventDefault();
        this.close();
      } else if (this.input.value) {
        ev.preventDefault();
        this.input.value = '';
      }
    }
  };

  private readonly onFocusOut = (ev: FocusEvent): void => {
    const to = ev.relatedTarget as Node | null;
    if (!to || !this.form.contains(to)) this.close();
  };

  private update(): void {
    const q = this.input.value;
    if (!q.trim()) {
      this.close();
      return;
    }
    this.results = filterEntries(this.entries ?? [], q);
    this.active = this.results.length ? 0 : -1;
    this.render(this.entries === null);
  }

  private render(loading: boolean): void {
    const doc = this.list.ownerDocument;
    this.list.replaceChildren();
    if (!this.results.length) {
      const li = doc.createElement('li');
      li.className = 'search-empty';
      li.textContent = loading ? 'Loading the exports…' : 'No export matches';
      this.list.append(li);
    }
    this.results.forEach((e, i) => {
      const li = doc.createElement('li');
      li.className = 'search-result';
      li.id = `search-opt-${i}`;
      li.setAttribute('role', 'option');
      li.setAttribute('aria-selected', String(i === this.active));
      const a = doc.createElement('a');
      a.href = e.href;
      a.tabIndex = -1;
      for (const [cls, text] of [
        ['search-name', e.name],
        ['search-pkg', `@seikou/${e.pkg}`],
        ['search-summary', e.summary],
      ] as const) {
        const span = doc.createElement('span');
        span.className = cls;
        span.textContent = text;
        a.append(span);
      }
      li.append(a);
      this.list.append(li);
    });
    this.list.hidden = false;
    this.input.setAttribute('aria-expanded', 'true');
    this.markActive();
  }

  private select(i: number): void {
    this.active = i;
    this.list.querySelectorAll('.search-result').forEach((li, j) => li.setAttribute('aria-selected', String(j === i)));
    this.markActive();
    this.list.querySelector(`#search-opt-${i}`)?.scrollIntoView?.({ block: 'nearest' });
  }

  private markActive(): void {
    if (this.active >= 0) this.input.setAttribute('aria-activedescendant', `search-opt-${this.active}`);
    else this.input.removeAttribute('aria-activedescendant');
  }

  private close(): void {
    this.list.hidden = true;
    this.list.replaceChildren();
    this.results = [];
    this.active = -1;
    this.input.setAttribute('aria-expanded', 'false');
    this.input.removeAttribute('aria-activedescendant');
  }
}

/** `localStorage` key of the device's theme choice, shared with the player. */
const THEME_KEY = 'bluray-web:theme';
const THEME_COLORS = { light: '#f6f8fe', dark: '#0a1330' } as const;

/** What the theme switch reads from the page, injectable for tests. */
export interface ThemeSwitchDeps {
  readonly storage: () => Storage | null;
  readonly matchMedia: (query: string) => MediaQueryList;
}

/**
 * Wires the page's `fieldset.theme-switch`: checks the stored choice, and on a change stores it and applies it to
 * `<html>` as the player does (Auto follows `prefers-color-scheme`, also when the device's setting changes).
 */
export function bindThemeSwitch(doc: Document, deps: ThemeSwitchDeps): void {
  const storage = (): Storage | null => {
    try {
      return deps.storage();
    } catch {
      return null;
    }
  };
  let choice = 'auto';
  try {
    const v = storage()?.getItem(THEME_KEY);
    if (v === 'light' || v === 'dark') choice = v;
  } catch {
    // unreadable storage is Auto
  }
  const media = deps.matchMedia('(prefers-color-scheme: light)');
  const apply = (): void => {
    const theme = choice === 'auto' ? (media.matches ? 'light' : 'dark') : (choice as 'light' | 'dark');
    const root = doc.documentElement;
    root.dataset.theme = theme;
    root.style.colorScheme = theme;
    for (const meta of doc.querySelectorAll('meta[name="theme-color"]')) meta.setAttribute('content', THEME_COLORS[theme]);
  };
  for (const input of doc.querySelectorAll<HTMLInputElement>('.theme-switch input[name="theme"]')) {
    input.checked = input.value === choice;
    input.addEventListener('change', () => {
      if (!input.checked) return;
      choice = input.value;
      try {
        storage()?.setItem(THEME_KEY, choice);
      } catch {
        // kept for this page only
      }
      apply();
    });
  }
  media.addEventListener('change', apply);
}

/** Starts the search box and the theme switch on a developer page; a page without them is left alone. */
export function start(doc: Document = document): void {
  const win = doc.defaultView;
  if (!win) return;
  bindThemeSwitch(doc, {
    storage: () => win.localStorage,
    matchMedia: (q) => win.matchMedia(q),
  });
  const form = doc.querySelector<HTMLFormElement>('form.search');
  if (!form?.querySelector('.search-input') || !form.querySelector('.search-results')) return;
  new SearchBox(form, {
    load: async () => {
      const res = await win.fetch(SEARCH_INDEX_URL);
      if (!res.ok) throw new Error(`search index: HTTP ${res.status}`);
      return (await res.json()) as SearchEntry[];
    },
    navigate: (href) => win.location.assign(href),
  });
}

// A developer page loads this as its script; anything else that imports it (a test) starts nothing.
if (typeof document !== 'undefined' && document.body?.classList.contains('dev')) start(document);
