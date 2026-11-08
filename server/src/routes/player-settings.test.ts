// SPDX-License-Identifier: LGPL-3.0-or-later
import { mkdtempSync, rmSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { appHandlers } from '../app';
import { Auth } from '../auth';
import { BdjStore } from '../bdj-store';
import { createServer } from '../http';
import { Library } from '../library';
import { PlayerSettingsStore } from '../player-settings-store';
import { Store } from '../store';

// Every name here is made up.

let tmp: string;
let base = '';
let close: (() => void) | undefined;
let auth: Auth;

beforeEach(async () => {
  tmp = mkdtempSync(join(tmpdir(), 'player-settings-routes-'));
  const data = join(tmp, 'data');
  auth = new Auth(new Store(data), Date.now);
  const library = new Library([], join(data, 'library.json'), { scanPauseMs: 0 });
  const server = createServer(appHandlers({ auth, library, bdjStore: new BdjStore(data), playerSettingsStore: new PlayerSettingsStore(data), publicBase: 'https://nas.example/bluray/api/' }));
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  close = () => {
    server.close();
    server.closeAllConnections();
  };
});
afterEach(() => {
  close?.();
  rmSync(tmp, { recursive: true, force: true });
});

async function tokenFor(name: string): Promise<string> {
  const pair = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign', 'verify']);
  const jwk = await crypto.subtle.exportKey('jwk', pair.publicKey);
  const { code } = auth.createCode({ newPerson: { name, owner: false } });
  const device = auth.redeem(code, `${name}'s phone`, jwk)!;
  const challenge = auth.challenge(device.id)!;
  const signature = Buffer.from(await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, pair.privateKey, new TextEncoder().encode(challenge))).toString('base64url');
  return auth.startSession(device.id, challenge, signature)!.token;
}

const call = (method: string, token: string | null, body?: string): Promise<Response> =>
  fetch(`${base}/api/me/player-settings`, { method, headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), 'Content-Type': 'application/json' }, body });

describe('player settings route', () => {
  it('player settings default to countdown off and are per person', async () => {
    const mika = await tokenFor('Mika');
    const sora = await tokenFor('Sora');
    expect((await call('GET', null)).status).toBe(401);
    expect(await (await call('GET', mika)).json()).toEqual({ nextEpisodeCountdown: false });
    const put = await call('PUT', mika, JSON.stringify({ nextEpisodeCountdown: true }));
    expect([put.status, await put.json()]).toEqual([200, { nextEpisodeCountdown: true }]);
    expect(await (await call('GET', mika)).json()).toEqual({ nextEpisodeCountdown: true });
    expect(await (await call('GET', sora)).json()).toEqual({ nextEpisodeCountdown: false });
  });

  it('answers 400 for any other body, 413 over the limit and 405 for other methods', async () => {
    const mika = await tokenFor('Mika');
    for (const body of ['{', '{}', '[]', 'null', '{"nextEpisodeCountdown":1}', '{"nextEpisodeCountdown":true,"x":1}']) expect((await call('PUT', mika, body)).status).toBe(400);
    expect((await call('PUT', mika, JSON.stringify({ nextEpisodeCountdown: true, pad: 'x'.repeat(8192) }))).status).toBe(413);
    expect((await call('POST', mika, '{}')).status).toBe(405);
    expect(await (await call('GET', mika)).json()).toEqual({ nextEpisodeCountdown: false });
  });
});
