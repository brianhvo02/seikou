// SPDX-License-Identifier: LGPL-3.0-or-later
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * BD-J is an optional provider of the engine (PlayerDeps.bdj, bdj-provider.ts): no file of this package names a BD-J
 * directory in a module specifier, at run time, for types or in tests, so no host's engine worker bundle can contain
 * BD-J unless the host passes a provider. The app's worker entry (src/engine-worker.ts) is outside the package.
 */
const SELF = fileURLToPath(import.meta.url);
const PACKAGE = join(dirname(SELF), '..');

function packageFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((d) => {
    const path = join(dir, d.name);
    if (d.isDirectory()) return d.name === 'node_modules' ? [] : packageFiles(path);
    return /\.tsx?$/.test(d.name) ? [path] : [];
  });
}

/**
 * Every module specifier a file names: static and type imports, re-exports, import(), new URL(), vi.mock() and its
 * kin (a mocked module is still a module the test names) and require(), quoted or template.
 */
function specifiers(source: string): string[] {
  const q = String.raw`(['"\`])((?:(?!\1)[^\\]|\\.)*)\1`;
  const patterns = [
    new RegExp(String.raw`\bfrom\s+${q}`, 'g'),
    new RegExp(String.raw`\bimport\s+${q}`, 'g'),
    new RegExp(String.raw`\bimport\s*\(\s*${q}`, 'g'),
    new RegExp(String.raw`\bnew\s+URL\s*\(\s*${q}`, 'g'),
    new RegExp(String.raw`\bvi\.(?:mock|doMock|unmock|importActual|importMock)\s*(?:<[^>]*>)?\s*\(\s*${q}`, 'g'),
    new RegExp(String.raw`\brequire(?:\.resolve)?\s*\(\s*${q}`, 'g'),
  ];
  const found: string[] = [];
  for (const re of patterns) for (const m of source.matchAll(re)) found.push(m[2]!);
  return found;
}

/** A specifier that reaches BD-J: a bdj/ directory, or the BD-J class library (bdj-classlib/). */
const BDJ_PATH = /bdj(?:-classlib)?\//;

describe('the engine package without BD-J', () => {
  it('finds specifiers of every form', () => {
    const source = [
      "import a from './bdj/a';",
      "import type { B } from \"../bdj/b\";",
      "export * from './bdj/c';",
      "import './bdj/d';",
      'const e = await import(`./bdj/${name}`);',
      "new Worker(new URL('./bdj/f.ts', import.meta.url));",
      "vi.mock('../bdj/g', () => ({}));",
      "const h = await vi.importActual<typeof import('x')>('./bdj/h');",
      "const i = require('../../src/bdj-classlib/i.jar');",
      "const j = require.resolve(\"./bdj/j\");",
    ].join('\n');
    expect(specifiers(source)).toEqual([
      './bdj/a', '../bdj/b', './bdj/c', './bdj/d', './bdj/${name}', 'x', './bdj/f.ts', '../bdj/g', './bdj/h',
      '../../src/bdj-classlib/i.jar', './bdj/j',
    ]);
  });

  it('tells BD-J paths from the engine\'s own bdj-provider and bdj-types', () => {
    const specs = ['./bdj/a', '../../src/bdj-classlib/rt-bdj.jar', 'src/bdj/provider', './bdj-provider', './bdj-types'];
    expect(specs.map((s) => BDJ_PATH.test(s))).toEqual([true, true, true, false, false]);
  });

  it('names no bdj/ or bdj-classlib/ path in any module specifier', () => {
    const offenders: string[] = [];
    // (this file's own specifier fixtures above are not imports)
    for (const file of packageFiles(PACKAGE).filter((f) => f !== SELF)) {
      const rel = relative(PACKAGE, file).split(sep).join('/');
      for (const spec of specifiers(readFileSync(file, 'utf8'))) {
        if (BDJ_PATH.test(spec)) offenders.push(`${rel}: ${spec}`);
      }
    }
    expect(offenders).toEqual([]);
  });
});
