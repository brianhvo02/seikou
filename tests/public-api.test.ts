// SPDX-License-Identifier: LGPL-3.0-or-later
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { PACKAGES, UNKNOWN_NAMES, barrelNames, exportedNames, guideNames, importedRootNames, approvedApi, expandUnknown, requiredApi, rootImports } from '../scripts/public-api';

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

  it('collects binding names only, and export * leaves default behind', () => {
    const dir = mkdtempSync(join(tmpdir(), 'public-api-'));
    writeFileSync(
      join(dir, 'a.ts'),
      "export const x: Foo = 1;\nexport const { q: r, ...rest } = o;\nexport const [a1, , b1 = 2] = arr;\nexport default function d() {}\n",
    );
    writeFileSync(join(dir, 'index.ts'), "export * from './a';\nexport * as ns from './a';\n");
    expect([...exportedNames(join(dir, 'a.ts'))].sort()).toEqual(['a1', 'b1', 'default', 'r', 'rest', 'x']);
    expect([...exportedNames(join(dir, 'index.ts'))].sort()).toEqual(['a1', 'b1', 'ns', 'r', 'rest', 'x']);
  });

  it('requires every barrel name when a consumer imports a namespace', () => {
    expect([...expandUnknown(new Set([UNKNOWN_NAMES, 'a']), new Set(['a', 'b', 'c']))].sort()).toEqual(['a', 'b', 'c']);
    expect([...expandUnknown(new Set(['a']), new Set(['a', 'b']))]).toEqual(['a']);
  });

  it('throws for a guide block that does not parse, naming its first line', () => {
    const dir = mkdtempSync(join(tmpdir(), 'public-api-'));
    const guide = join(dir, 'g.md');
    const player = join(dir, 'p.ts');
    writeFileSync(player, "import { a } from '@seikou/pg';\n");
    writeFileSync(guide, "```ts\nimport { b } from '@seikou/ass';\n```\n```ts\nconst broken = ;\n```\n");
    expect(() => guideNames(guide, player)).toThrow(/const broken = ;/);
    writeFileSync(guide, "```ts\nimport { b } from '@seikou/ass';\n```\n```sh\nnot ts (\n```\n");
    expect([...(guideNames(guide, player).get('ass') ?? [])]).toEqual(['b']);
  });

  it('reads the repository and the guide', () => {
    expect(rootImports().size).toBeGreaterThan(0);
    expect(guideNames().size).toBeGreaterThan(0);
  });
});

// A package with no public-api.txt yet is expected to fail; writing its list flips the case to a plain pass.
describe('a package exports exactly its approved public API', () => {
  for (const pkg of PACKAGES) {
    const run = approvedApi(pkg) === null ? it.fails : it;
    run(pkg, () => {
      const approved = approvedApi(pkg);
      expect(approved, `packages/${pkg}/public-api.txt`).not.toBeNull();
      const list = approved ?? new Set<string>();
      expect([...requiredApi(pkg)].filter((n) => !list.has(n)).sort(), 'required names missing from the list').toEqual([]);
      expect([...barrelNames(pkg)].sort()).toEqual([...list].sort());
    });
  }
});
