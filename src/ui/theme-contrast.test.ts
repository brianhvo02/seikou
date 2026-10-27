import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const css = readFileSync(join(process.cwd(), 'src/ui/styles.css'), 'utf8');

/** The custom properties declared in the first block whose selector is exactly `selector`. */
function block(selector: string): Map<string, string> {
  const at = css.search(new RegExp(`(^|\\n)${selector.replace(/[[\]'().*]/g, '\\$&')}\\s*\\{`));
  if (at < 0) return new Map();
  const body = css.slice(css.indexOf('{', at) + 1, css.indexOf('\n}', at));
  const out = new Map<string, string>();
  for (const m of body.matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)) out.set(m[1]!, m[2]!.trim());
  const scheme = /(?:^|[\s;])color-scheme\s*:\s*([^;]+);/.exec(body);
  if (scheme) out.set('color-scheme', scheme[1]!.trim());
  return out;
}

const dark = block(':root');
const light = block(":root[data-theme='light']");

/** sRGB hex (#rgb or #rrggbb) to WCAG relative luminance. */
function luminance(hex: string): number {
  const h = hex.length === 4 ? [...hex.slice(1)].map((c) => c + c).join('') : hex.slice(1);
  const [r, g, b] = [0, 2, 4].map((i) => {
    const c = parseInt(h.slice(i, i + 2), 16) / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r! + 0.7152 * g! + 0.0722 * b!;
}

function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi! + 0.05) / (lo! + 0.05);
}

/** A light token's value, resolved through var() to a hex colour. */
function lightColor(token: string): string {
  let v = light.get(token) ?? dark.get(token);
  for (let i = 0; v?.startsWith('var(') && i < 5; i++) v = light.get(v.slice(4, -1)) ?? dark.get(v.slice(4, -1));
  if (!v || !/^#[0-9a-f]{3,6}$/i.test(v)) throw new Error(`${token} is not a hex colour in light: ${v}`);
  return v;
}

const TODAY: Record<string, string> = {
  '--night': '#0a1330', '--night-deep': '#070e26', '--deep': '#101c46', '--deep-2': '#18265a', '--rim': '#24356f', '--rim-strong': '#3a4f96',
  '--ice': '#edf1ff', '--mist': '#9eaad6', '--laser': '#5b8cff', '--laser-strong': '#7ba3ff', '--on-laser': '#06102e',
  '--amber': '#ffc861', '--red': '#ff8f8f', '--green': '#6fdc9a',
};

/** Tokens outside the player that need a light value (the spec's table and the ones the audit moved literals onto). */
const THEMED = [
  ...Object.keys(TODAY), '--veil', '--hover', '--placeholder', '--error-bg', '--error-rim', '--selected', '--notice-bg', '--hairline', '--hairline-strong',
  '--track', '--glass', '--poster-fg',
];

const GROUNDS = ['--night', '--night-deep', '--deep', '--deep-2'];

describe('the light palette', () => {
  it('keeps every dark value as it is today', () => {
    for (const [token, value] of Object.entries(TODAY)) expect(dark.get(token), token).toBe(value);
  });

  it('gives every themed token a light value and sets the light colour scheme', () => {
    for (const token of THEMED) {
      expect(dark.has(token), `${token} in :root`).toBe(true);
      expect(light.has(token), `${token} in light`).toBe(true);
    }
    expect(light.get('color-scheme')).toBe('light');
  });

  it('keeps text at 4.5:1 on every light ground', () => {
    for (const ground of GROUNDS)
      for (const text of ['--ice', '--mist', '--laser-strong', '--amber', '--red', '--green', '--placeholder'])
        expect(contrast(lightColor(text), lightColor(ground)), `${text} on ${ground}`).toBeGreaterThanOrEqual(4.5);
    expect(contrast(lightColor('--on-laser'), lightColor('--laser')), '--on-laser on --laser').toBeGreaterThanOrEqual(4.5);
    expect(contrast(lightColor('--ice'), lightColor('--error-bg')), '--ice on --error-bg').toBeGreaterThanOrEqual(4.5);
    expect(contrast(lightColor('--ice'), lightColor('--selected')), '--ice on --selected').toBeGreaterThanOrEqual(4.5);
    expect(contrast(lightColor('--ice'), lightColor('--notice-bg')), '--ice on --notice-bg').toBeGreaterThanOrEqual(4.5);
  });

  it('keeps control borders and the focus ring at 3:1', () => {
    for (const ground of GROUNDS)
      for (const line of ['--rim-strong', '--laser']) expect(contrast(lightColor(line), lightColor(ground)), `${line} on ${ground}`).toBeGreaterThanOrEqual(3);
  });
});
