// SPDX-License-Identifier: LGPL-3.0-or-later
import { globSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { privateHistoryComments, undocumentedExports } from '../scripts/doc-check';
import { encoderDir } from './paths';

const files = [
  ...globSync('src/**/*.ts', { cwd: encoderDir }),
  ...globSync('web/src/**/*.{ts,tsx}', { cwd: encoderDir }),
]
  .filter((f) => !/\.test\.tsx?$/.test(f))
  .map((f) => join(encoderDir, f))
  .sort();

describe('documentation standard', () => {
  it('finds source files to check', () => {
    expect(files.length).toBeGreaterThan(10);
  });

  it('every export in encoder/src and encoder/web/src has a doc comment', () => {
    const missing = undocumentedExports(files).map((u) => `${u.file.replace(encoderDir, '')}:${u.line} ${u.name}`);
    expect(missing).toEqual([]);
  });

  it('no comment points at private planning history', () => {
    const found = privateHistoryComments(files).map((c) => `${c.file.replace(encoderDir, '')}:${c.line} ${c.text}`);
    expect(found).toEqual([]);
  });

  it('the checker finds what it should', () => {
    const dir = mkdtempSync(join(tmpdir(), 'doc-check-'));
    const a = join(dir, 'a.ts');
    writeFileSync(
      a,
      ['export function f() {}', 'export interface I { a: number }', '/** x */ export const c = 1;', 'export { c as d };'].join('\n'),
    );
    expect(undocumentedExports([a]).map((u) => u.name)).toEqual(['f', 'I']);

    const flagged = ['// see Task 7', '// M2 maps this', '// ruling R12', '// spec §4.2', '// milestone 3'];
    const fine = ['// RFC 9559 §5.1.4.1.28', '// AV1 spec 5.5.1', '// reads the .m2ts clip'];
    const b = join(dir, 'b.ts');
    writeFileSync(b, [...flagged, ...fine, "const s = 'Task 7 in a string';"].join('\n'));
    expect(privateHistoryComments([b]).map((c) => c.text)).toEqual(flagged);
  });
});
