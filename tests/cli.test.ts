// SPDX-License-Identifier: LGPL-3.0-or-later
import { execFileSync } from 'node:child_process';
import { expect, it } from 'vitest';

it('plan prints the chapter table of disc1', () => {
  const text = execFileSync('npx', ['tsx', 'src/cli.ts', 'plan', 'fixtures/disc1', '--playlist', '00000']).toString();
  expect(text).toContain('1  00:00.000  00001');
  expect(text).toContain('4  00:06.000  00002');
}, 60_000);

it('rejects a bad episode spec with exit code 2', () => {
  expect(() => execFileSync('npx', ['tsx', 'src/cli.ts', 'encode', 'fixtures/disc1', '--playlist', '00000', '--episodes', '3-2', '--out', '/tmp/x'], { stdio: 'pipe' })).toThrowError(expect.objectContaining({ status: 2 }));
}, 60_000);
