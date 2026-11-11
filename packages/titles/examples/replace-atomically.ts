// SPDX-License-Identifier: LGPL-3.0-or-later
// Write a file so a reader never sees half of it: a synced temp file is renamed over the old one.
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { replaceAtomically } from '@seikou/titles';

export default async function example(): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), 'seikou-atomic-'));
  try {
    const file = join(dir, 'state.json');
    replaceAtomically(file, JSON.stringify({ gate: 'owners' }));
    replaceAtomically(file, JSON.stringify({ gate: 'everyone' }));
    console.log(readFileSync(file, 'utf8'), readdirSync(dir));
    if (readFileSync(file, 'utf8') !== '{"gate":"everyone"}' || readdirSync(dir).length !== 1) throw new Error('the file was not replaced cleanly');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
