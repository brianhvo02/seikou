// @vitest-environment jsdom
// SPDX-License-Identifier: LGPL-3.0-or-later
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render404 } from './render.ts';
import type { SearchEntry } from './search-index.ts';
import { bindThemeSwitch, filterEntries, SearchBox } from './search.ts';

const entry = (pkg: string, name: string, summary = ''): SearchEntry => ({
  pkg,
  name,
  kind: 'function',
  summary,
  href: `/developers/${pkg}/${name}`,
});
const ENTRIES = [
  entry('bdmv', 'parseMpls', 'Parses the bytes of a playlist.'),
  entry('bdmv', 'Mpls', 'A parsed playlist.'),
  entry('bdmv', 'parseClpi', 'Parses clip information.'),
  entry('engine', 'openDisc', 'Opens a disc from its mpls files.'),
  entry('nas', 'parse', 'Parses a code.'),
];

describe('filterEntries', () => {
  it('ranks name prefixes, then name substrings, then summaries, ignoring case', () => {
    expect(filterEntries(ENTRIES, 'MPLS').map((e) => e.name)).toEqual(['Mpls', 'parseMpls', 'openDisc']);
    expect(filterEntries(ENTRIES, 'parse').map((e) => e.name)).toEqual(['parse', 'parseClpi', 'parseMpls', 'Mpls']);
  });

  it('matches nothing for an empty query, and keeps to the limit', () => {
    expect(filterEntries(ENTRIES, '   ')).toEqual([]);
    expect(filterEntries(ENTRIES, 'p', 2)).toHaveLength(2);
  });
});

/** The page's real markup (the 404 has the bar and search box like every page), in this document. */
function mountPage(): HTMLFormElement {
  const doc = new DOMParser().parseFromString(render404(), 'text/html');
  document.documentElement.replaceWith(document.importNode(doc.documentElement, true));
  return document.querySelector<HTMLFormElement>('form.search')!;
}

const key = (el: Element, k: string): KeyboardEvent => {
  const ev = new KeyboardEvent('keydown', {
    key: k,
    bubbles: true,
    cancelable: true,
  });
  el.dispatchEvent(ev);
  return ev;
};

describe('SearchBox', () => {
  let form: HTMLFormElement;
  let input: HTMLInputElement;
  let list: HTMLUListElement;
  let load: ReturnType<typeof vi.fn<() => Promise<readonly SearchEntry[]>>>;
  let navigate: ReturnType<typeof vi.fn<(href: string) => void>>;
  let box: SearchBox;

  beforeEach(() => {
    form = mountPage();
    input = form.querySelector('.search-input')!;
    list = form.querySelector('.search-results')!;
    load = vi.fn(() => Promise.resolve(ENTRIES));
    navigate = vi.fn();
    box = new SearchBox(form, { load, navigate });
  });

  const type = (text: string): void => {
    input.value = text;
    input.dispatchEvent(new Event('input', { bubbles: true }));
  };

  it('fetches the index once, on the first focus', async () => {
    expect(load).not.toHaveBeenCalled();
    input.dispatchEvent(new FocusEvent('focus'));
    input.dispatchEvent(new FocusEvent('focus'));
    await box.ready();
    expect(load).toHaveBeenCalledTimes(1);
  });

  it('fills and opens the list, the first result active', async () => {
    input.dispatchEvent(new FocusEvent('focus'));
    await box.ready();
    type('mpls');
    expect(list.hidden).toBe(false);
    expect(input.getAttribute('aria-expanded')).toBe('true');
    const rows = [...list.querySelectorAll('li.search-result')];
    expect(rows.map((r) => r.querySelector('.search-name')!.textContent)).toEqual(['Mpls', 'parseMpls', 'openDisc']);
    expect(rows.map((r) => r.getAttribute('aria-selected'))).toEqual(['true', 'false', 'false']);
    expect(rows[1]!.querySelector('a')!.getAttribute('href')).toBe('/developers/bdmv/parseMpls');
    expect(rows[1]!.querySelector('.search-pkg')!.textContent).toBe('@seikou/bdmv');
    expect(input.getAttribute('aria-activedescendant')).toBe(rows[0]!.id);
  });

  it('shows a query typed before the index arrived once it does', async () => {
    type('clpi');
    expect(list.querySelector('.search-empty')!.textContent).toBe('Loading the exports…');
    await box.ready();
    expect(box.shown().map((e) => e.name)).toEqual(['parseClpi']);
  });

  it('moves with the arrow keys, wrapping, and Enter goes to the active result', async () => {
    await box.ready();
    type('mpls');
    expect(key(input, 'ArrowDown').defaultPrevented).toBe(true);
    expect(box.activeIndex()).toBe(1);
    key(input, 'ArrowDown');
    key(input, 'ArrowDown');
    expect(box.activeIndex()).toBe(0);
    key(input, 'ArrowUp');
    expect(box.activeIndex()).toBe(2);
    expect(list.querySelectorAll('[aria-selected="true"]')).toHaveLength(1);
    key(input, 'ArrowDown');
    key(input, 'ArrowDown');
    key(input, 'Enter');
    expect(navigate).toHaveBeenCalledWith('/developers/bdmv/parseMpls');
  });

  it('closes on Escape, then a second Escape clears the field', async () => {
    await box.ready();
    type('mpls');
    key(input, 'Escape');
    expect(list.hidden).toBe(true);
    expect(input.getAttribute('aria-expanded')).toBe('false');
    expect(input.hasAttribute('aria-activedescendant')).toBe(false);
    key(input, 'Enter');
    expect(navigate).not.toHaveBeenCalled();
    key(input, 'Escape');
    expect(input.value).toBe('');
  });

  it('says when nothing matches, and Enter then goes nowhere', async () => {
    await box.ready();
    type('zzz');
    expect(list.querySelector('li.search-empty')!.textContent).toBe('No export matches');
    key(input, 'Enter');
    expect(navigate).not.toHaveBeenCalled();
  });

  it('closes when focus leaves the form, not when it moves to a result', async () => {
    await box.ready();
    type('mpls');
    const link = list.querySelector('a')!;
    form.dispatchEvent(new FocusEvent('focusout', { relatedTarget: link }));
    expect(list.hidden).toBe(false);
    form.dispatchEvent(new FocusEvent('focusout', { relatedTarget: document.body }));
    expect(list.hidden).toBe(true);
  });

  it('shows the summary as text, never as markup', async () => {
    box.dispose();
    box = new SearchBox(form, {
      load: () => Promise.resolve([entry('x', 'evil', '<img src=x onerror=alert(1)>')]),
      navigate,
    });
    await box.ready();
    type('evil');
    expect(list.querySelector('img')).toBeNull();
    expect(list.querySelector('.search-summary')!.textContent).toBe('<img src=x onerror=alert(1)>');
  });
});

describe('bindThemeSwitch', () => {
  it('checks the stored choice, and a change stores and applies it', () => {
    mountPage();
    const store = new Map<string, string>([['bluray-web:theme', 'dark']]);
    const storage = {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => void store.set(k, v),
    } as unknown as Storage;
    const media = {
      matches: true,
      addEventListener: vi.fn(),
    } as unknown as MediaQueryList;
    bindThemeSwitch(document, {
      storage: () => storage,
      matchMedia: () => media,
    });
    const radio = (v: string): HTMLInputElement => document.querySelector(`.theme-switch input[value="${v}"]`)!;
    expect(radio('dark').checked).toBe(true);
    expect(radio('auto').checked).toBe(false);
    radio('auto').checked = true;
    radio('auto').dispatchEvent(new Event('change'));
    expect(store.get('bluray-web:theme')).toBe('auto');
    expect(document.documentElement.dataset.theme).toBe('light');
    expect(document.querySelector('meta[name="theme-color"]')!.getAttribute('content')).toBe('#f6f8fe');
  });
});
