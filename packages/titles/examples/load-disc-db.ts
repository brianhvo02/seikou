// SPDX-License-Identifier: LGPL-3.0-or-later
// Look a disc up by its content fingerprint in a TheDiscDB index file (a made-up one here).
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadDiscDb } from '@seikou/titles';

export default async function example(): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), 'seikou-discdb-'));
  try {
    const hash = 'A1B2C3D4E5F60718293A4B5C6D7E8F90';
    const file = join(dir, 'discdb-index.json');
    const hit = { title: 'Starfall Wanderer', year: 2021, kind: 'series', tmdbId: '990101', season: 1, episodes: [{ playlist: '00001', season: 1, episode: 1, name: 'Arrival' }] };
    writeFileSync(file, JSON.stringify({ source: { repo: 'made-up', commit: '0', license: 'MIT' }, discs: { [hash]: hit } }));

    const discdb = loadDiscDb(file);
    const found = discdb.lookup(hash.toLowerCase()); // fingerprints are compared in upper case
    console.log(found?.title, found?.episodes.length, discdb.lookup('0'.repeat(32)));
    if (found?.title !== 'Starfall Wanderer' || discdb.lookup('0'.repeat(32)) !== null) throw new Error('the lookup is wrong');

    writeFileSync(file, '{}');
    try {
      loadDiscDb(file);
      throw new Error('a file that is no index was accepted');
    } catch (error) {
      if (!(error instanceof Error) || !error.message.includes('not a TheDiscDB index')) throw error;
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
