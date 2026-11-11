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

/** Every block of declarations, with the preludes of the at-rules around it (outermost first), matched by balanced braces. */
function blocks(source: string): { selector: string; body: string; within: string[] }[] {
  const out: { selector: string; body: string; within: string[] }[] = [];
  const stack: string[] = [];
  let start = 0;
  for (let i = 0; i < source.length; i++) {
    const c = source[i];
    if (c === '{') {
      const prelude = source.slice(start, i).trim();
      if (prelude.startsWith('@')) {
        stack.push(prelude);
        start = i + 1;
        continue;
      }
      const end = source.indexOf('}', i);
      out.push({ selector: prelude, body: source.slice(i + 1, end), within: [...stack] });
      i = end;
      start = i + 1;
    } else if (c === '}') {
      stack.pop();
      start = i + 1;
    }
  }
  return out;
}

/** The colour-bearing declarations' values, with var() and the keywords that are not colours taken out. */
function colourWords(source: string): string[] {
  const keep = /^(?:none|solid|dotted|dashed|double|underline|inherit|initial|unset|currentcolor|auto|from-font)$/i;
  const words: string[] = [];
  for (const { body } of blocks(source))
    for (const m of body.matchAll(/(?:^|;)\s*((?:background|color|border|outline|text-decoration|box-shadow|fill|stroke|caret-color|accent-color|scrollbar-color|column-rule)[\w-]*)\s*:\s*([^;]+)/g)) {
      if (/^border(?:-[a-z]+)*-(?:collapse|spacing|radius|width|style)$/.test(m[1]!)) continue;
      const value = m[2]!.replace(/var\([^)]*\)/g, ' ').replace(/!important/g, ' ');
      for (const w of value.match(/[a-z][a-z-]*/gi) ?? []) if (!keep.test(w) && !/^(?:px|em|rem|ch|vh|vw|s|ms)$/.test(w)) words.push(`${m[1]}: ${w}`);
    }
  return words;
}

/** Selectors whose declarations move something outside a `prefers-reduced-motion: no-preference` at-rule. */
function motionOutsideNoPreference(source: string): string[] {
  return blocks(source)
    .filter(({ body, within }) => /\b(?:animation|transition)(?:-[\w-]+)?\s*:|scroll-behavior\s*:\s*smooth/.test(body) && !within.some((w) => /prefers-reduced-motion:\s*no-preference/.test(w)))
    .map((b) => b.selector);
}

describe("the developer site's stylesheet", () => {
  it('takes every colour from the shared tokens, so the light values are the ones theme-contrast.test.ts checks', () => {
    expect(css.match(/#[0-9a-f]{3,8}\b|\b(?:rgba?|hsla?|hwb|oklch|oklab|lab|lch|color-mix|color)\(/gi) ?? []).toEqual([]);
    expect(colourWords(css)).toEqual([]);
    const defined = new Set([...`${tokens}\n${css}`.matchAll(/(--[\w-]+)\s*:/g)].map((m) => m[1]));
    const used = new Set([...css.matchAll(/var\((--[\w-]+)/g)].map((m) => m[1]));
    expect([...used].filter((t) => !defined.has(t))).toEqual([]);
  });

  it('draws the edges of fields, the switch and the code wells with the control border (3:1 in light)', () => {
    for (const selector of ['.search-input', '.theme-switch', '.signature, .code, .prose pre']) expect(rule(selector), selector).toMatch(/border: 1px solid var\(--control-rim\)/);
  });

  it('moves the read head only when reduced motion is not asked for', () => {
    expect(motionOutsideNoPreference(css)).toEqual([]);
    expect(blocks(css).some(({ body, within }) => /animation: read-head/.test(body) && within.some((w) => /no-preference/.test(w)))).toBe(true);
  });

  it('finds motion and named colours anywhere in the file, nested at-rules included', () => {
    const early = css.replace('.dev-nav a {', '.dev-nav a { transition: color 200ms;');
    expect(motionOutsideNoPreference(early)).toContain('.dev-nav a');
    expect(motionOutsideNoPreference('@media (prefers-reduced-motion: no-preference) { .a { animation: x 1s; } }\n.b { transition: color 1s; }')).toEqual(['.b']);
    expect(motionOutsideNoPreference('@media (max-width: 1px) { @media (prefers-reduced-motion: no-preference) { .a { animation: x 1s; } } }')).toEqual([]);
    expect(colourWords('.a { color: red; } .b { border: 1px solid var(--rim); color: currentColor; }')).toEqual(['color: red']);
    expect('.a { background: hwb(0 0% 0%); }'.match(/\bhwb\(/)).not.toBeNull();
  });

  it('styles every class the mocks use (the markup contract the page templates follow)', () => {
    const plain = new Set(['tok-n']); // numbers stay in the code's own colour
    const used = new Set(mocks.flatMap((html) => [...html.matchAll(/class="([^"]+)"/g)].flatMap((m) => m[1]!.split(/\s+/))));
    expect([...used].filter((c) => !plain.has(c) && !new RegExp(`\\.${c}(?![\\w-])`).test(css))).toEqual([]);
  });
});
