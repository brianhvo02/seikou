// @vitest-environment jsdom
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { THEME_COLORS, THEME_KEY, effectiveTheme, readThemeChoice } from './theme';

const html = readFileSync(join(process.cwd(), 'index.html'), 'utf8');
const page = new DOMParser().parseFromString(html, 'text/html');
const script = page.getElementById('theme-boot')?.textContent ?? '';

const throwing = (): Storage => {
  throw new Error('denied');
};

describe('index.html theme-boot', () => {
  it('has a theme-color for each scheme', () => {
    const metas = [...page.querySelectorAll('meta[name="theme-color"]')].map((m) => [m.getAttribute('media'), m.getAttribute('content')]);
    expect(metas).toEqual([
      ['(prefers-color-scheme: light)', '#f6f8fe'],
      ['(prefers-color-scheme: dark)', '#0a1330'],
    ]);
  });

  it('runs before the stylesheet and the app, as a classic script', () => {
    const el = page.getElementById('theme-boot');
    expect(el?.tagName).toBe('SCRIPT');
    expect(el?.getAttribute('type')).toBeNull();
    expect(el?.parentElement?.tagName).toBe('HEAD');
  });

  for (const stored of [null, 'auto', 'light', 'dark', 'sepia', 'throws'] as const) {
    for (const prefersLight of [true, false]) {
      it(`agrees with the theme module: stored ${stored}, device ${prefersLight ? 'light' : 'dark'}`, () => {
        const doc = document.implementation.createHTMLDocument('t');
        doc.head.innerHTML = '<meta name="theme-color" media="(prefers-color-scheme: light)"><meta name="theme-color" media="(prefers-color-scheme: dark)">';
        const storage = { getItem: (k: string) => (k === THEME_KEY ? stored : null) };
        const win = { matchMedia: (q: string) => ({ matches: q === '(prefers-color-scheme: light)' && prefersLight }) };
        const localStorageArg = stored === 'throws' ? undefined : storage;
        const run = new Function('window', 'document', 'localStorage', script);
        if (stored === 'throws') {
          // the getter throws, as Safari's does with site data blocked
          const w = Object.defineProperty({ ...win }, 'localStorage', { get: throwing });
          run(w, doc, localStorageArg);
        } else run({ ...win, localStorage: storage }, doc, localStorageArg);
        const expected = effectiveTheme(readThemeChoice(stored === 'throws' ? null : storage), prefersLight, false);
        expect(doc.documentElement.dataset.theme).toBe(expected);
        expect(doc.documentElement.style.colorScheme).toBe(expected);
        expect([...doc.querySelectorAll('meta[name="theme-color"]')].map((m) => m.getAttribute('content'))).toEqual([THEME_COLORS[expected], THEME_COLORS[expected]]);
      });
    }
  }
});
