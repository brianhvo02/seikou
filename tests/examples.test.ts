// SPDX-License-Identifier: LGPL-3.0-or-later
import { existsSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';
import { exampleFiles, exampleProblems, loadSite, type DevPackage } from '../vite/devsite/model';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const modelPath = resolve(root, '.cache/devsite/model.json');

describe('node examples', () => {
  // Browser examples (*.browser.ts) run in tests/e2e/examples.spec.ts.
  for (const file of exampleFiles(root).filter((f) => !f.endsWith('.browser.ts'))) {
    it(file, async () => {
      const mod = (await import(pathToFileURL(join(root, file)).href)) as { default?: unknown };
      expect(typeof mod.default, `${file} must export default async function example()`).toBe('function');
      await (mod.default as () => Promise<void>)();
    });
  }
});

describe('example check', () => {
  it('reports an example that imports a package subpath', () => {
    const dir = mkdtempSync(join(tmpdir(), 'examples-'));
    try {
      mkdirSync(join(dir, 'packages/bdmv/examples'), { recursive: true });
      writeFileSync(
        join(dir, 'packages/bdmv/examples/deep.ts'),
        "import { parseMpls } from '@seikou/bdmv/mpls-parser';\nimport { readFile } from 'node:fs/promises';\nexport default async function example(): Promise<void> { void parseMpls; void readFile; }\n",
      );
      const site: DevPackage[] = [{ name: 'bdmv', readme: '', exports: [] }];
      const problems = exampleProblems(site, dir);
      expect(problems.some((p) => p.includes('imports @seikou/bdmv/mpls-parser'))).toBe(true);
      expect(problems.some((p) => p.includes('node:fs/promises'))).toBe(false);
      expect(problems.some((p) => p.includes('deep.ts is named by no export'))).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('every example imports only package roots', () => {
    expect(exampleProblems([], root).filter((p) => p.includes('imports'))).toEqual([]);
  });

  // Locally the model is optional (npm run devsite:model builds it); CI builds it first, so there its absence fails.
  const present = existsSync(modelPath);
  const model = present || process.env.CI ? it : it.skip;
  model('every public function has an example', () => {
    expect(present, `${modelPath} is missing; run npm run devsite:install && npm run devsite:model`).toBe(true);
    const problems = exampleProblems(loadSite(modelPath, root), root);
    expect(problems).toEqual([]);
  });
});
