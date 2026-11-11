// SPDX-License-Identifier: LGPL-3.0-or-later
// Cache posters in a folder within a byte budget, fetching each from an allowed host only once.
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ArtCache } from '@seikou/titles';

export default async function example(): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), 'seikou-art-'));
  try {
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);
    const asked: string[] = [];
    const recorded: typeof fetch = async (url) => {
      asked.push(String(url));
      return new Response(png, { headers: { 'content-type': 'image/png', 'content-length': String(png.length) } });
    };

    // #region construct
    const art = new ArtCache(dir, recorded, 10 * 1024 * 1024); // a 10 MB budget
    // #endregion

    // #region get
    const poster = 'https://image.tmdb.org/t/p/w342/lantern.jpg';
    const first = await art.get('abc123', 'small', poster);
    const again = await art.get('abc123', 'small', poster); // served from the folder
    console.log(first?.type, first && readFileSync(first.path).length, 'fetches:', asked.length);
    // #endregion
    if (first?.type !== 'image/png' || again?.path !== first.path || asked.length !== 1) throw new Error('the poster was not cached');

    // Only allowed hosts are fetched, over https.
    if ((await art.get('abc124', 'small', 'https://example.test/poster.png')) !== null || asked.length !== 1) throw new Error('a stranger host was fetched');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
