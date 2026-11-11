// SPDX-License-Identifier: LGPL-3.0-or-later
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const dir = join(process.cwd(), 'vite/devsite');
const css = readFileSync(join(dir, 'site.css'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
const tokens = readFileSync(join(process.cwd(), 'src/ui/tokens.css'), 'utf8');
const mocks = readdirSync(join(dir, '__fixtures__'))
  .filter((f) => /^mock.*\.html$/.test(f))
  .map((f) => readFileSync(join(dir, '__fixtures__', f), 'utf8'));

/** The declarations of the first rule whose selector list is exactly `selector`. */
function rule(selector: string): string {
  const at = css.indexOf(`\n${selector} {`);
  return at < 0 ? '' : css.slice(css.indexOf('{', at) + 1, css.indexOf('}', at));
}

describe("the developer site's stylesheet", () => {
  it('takes every colour from the shared tokens, so the light values are the ones theme-contrast.test.ts checks', () => {
    expect(css.match(/#[0-9a-f]{3,8}\b|\b(?:rgba?|hsla?|oklch|lab|lch|color-mix)\(/gi) ?? []).toEqual([]);
    const defined = new Set([...`${tokens}\n${css}`.matchAll(/(--[\w-]+)\s*:/g)].map((m) => m[1]));
    const used = new Set([...css.matchAll(/var\((--[\w-]+)/g)].map((m) => m[1]));
    expect([...used].filter((t) => !defined.has(t))).toEqual([]);
  });

  it('draws the edges of fields, the switch and the code wells with the control border (3:1 in light)', () => {
    for (const selector of ['.search-input', '.theme-switch', '.signature, .code, .prose pre']) expect(rule(selector), selector).toMatch(/border: 1px solid var\(--control-rim\)/);
  });

  it('moves the read head only when reduced motion is not asked for', () => {
    const outside = css.replace(/@media \(prefers-reduced-motion: no-preference\) \{[\s\S]*?\n\}/g, '');
    expect(outside).not.toMatch(/animation:|transition:|scroll-behavior: smooth/);
    expect(css).toMatch(/@media \(prefers-reduced-motion: no-preference\) \{[^}]*animation: read-head/);
  });

  it('styles every class the mocks use (the markup contract the page templates follow)', () => {
    const plain = new Set(['tok-n']); // numbers stay in the code's own colour
    const used = new Set(mocks.flatMap((html) => [...html.matchAll(/class="([^"]+)"/g)].flatMap((m) => m[1]!.split(/\s+/))));
    expect([...used].filter((c) => !plain.has(c) && !new RegExp(`\\.${c}(?![\\w-])`).test(css))).toEqual([]);
  });
});
