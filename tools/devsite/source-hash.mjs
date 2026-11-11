// SPDX-License-Identifier: LGPL-3.0-or-later
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';

/**
 * SHA-256 over every tracked or untracked (not ignored) file under `packages/<name>/src`, `packages/<name>/README.md` and
 * `packages/<name>/examples`, sorted by path, each fed as `<path>\0<bytes>\0`. The model's
 * `seikouSourceHash` and the developer site's loader both compute it, so a model built from other
 * sources is noticed.
 *
 * @param {string} root the repository root
 * @returns {string} the hash as lower-case hex
 */
export function sourceHash(root) {
  const listed = execFileSync(
    'git',
    ['ls-files', '-z', '--cached', '--others', '--exclude-standard', '--', ':(glob)packages/*/src/**', ':(glob)packages/*/README.md', ':(glob)packages/*/examples/**'],
    { cwd: root, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 },
  );
  const files = [...new Set(listed.split('\0').filter(Boolean))].sort();
  const hash = createHash('sha256');
  for (const file of files) {
    hash.update(`${file}\0`);
    hash.update(readFileSync(`${root}/${file}`));
    hash.update('\0');
  }
  return hash.digest('hex');
}
