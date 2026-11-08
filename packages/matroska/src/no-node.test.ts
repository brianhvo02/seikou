// SPDX-License-Identifier: LGPL-3.0-or-later
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';

it('the package imports nothing from node and uses no Buffer', () => {
  const dir = dirname(fileURLToPath(import.meta.url));
  const sources = readdirSync(dir).filter((f) => f.endsWith('.ts') && !f.endsWith('.test.ts') && f !== 'test-io.ts');
  expect(sources.length).toBeGreaterThan(5);
  for (const file of sources) {
    const text = readFileSync(join(dir, file), 'utf8');
    expect(text, file).not.toMatch(/['"]node:/);
    expect(text, file).not.toMatch(/\bBuffer\b/);
  }
});
