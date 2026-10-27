// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { THEME_KEY, ThemeController, applyTheme, effectiveTheme, readThemeChoice, type ThemeDeps } from './theme';

/** A MediaQueryList whose `matches` the test sets, dispatching 'change' as a browser does. */
function fakeMedia(initial: boolean) {
  const target = new EventTarget();
  const mql = Object.assign(target, { matches: initial, media: '(prefers-color-scheme: light)', onchange: null }) as unknown as MediaQueryList;
  return {
    mql,
    set(matches: boolean) {
      (mql as { matches: boolean }).matches = matches;
      mql.dispatchEvent(new Event('change'));
    },
  };
}

function memoryStorage(opts: { failWrites?: boolean; failReads?: boolean } = {}): Storage {
  const map = new Map<string, string>();
  return {
    getItem: (k) => {
      if (opts.failReads) throw new Error('denied');
      return map.get(k) ?? null;
    },
    setItem: (k, v) => {
      if (opts.failWrites) throw new Error('quota');
      map.set(k, v);
    },
    removeItem: (k) => void map.delete(k),
    clear: () => map.clear(),
    key: () => null,
    get length() {
      return map.size;
    },
  };
}

function setup(opts: { prefersLight?: boolean; storage?: Storage } = {}) {
  const media = fakeMedia(opts.prefersLight ?? false);
  const target = new EventTarget();
  const storage = opts.storage ?? memoryStorage();
  const theme = new ThemeController({ storage: () => storage, matchMedia: () => media.mql, target: target as unknown as ThemeDeps['target'], doc: document });
  return { theme, media, target, storage };
}

describe('readThemeChoice', () => {
  it('reads an unknown value as auto', () => {
    for (const v of [null, '', 'sepia']) expect(readThemeChoice({ getItem: () => v })).toBe('auto');
    expect(readThemeChoice({ getItem: () => 'light' })).toBe('light');
    expect(readThemeChoice({ getItem: () => 'dark' })).toBe('dark');
  });

  it('falls back to auto when storage throws', () => {
    expect(
      readThemeChoice({
        getItem: () => {
          throw new Error('denied');
        },
      }),
    ).toBe('auto');
    expect(readThemeChoice(null)).toBe('auto');
  });
});

describe('effectiveTheme', () => {
  it('derives the effective theme', () => {
    expect(effectiveTheme('auto', true, false)).toBe('light');
    expect(effectiveTheme('auto', false, false)).toBe('dark');
    expect(effectiveTheme('light', false, false)).toBe('light');
    expect(effectiveTheme('dark', true, false)).toBe('dark');
    expect(effectiveTheme('light', true, true)).toBe('dark'); // a disc is open
  });
});

describe('applyTheme', () => {
  it('applies data-theme, color-scheme and theme-color', () => {
    document.head.innerHTML = '<meta name="theme-color" media="(prefers-color-scheme: light)"><meta name="theme-color" media="(prefers-color-scheme: dark)">';
    applyTheme(document, 'light');
    expect(document.documentElement.dataset.theme).toBe('light');
    expect(document.documentElement.style.colorScheme).toBe('light');
    expect([...document.querySelectorAll('meta[name="theme-color"]')].map((m) => m.getAttribute('content'))).toEqual(['#f6f8fe', '#f6f8fe']);
    applyTheme(document, 'dark');
    expect(document.documentElement.dataset.theme).toBe('dark');
    expect([...document.querySelectorAll('meta[name="theme-color"]')].map((m) => m.getAttribute('content'))).toEqual(['#0a1330', '#0a1330']);
  });
});

describe('ThemeController', () => {
  it('starts from the stored choice and applies it', () => {
    const storage = memoryStorage();
    storage.setItem(THEME_KEY, 'light');
    const { theme } = setup({ storage });
    expect(theme.getSnapshot()).toEqual({ choice: 'light', effective: 'light' });
    expect(document.documentElement.dataset.theme).toBe('light');
  });

  it('follows the media query only on auto', () => {
    const { theme, media } = setup({ prefersLight: false });
    expect(theme.getSnapshot().effective).toBe('dark');
    media.set(true);
    expect(theme.getSnapshot().effective).toBe('light');
    expect(document.documentElement.dataset.theme).toBe('light');
    theme.setChoice('dark');
    media.set(false);
    media.set(true);
    expect(theme.getSnapshot().effective).toBe('dark');
  });

  it('stores the choice and keeps it while a disc is open', () => {
    const { theme, storage } = setup({ prefersLight: false });
    theme.setChoice('light');
    expect(storage.getItem(THEME_KEY)).toBe('light');
    theme.setDiscOpen(true);
    expect(theme.getSnapshot()).toEqual({ choice: 'light', effective: 'dark' });
    expect(document.documentElement.dataset.theme).toBe('dark');
    theme.setDiscOpen(false);
    expect(theme.getSnapshot()).toEqual({ choice: 'light', effective: 'light' });
    expect(storage.getItem(THEME_KEY)).toBe('light');
  });

  it('a choice still applies when storage refuses the write', () => {
    const { theme } = setup({ storage: memoryStorage({ failWrites: true }) });
    expect(() => theme.setChoice('light')).not.toThrow();
    expect(theme.getSnapshot().effective).toBe('light');
  });

  it('opens on auto when storage refuses the read', () => {
    const { theme } = setup({ prefersLight: true, storage: memoryStorage({ failReads: true }) });
    expect(theme.getSnapshot()).toEqual({ choice: 'auto', effective: 'light' });
  });

  it('follows another tab through the storage event', () => {
    const { theme, target } = setup({ prefersLight: true });
    target.dispatchEvent(Object.assign(new Event('storage'), { key: 'other', newValue: 'dark' }));
    expect(theme.getSnapshot().choice).toBe('auto');
    target.dispatchEvent(Object.assign(new Event('storage'), { key: THEME_KEY, newValue: 'dark' }));
    expect(theme.getSnapshot()).toEqual({ choice: 'dark', effective: 'dark' });
  });

  it('notifies subscribers and keeps the snapshot stable between changes', () => {
    const { theme, media, target } = setup({ prefersLight: false });
    const { subscribe, getSnapshot } = theme;
    expect(getSnapshot()).toBe(getSnapshot());
    let calls = 0;
    const off = subscribe(() => calls++);
    theme.setChoice('light');
    expect(calls).toBe(1);
    theme.setChoice('light'); // no change
    expect(calls).toBe(1);
    off();
    theme.setChoice('dark');
    expect(calls).toBe(1);
    theme.dispose();
    media.set(true);
    target.dispatchEvent(Object.assign(new Event('storage'), { key: THEME_KEY, newValue: 'auto' }));
    expect(getSnapshot().choice).toBe('dark');
  });
});
