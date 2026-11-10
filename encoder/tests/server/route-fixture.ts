// SPDX-License-Identifier: LGPL-3.0-or-later
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { request, type IncomingHttpHeaders } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { fixtureFansubSources } from '@seikou/fansubs/fixture-sources';
import type { ToolPaths } from '../../src/pipeline/chain';
import { startHelperServer, type AppContext, type HelperServer, type HelperSources } from '../../src/server/server';
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

/** What `send` and `call` take besides the path. */
export interface SendInit {
  method?: string;
  body?: string | Buffer;
  headers?: Record<string, string>;
  keepOpen?: boolean;
}

/**
 * A helper server over the speech disc and the recorded sources, with one helper session open on it, and request
 * functions that carry its token.
 */
export interface RouteFixture {
  readonly server: HelperServer;
  /** The app context the server runs with. */
  readonly app: AppContext;
  /** The open session's id. */
  readonly sessionId: string;
  /** The speech disc's key. */
  readonly discKey: string;
  /**
   * Sends a request with the token. `body` is sent whole; with `keepOpen` the request is left unfinished and
   * destroyed once the answer arrives, to test an answer given before the body is read.
   */
  send(path: string, init?: SendInit): Promise<Reply>;
  /** `send` to a path of the open session: `sub` is appended to `/api/sessions/<id>` (`''` is the session itself). */
  call(sub: string, init?: SendInit): Promise<Reply>;
  /** The run's data folder, removed by `stop`. */
  readonly dataDir: string;
  /** Stops the server and removes its data and page folders. */
  stop(): Promise<void>;
}

/**
 * Starts a helper server and opens a session on the speech disc's playlist 00000; `sources` replaces the recorded
 * sources it names, `tools` the missing tools (null by default), `episodeSpec` the session's episode list
 * (`1-3,4-5` by default), and `page` gives the server a page folder holding an index.html titled `helper`.
 */
export async function startRouteFixture(
  sources: Partial<HelperSources> = {},
  tools: ToolPaths | null = null,
  episodeSpec = '1-3,4-5',
  page = false,
): Promise<RouteFixture> {
  const dataDir = mkdtempSync(join(tmpdir(), 'helper-routes-'));
  const webDir = page ? mkdtempSync(join(tmpdir(), 'helper-web-')) : null;
  if (webDir !== null) writeFileSync(join(webDir, 'index.html'), '<!doctype html><title>helper</title>');
  const fansubs = fixtureFansubSources(FANSUBS);
  const anilist = fixtureAniList(FANSUBS);
  const app: AppContext = {
    dataDir,
    token: TOKEN,
    webDir,
    tools,
    sources: { seadex: fansubs.seadex, tosho: fansubs.tosho, anilist: anilist.source, episodes: anilist.episodes, covers: anilist.covers, ...sources },
    roots: [],
    nas: { client: null },
  };
  const server = await startHelperServer(app);
  const session = await server.sessions.create({ discDir: fx('fixtures/disc-speech'), playlistId: '00000', episodeSpec });
  const send = (path: string, init: SendInit = {}): Promise<Reply> =>
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
    });
  return {
    server,
    app,
    sessionId: session.id,
    discKey: session.discKey,
    dataDir,
    send,
    call: (sub, init) => send(`/api/sessions/${session.id}${sub}`, init),
    stop: async () => {
      await server.close();
      rmSync(dataDir, { recursive: true, force: true });
      if (webDir !== null) rmSync(webDir, { recursive: true, force: true });
    },
  };
}

/** The JSON body of a reply. */
export const jsonOf = <T>(reply: Reply): T => JSON.parse(reply.body.toString('utf8')) as T;
