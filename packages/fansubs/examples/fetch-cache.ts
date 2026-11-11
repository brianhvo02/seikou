// SPDX-License-Identifier: LGPL-3.0-or-later
// Keep downloads on disk by URL, so a track fetched once is not fetched again.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FetchCache } from '@seikou/fansubs';

export default async function example(): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), 'seikou-fetch-cache-'));
  try {
    // #region construct
    const cache = new FetchCache(dir, 1024 * 1024); // evicts the least recently used past 1 MiB
    // #endregion

    // #region get
    let downloads = 0;
    const download = async (): Promise<Buffer> => {
      downloads++;
      return Buffer.from('made-up track bytes');
    };
    const url = 'https://animetosho.net/storage/track-1.xz';
    const first = await cache.get(url, download);
    const second = await cache.get(url, download); // read from disk
    console.log(first.toString(), second.equals(first), 'downloads:', downloads);
    // #endregion
    if (downloads !== 1 || !second.equals(first)) throw new Error('the download was not cached');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
