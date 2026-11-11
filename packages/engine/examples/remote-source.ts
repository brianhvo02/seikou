// SPDX-License-Identifier: LGPL-3.0-or-later
// Read a server's disc with read-ahead through RemoteSource, and parse it as any ByteSource.
import { readFile, readdir, stat } from 'node:fs/promises';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { DiscManifest } from '@seikou/nas';
import { HttpTransport, RemoteSource, openDisc, type ChunkCache } from '@seikou/engine';
// Runs in a Vite or vitest project: the package root imports Vite's `?url` and `?worker&url` modules.

const DISC = new URL('../../../fixtures/synthetic/disc1/', import.meta.url);

export default async function example(): Promise<void> {
  // A stand-in for a server's disc API: the manifest (sizes, with the small files inlined) and range reads of the rest.
  const files = new Map<string, string>(); // upper-case path → path on disk
  for (const p of await readdir(DISC, { recursive: true })) if ((await stat(new URL(p, DISC))).isFile()) files.set(p.toUpperCase(), p);
  const manifest: DiscManifest = { discId: 'example', name: 'Example disc', files: [], inline: {} };
  for (const [path, onDisk] of files) {
    const bytes = await readFile(new URL(onDisk, DISC));
    (manifest.files as { path: string; size: number }[]).push({ path, size: bytes.length });
    if (!path.startsWith('BDMV/STREAM/')) (manifest.inline as Record<string, string>)[path] = bytes.toString('base64');
  }
  let requests = 0;
  let lastToken: string | null = null;
  const server = createServer(async (req, res) => {
    requests++;
    const url = new URL(req.url ?? '/', 'http://localhost');
    lastToken = url.searchParams.get('t');
    const onDisk = files.get(decodeURIComponent(url.pathname.replace(/^\/discs\/example\/files\//, '')));
    const [, a, b] = /bytes=(\d+)-(\d+)/.exec(req.headers.range ?? '') ?? [];
    if (!onDisk || a === undefined || url.searchParams.get('t') === null) return void res.writeHead(404).end();
    res.writeHead(206).end((await readFile(new URL(onDisk, DISC))).subarray(Number(a), Number(b) + 1));
  });
  await new Promise<void>((ok) => server.listen(0, '127.0.0.1', ok));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/discs/example/`;
  try {
    // #region construct
    // the manifest is what `GET <base>manifest` answers; 64 KiB chunks, two in flight, 256 KiB held at most
    const transport = new HttpTransport(base, 'token', { fetch });
    const source = new RemoteSource(manifest, transport, { chunkBytes: 64 * 1024, inFlight: 2, readAheadBytes: 256 * 1024 });
    // #endregion

    // #region exists
    console.log(source.exists('BDMV/index.bdmv'), source.exists('BDMV/JAR')); // true false: paths match without regard to case
    // #endregion
    // #region size
    const clipSize = source.size('BDMV/STREAM/00001.M2TS'); // from the manifest, no request
    console.log(clipSize, 'bytes');
    // #endregion
    // #region list
    console.log(source.list('BDMV/PLAYLIST')); // [ '00000.MPLS', '00001.MPLS' ]
    // #endregion
    // #region paths
    console.log(source.paths().length, 'files'); // every path the manifest lists, upper case
    // #endregion
    if (!source.exists('BDMV/index.bdmv') || source.list('BDMV/PLAYLIST').join() !== '00000.MPLS,00001.MPLS') throw new Error('unexpected listing');

    // openDisc reads only inlined files here, except a peek at the main clip's first packets
    const disc = await openDisc(source);
    console.log('main playlist', disc.summaries[0]?.id, 'after', requests, 'request');

    // #region peek
    // a few bytes, fetched exactly, with no read-ahead after them
    const packet = await source.peek('BDMV/STREAM/00002.M2TS', 0, 192);
    // #endregion
    if (packet[4] !== 0x47) throw new Error('not a source packet');

    // #region read
    const first = await source.read('BDMV/STREAM/00001.M2TS', 0, 6144); // the chunk holding it, then read-ahead after it
    // #endregion
    if (first.length !== 6144) throw new Error('short read');

    // #region isFetching
    console.log('next chunk in flight:', source.isFetching('BDMV/STREAM/00001.M2TS', 64 * 1024));
    // #endregion

    await new Promise((ok) => setTimeout(ok, 200)); // read-ahead lands
    // #region bufferedAhead
    const ahead = source.bufferedAhead('BDMV/STREAM/00001.M2TS'); // what the next reads will find in memory
    console.log(ahead.bytes, 'bytes ahead, to the end of the file:', ahead.toEnd);
    // #endregion
    if (ahead.bytes === 0 || ahead.bytes > 256 * 1024) throw new Error(`unexpected read-ahead ${ahead.bytes} of ${clipSize}`);

    // #region setToken
    source.setToken('fresh-token'); // a refreshed session token for the requests that follow
    // #endregion
    await source.read('BDMV/STREAM/00001.M2TS', 512 * 1024, 192); // a seek: a chunk not held, so a request goes out
    if (lastToken !== 'fresh-token') throw new Error(`the server saw token ${lastToken}`);

    // #region setCache
    // a ChunkCache keeps chunks beyond the memory budget (Seikou's is on disk, in the origin's private file system)
    const held = new Map<string, Uint8Array>();
    const cache: ChunkCache = {
      has: (path, offset, length) => held.get(`${path}@${offset}`)?.length === length,
      read: async (path, offset, length) => (held.get(`${path}@${offset}`)?.length === length ? held.get(`${path}@${offset}`)! : null),
      write: async (path, offset, bytes) => void held.set(`${path}@${offset}`, bytes),
    };
    source.setCache(cache);
    // #endregion

    // #region fillChunk
    // fill the cache ahead of playback, one chunk at a time; resolves with the bytes that came over the network
    const fetched = await source.fillChunk('BDMV/STREAM/00002.M2TS', 0, new AbortController().signal);
    console.log(fetched, 'bytes fetched;', await source.fillChunk('BDMV/STREAM/00002.M2TS', 0, new AbortController().signal), 'the second time');
    // #endregion
    if (fetched !== 64 * 1024 || !cache.has('BDMV/STREAM/00002.M2TS', 0, 64 * 1024)) throw new Error('the chunk was not cached');

    // #region setWriteThrough
    // chunks playback reads from the network are offered to the fill too, so it doesn't fetch them again
    const offered: number[] = [];
    source.setWriteThrough((path, offset, bytes) => {
      offered.push(offset);
      void cache.write(path, offset, bytes);
    });
    await source.read('BDMV/STREAM/00002.M2TS', 64 * 1024, 192);
    source.setWriteThrough(null);
    // #endregion
    if (!offered.includes(64 * 1024)) throw new Error('the read chunk was not offered');

    // #region close
    source.close(); // the disc was closed: fetches stop and later reads fail
    // #endregion
    const closed = await source.read('BDMV/STREAM/00001.M2TS', 1 << 20, 192).then(() => false, () => true);
    if (!closed) throw new Error('a closed source still reads');
  } finally {
    server.close();
  }
}
