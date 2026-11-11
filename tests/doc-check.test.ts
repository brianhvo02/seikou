// SPDX-License-Identifier: LGPL-3.0-or-later
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { codeChanges, oldNameComments, privateHistoryComments, undocumentedExports } from '../scripts/doc-check';

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), 'doc-check-'));
}

describe('the documentation checker', () => {
  it('finds what it should', () => {
    const dir = tempDir();
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

  it('flags Seikou history labels and leaves identifiers alone', () => {
    const flagged = ['// ruling T7h', '// as 5e decided', '// the M4b renderer', '// (R22)', '// M2b covers it', '// spec §7'];
    const fine = [
      '// reads M2TS packets',
      '// PSR22 holds the mode',
      '// byte 0x5e',
      '// RFC 9559 §5.1',
      '// type T1 = number',
      '// ISO/IEC 13818-1 §2.4.3.6',
    ];
    const file = join(tempDir(), 'h.ts');
    writeFileSync(file, [...flagged, ...fine].join('\n'));
    expect(privateHistoryComments([file]).map((c) => c.text)).toEqual(flagged);
  });

  it('flags the old name in comments, not in strings or code spans', () => {
    const file = join(tempDir(), 'n.ts');
    writeFileSync(
      file,
      [
        '// Original code for bluray-web: x',
        '/*',
        ' * Copyright (C) 2026  bluray-web contributors',
        ' */',
        '// the `bluray-web` IndexedDB database',
        "const db = 'bluray-web';",
      ].join('\n'),
    );
    expect(oldNameComments([file]).map((c) => c.text)).toEqual([
      '// Original code for bluray-web: x',
      '/*\n * Copyright (C) 2026  bluray-web contributors\n */',
    ]);
  });

  it('codeChanges sees code edits and ignores comment edits', () => {
    const dir = tempDir();
    const git = (...args: string[]): void => {
      execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { cwd: dir, stdio: 'ignore' });
    };
    const a = join(dir, 'a.ts');
    const b = join(dir, 'b.ts');
    const gone = join(dir, 'gone.ts');
    writeFileSync(a, "/** a */\nexport const a = 'x  y';\n");
    writeFileSync(b, 'export const b = 1;\n');
    writeFileSync(gone, 'export const g = 1;\n');
    git('init', '-q');
    git('add', '.');
    git('commit', '-q', '-m', 'base');

    writeFileSync(a, "/**\n * Rewritten comment.\n */\nexport const   a = 'x  y'; // trailing\n");
    writeFileSync(b, 'export const b = 2;\n');
    const added = join(dir, 'new.ts');
    const note = join(dir, 'new.md');
    writeFileSync(added, 'export const n = 1;\n');
    writeFileSync(note, '# new\n');
    execFileSync('rm', [gone]);
    expect(codeChanges('HEAD', [a, b, gone, added, note])).toEqual([b, gone, added]);

    writeFileSync(a, "/** a */\nexport const a = 'x y';\n");
    expect(codeChanges('HEAD', [a])).toEqual([a]);
  });

  it('codeChanges handles BigInt literals', () => {
    const dir = tempDir();
    const git = (...args: string[]): void => {
      execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { cwd: dir, stdio: 'ignore' });
    };
    const f = join(dir, 'big.ts');
    writeFileSync(f, 'export const n = 1n;\n');
    git('init', '-q');
    git('add', '.');
    git('commit', '-q', '-m', 'base');
    writeFileSync(f, '/** One. */\nexport const n = /* x */ 1n; // same\n');
    expect(codeChanges('HEAD', [f])).toEqual([]);
    writeFileSync(f, 'export const n = 2n;\n');
    expect(codeChanges('HEAD', [f])).toEqual([f]);
  });
});
