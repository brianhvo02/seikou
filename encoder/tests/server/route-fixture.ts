// SPDX-License-Identifier: LGPL-3.0-or-later
import { mkdtempSync, rmSync } from 'node:fs';
import { request, type IncomingHttpHeaders } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { fixtureFansubSources } from '@seikou/fansubs/fixture-sources';
import { startHelperServer, type HelperContext, type HelperServer, type HelperSources } from '../../src/server/server';
import { fixtureAniList } from '../../src/subs/fixture-anilist';
import { fx } from '../paths';

const TOKEN = 'route-test-token';
const FANSUBS = fileURLToPath(new URL('../fixtures/fansubs/', import.meta.url));

/** A raw answer: status, headers and the whole body. */
export interface Reply {
  readonly status: number;
  readonly headers: IncomingHttpHeaders;
  readonly body: Buffer;
}

/** A helper server over the speech disc and the recorded sources, with a request function that carries its token. */
export interface RouteFixture {
  readonly server: HelperServer;
  /**
   * Sends a request with the token. `body` is sent whole; with `keepOpen` the request is left unfinished and
   * destroyed once the answer arrives, to test an answer given before the body is read.
   */
  send(path: string, init?: { method?: string; body?: string | Buffer; headers?: Record<string, string>; keepOpen?: boolean }): Promise<Reply>;
  /** Stops the server and removes its data folder. */
  stop(): Promise<void>;
}

/** Starts a helper server; `sources` replaces the recorded sources it names. */
export async function startRouteFixture(sources: Partial<HelperSources> = {}): Promise<RouteFixture> {
  const dataDir = mkdtempSync(join(tmpdir(), 'helper-routes-'));
  const fansubs = fixtureFansubSources(FANSUBS);
  const anilist = fixtureAniList(FANSUBS);
  const ctx: HelperContext = {
    discDir: fx('fixtures/disc-speech'),
    playlistId: '00000',
    episodeSpec: '1-3,4-5',
    dataDir,
    token: TOKEN,
    webDir: null,
    tools: null,
    sources: { seadex: fansubs.seadex, tosho: fansubs.tosho, anilist: anilist.source, episodes: anilist.episodes, ...sources },
  };
  const server = await startHelperServer(ctx);
  return {
    server,
    send: (path, init = {}) =>
      new Promise((resolve, reject) => {
        const req = request(
          { host: '127.0.0.1', port: server.port, path, method: init.method ?? 'GET', headers: { authorization: `Bearer ${TOKEN}`, ...init.headers } },
          (res) => {
            const chunks: Buffer[] = [];
            res.on('data', (c: Buffer) => chunks.push(c));
            res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks) }));
            res.on('error', reject);
          },
        );
        req.on('error', reject);
        if (init.keepOpen) {
          if (init.body !== undefined) req.write(init.body);
        } else req.end(init.body);
      }),
    stop: async () => {
      await server.close();
      rmSync(dataDir, { recursive: true, force: true });
    },
  };
}

/** The JSON body of a reply. */
export const jsonOf = <T>(reply: Reply): T => JSON.parse(reply.body.toString('utf8')) as T;
