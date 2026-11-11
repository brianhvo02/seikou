// SPDX-License-Identifier: LGPL-3.0-or-later
// Read byte ranges of a disc's files from a server that speaks the disc API, refreshing the token on a 401.
import { readFile, readdir } from 'node:fs/promises';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { HttpTransport, RemoteDiscError } from '@seikou/engine';

const DISC = new URL('../../../fixtures/synthetic/disc1/', import.meta.url);

export default async function example(): Promise<void> {
  // A stand-in for the NAS's files route: `files/<path>?t=<token>` answered by Range, 404 `disc-changed` for a stale clip.
  let valid = 'token-1';
  // the API names files in upper case, as the manifest lists them
  const onDisk = new Map((await readdir(DISC, { recursive: true })).map((p) => [p.toUpperCase(), p]));
  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    if (url.searchParams.get('t') !== valid) return void res.writeHead(401).end();
    const path = decodeURIComponent(url.pathname.replace(/^\/discs\/disc1\/files\//, ''));
    if (path === 'BDMV/STREAM/00002.M2TS') return void res.writeHead(404, { 'Content-Type': 'application/json' }).end('{"error":"disc-changed"}');
    const name = onDisk.get(path);
    const bytes = name ? await readFile(new URL(name, DISC)).catch(() => null) : null;
    const [, a, b] = /bytes=(\d+)-(\d+)/.exec(req.headers.range ?? '') ?? [];
    if (!bytes || a === undefined) return void res.writeHead(404).end();
    if (Number(a) >= bytes.length) return void res.writeHead(416).end();
    res.writeHead(206).end(bytes.subarray(Number(a), Number(b) + 1));
  });
  await new Promise<void>((ok) => server.listen(0, '127.0.0.1', ok));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/discs/disc1/`;
  try {
    // #region construct
    const transport = new HttpTransport(base, 'token-1', {
      fetch,
      // asked once when a request answers 401; a rejection means the device is no longer paired
      refreshToken: async () => 'token-2',
    });
    // #endregion

    // #region read
    const head = await transport.read('BDMV/INDEX.BDMV', 0, 8);
    console.log(new TextDecoder().decode(head)); // INDX0200: the file's type and version
    // #endregion
    if (!new TextDecoder().decode(head).startsWith('INDX')) throw new Error('not the index');

    valid = 'token-2'; // the server moved to a new session: the next read meets a 401 and refreshes
    const clip = await transport.read('BDMV/STREAM/00001.M2TS', 0, 192);
    if (clip.length !== 192 || clip[4] !== 0x47) throw new Error('the refreshed read did not return a source packet');

    // #region setToken
    // a token the page refreshed on its own schedule: later requests carry it
    valid = 'token-3';
    transport.setToken('token-3');
    // #endregion
    if ((await transport.read('BDMV/INDEX.BDMV', 0, 4)).length !== 4) throw new Error('the new token was not used');

    try {
      await transport.read('BDMV/STREAM/00002.M2TS', 0, 192);
      throw new Error('the stale clip was read');
    } catch (err) {
      if (!(err instanceof RemoteDiscError) || err.reason !== 'disc-changed') throw err;
      console.log(err.reason, err.code, err.message);
    }
  } finally {
    server.close();
  }
}
