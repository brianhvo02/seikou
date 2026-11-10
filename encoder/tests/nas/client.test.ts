// SPDX-License-Identifier: LGPL-3.0-or-later
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { NasClient, NasError } from '../../src/nas/client';
import { writeNasPairing } from '../../src/nas/nas-store';
import { pairWithNas } from '../../src/nas/pairing';
import { startNasTestServer, type NasTestServer } from './nas-test-server';

/** A port nothing listens on: bound, then closed. */
async function closedPort(): Promise<number> {
  const s = createServer();
  await new Promise<void>((r) => s.listen(0, '127.0.0.1', r));
  const port = (s.address() as { port: number }).port;
  await new Promise<void>((r) => s.close(() => r()));
  return port;
}

describe('NasClient', () => {
  let nas: NasTestServer;
  let dataDir: string;
  beforeAll(async () => {
    nas = await startNasTestServer({ discs: false });
  });
  afterAll(async () => {
    await nas.close();
  });
  beforeEach(async () => {
    dataDir = mkdtempSync(join(tmpdir(), 'encoder-client-'));
  });
  afterEach(() => {
    rmSync(dataDir, { recursive: true, force: true });
  });

  /** Pairs as an owner and loads the client, counting the session tokens the NAS gives (by watching its answers). */
  async function paired(): Promise<{ client: NasClient; tokens: string[] }> {
    await pairWithNas(dataDir, { code: await nas.ownerCode('Mika Owner'), base: nas.base }, 'Seikou encoder on test');
    const tokens: string[] = [];
    const watching: typeof fetch = async (input, init) => {
      const res = await fetch(input, init);
      if (String(input).endsWith('/api/session') && res.ok) tokens.push(((await res.clone().json()) as { token: string }).token);
      return res;
    };
    const client = await NasClient.load(dataDir, watching);
    if (client === null) throw new Error('not paired');
    return { client, tokens };
  }

  it('is null when not paired', async () => {
    expect(await NasClient.load(dataDir)).toBeNull();
  });

  it('signs in once and answers me', async () => {
    const { client, tokens } = await paired();
    expect(client.base).toBe(nas.base);
    expect(client.personName).toBe('Mika Owner');
    expect(await client.me()).toEqual({ owner: true, personName: 'Mika Owner' });
    expect(await client.json('encodes/status')).toMatchObject({ configured: true });
    expect(tokens).toHaveLength(1);
  });

  it('signs in again once when the NAS has forgotten the session', async () => {
    const { client, tokens } = await paired();
    await client.me();
    nas.expireSessions();
    const res = await client.request('me');
    expect(res.status).toBe(200);
    expect(tokens).toHaveLength(2);
  });

  it('a closed port is unreachable', async () => {
    const { client } = await paired();
    const file = JSON.parse(readFileSync(join(dataDir, 'nas.json'), 'utf8')) as Parameters<typeof writeNasPairing>[1];
    await writeNasPairing(dataDir, { ...file, base: `http://127.0.0.1:${await closedPort()}/api/` });
    const gone = await NasClient.load(dataDir);
    await expect(gone!.me()).rejects.toMatchObject({ code: 'unreachable', status: null });
    await client.me();
  });

  it('an error answer throws http with the body error', async () => {
    const { client } = await paired();
    await expect(client.json('encodes/990001-9/manifest')).rejects.toMatchObject({ code: 'http', status: 404 });
  });

  it('a device the NAS no longer knows is unauthorized', async () => {
    const { client } = await paired();
    const file = JSON.parse(readFileSync(join(dataDir, 'nas.json'), 'utf8')) as Parameters<typeof writeNasPairing>[1];
    await writeNasPairing(dataDir, { ...file, deviceId: 'gone' });
    const stranger = await NasClient.load(dataDir);
    await expect(stranger!.me()).rejects.toMatchObject({ code: 'unauthorized' });
    await client.me();
  });

  /** Pairs, then loads the client with `fetchImpl` in front of the real fetch. */
  async function pairedWith(fetchImpl: typeof fetch): Promise<NasClient> {
    await pairWithNas(dataDir, { code: await nas.ownerCode(), base: nas.base }, 'Seikou encoder on test');
    return (await NasClient.load(dataDir, fetchImpl))!;
  }

  it("one caller's abort during the shared sign-in fails only that caller", async () => {
    let release!: () => void;
    const held = new Promise<void>((r) => (release = r));
    let challenged!: () => void;
    const challenging = new Promise<void>((r) => (challenged = r));
    const client = await pairedWith(async (input, init) => {
      if (String(input).endsWith('/session/challenge')) {
        challenged();
        await held;
      }
      return fetch(input, init);
    });
    const impatient = new AbortController();
    const first = client.request('me', { signal: impatient.signal });
    const second = client.request('me');
    await challenging;
    impatient.abort();
    await expect(first).rejects.toMatchObject({ code: 'unreachable' });
    release();
    expect((await second).status).toBe(200);
  });

  it('a session answer that is not one is refused without quoting it', async () => {
    for (const body of ['not json tok-SECRET-1', JSON.stringify({ token: '', expiresAt: Date.now() + 3_600_000 }), JSON.stringify({ expiresAt: 1 })]) {
      const client = await pairedWith(async (input, init) => {
        if (String(input).endsWith('/api/session')) {
          await fetch(input, init);
          return new Response(body, { status: 200, headers: { 'Content-Type': 'application/json' } });
        }
        return fetch(input, init);
      });
      const err = await client.request('me').catch((e: unknown) => e);
      expect(err).toBeInstanceOf(NasError);
      expect(err).toMatchObject({ code: 'http' });
      expect((err as Error).message).not.toContain('tok-SECRET');
    }
  });

  it('a closed client refuses every request', async () => {
    const { client } = await paired();
    await client.me();
    client.close();
    await expect(client.request('me')).rejects.toMatchObject({ code: 'unauthorized', status: null, message: 'This app is no longer paired with the NAS.' });
  });

  it('no thrown message nor nas.json holds a session token', async () => {
    const { client, tokens } = await paired();
    await client.me();
    const messages: string[] = [];
    for (const path of ['encodes/990001-9/manifest', 'no-such-route?secret=1']) {
      try {
        await client.json(path);
      } catch (err) {
        expect(err).toBeInstanceOf(NasError);
        messages.push((err as Error).message);
      }
    }
    expect(messages).toHaveLength(2);
    const file = readFileSync(join(dataDir, 'nas.json'), 'utf8');
    for (const token of tokens) {
      expect(file).not.toContain(token);
      for (const m of messages) expect(m).not.toContain(token);
    }
    for (const m of messages) expect(m).not.toContain('secret');
  });
});
