// SPDX-License-Identifier: LGPL-3.0-or-later
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { PACKAGES, UNKNOWN_NAMES, barrelNames, exportedNames, guideNames, importedRootNames, publicApi, rootImports } from '../scripts/public-api';

describe('the public API helpers', () => {
  it('follows export * and export { } from, and counts the imported name of an alias', () => {
    const dir = mkdtempSync(join(tmpdir(), 'public-api-'));
    writeFileSync(join(dir, 'a.ts'), 'export function f() {}\nexport const g = 1;\nexport interface I {}\n');
    writeFileSync(join(dir, 'b.ts'), 'export const h = 1;\nexport const skipped = 2;\n');
    writeFileSync(join(dir, 'index.ts'), "export * from './a';\nexport { h as renamed, type T } from './b';\nexport type { U } from './b';\n");
    expect([...exportedNames(join(dir, 'index.ts'))].sort()).toEqual(['I', 'U', 'f', 'g', 'renamed', 'T'].sort());

    const into = importedRootNames(
      'x.ts',
      "import { x as y, type Z } from '@seikou/pg';\nimport * as ns from '@seikou/ass';\nimport { no } from '@seikou/pg/sub';\nconst m = await import('@seikou/nas');\nexport { q } from '@seikou/pg';\n",
    );
    expect([...(into.get('pg') ?? [])].sort()).toEqual(['Z', 'q', 'x']);
    expect([...(into.get('ass') ?? [])]).toEqual([UNKNOWN_NAMES]);
    expect([...(into.get('nas') ?? [])]).toEqual([UNKNOWN_NAMES]);
  });

  it('reads the repository and the guide', () => {
    expect(rootImports().size).toBeGreaterThan(0);
    expect(guideNames().size).toBeGreaterThan(0);
  });
});

// Task 2 narrows the barrels to the rule; each case flips from it.fails to it then.
describe('a barrel exports what integrators and the repository import from its root', () => {
  for (const pkg of PACKAGES) {
    it.fails(pkg, () => {
      expect([...barrelNames(pkg)].sort()).toEqual([...publicApi(pkg)].sort());
    });
  }
});
