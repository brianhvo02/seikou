// SPDX-License-Identifier: LGPL-3.0-or-later
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { oldNameComments, privateHistoryComments, stackedDocComments, undocumentedExports } from '../scripts/doc-check';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/**
 * The tracked `.ts` and `.tsx` files that match the globs, without tests, declaration files and
 * `src/bdj-classlib/`, sorted, as absolute paths.
 */
export function scopeFiles(globs: readonly string[]): string[] {
  const out = execFileSync('git', ['ls-files', '--', ...globs.map((g) => `:(glob)${g}`)], { cwd: root, encoding: 'utf8' });
  return out
    .split('\n')
    .filter((f) => /\.tsx?$/.test(f) && !/\.(test\.tsx?|d\.ts)$/.test(f) && !f.startsWith('src/bdj-classlib/'))
    .sort()
    .map((f) => resolve(root, f));
}

/**
 * Glob patterns, relative to the repository root, of the source the documentation standard covers:
 * every package, the app, the NAS server, the rendezvous Worker and the encoder. `scopeFiles` leaves
 * out tests, declaration files and `src/bdj-classlib/`. `src/ui/anime4k/` holds only the vendored
 * Anime4K shaders and their configs, no TypeScript, so it adds no file.
 */
export const SCOPE: readonly string[] = ['packages/*/src/**', 'src/**', 'server/src/**', 'rendezvous/src/**', 'encoder/src/**', 'encoder/web/src/**'];

function strip(file: string): string {
  return file.slice(root.length + 1);
}

describe('documentation standard', () => {
  const files = scopeFiles(SCOPE);
  it('finds the files in scope', () => expect(files.length).toBeGreaterThan(10));
  it('every export has a doc comment', () =>
    expect(undocumentedExports(files).map((u) => `${strip(u.file)}:${u.line} ${u.name}`)).toEqual([]));
  it('no comment points at private planning history', () =>
    expect(privateHistoryComments(files).map((c) => `${strip(c.file)}:${c.line} ${c.text}`)).toEqual([]));
  it('no declaration has two doc blocks stacked', () =>
    expect(stackedDocComments(files).map((c) => `${strip(c.file)}:${c.line} ${c.text}`)).toEqual([]));
  it('no comment uses the old name', () =>
    expect(oldNameComments(files).map((c) => `${strip(c.file)}:${c.line} ${c.text}`)).toEqual([]));
});

/** The fenced code block of `docs/integrating.md` between its example markers, or null when there is none. */
export function guideExample(markdown: string): string | null {
  const m = /<!-- example:minimal-player -->\n```ts\n([\s\S]*?)```\n<!-- \/example -->/.exec(markdown);
  return m ? m[1]! : null;
}

describe('integration guide', () => {
  it('shows the example player exactly as docs/integrating/minimal-player.ts holds it (without its SPDX line)', () => {
    const guide = readFileSync(resolve(root, 'docs/integrating.md'), 'utf8');
    const example = readFileSync(resolve(root, 'docs/integrating/minimal-player.ts'), 'utf8');
    expect(guideExample(guide)).toBe(example.replace(/^\/\/ SPDX-License-Identifier: [^\n]*\n/, ''));
  });
});
