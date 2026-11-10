// SPDX-License-Identifier: LGPL-3.0-or-later
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { pairingLink } from '../../../server/src/codes';
import { encoderDeviceName } from '../../src/server/nas-routes';
import { startHelperServer, type AppContext, type HelperServer } from '../../src/server/server';
import { startNasTestServer, type NasTestServer } from '../nas/nas-test-server';

const TOKEN = 'nas-routes-token';

let nas: NasTestServer;
let bare: NasTestServer;
let server: HelperServer;
let app: AppContext;
/** Every body the app answered, and every session token the NAS gave, to check no answer leaks one. */
let answers: string[];
let tokens: string[];

beforeAll(async () => {
  [nas, bare] = await Promise.all([startNasTestServer({ discs: false }), startNasTestServer({ discs: false, encodes: false })]);
});
afterAll(async () => {
  await Promise.all([nas.close(), bare.close()]);
});

beforeEach(async () => {
  answers = [];
  tokens = [];
  const realFetch = globalThis.fetch;
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const res = await realFetch(input, init);
    if (String(input).endsWith('/api/session') && res.ok) tokens.push(((await res.clone().json()) as { token: string }).token);
    return res;
  });
  app = { dataDir: mkdtempSync(join(tmpdir(), 'nas-routes-')), token: TOKEN, webDir: null, tools: null, sources: {} as AppContext['sources'], roots: [], nas: { client: null } };
  server = await startHelperServer(app);
});
afterEach(async () => {
  for (const body of answers) {
    expect(body).not.toContain('privateKeyJwk');
    expect(body).not.toContain('"d"');
    for (const t of tokens) expect(body).not.toContain(t);
  }
  vi.restoreAllMocks();
  await server.close();
  rmSync(app.dataDir, { recursive: true, force: true });
});

async function call(method: string, path: string, body?: unknown): Promise<{ status: number; body: Record<string, unknown> }> {
  const res = await fetch(`http://127.0.0.1:${server.port}${path}`, {
    method,
    headers: { authorization: `Bearer ${TOKEN}` },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await res.text();
  answers.push(text);
  return { status: res.status, body: JSON.parse(text) as Record<string, unknown> };
}

describe('the NAS routes', () => {
  it('says unpaired, pairs with an owner code, and unpairs', async () => {
    expect(await call('GET', '/api/nas')).toEqual({ status: 200, body: { paired: false } });
    const paired = await call('POST', '/api/nas/pair', { code: await nas.ownerCode('Mika Owner'), base: nas.base });
    expect(paired).toEqual({ status: 200, body: { paired: true, host: '127.0.0.1', personName: 'Mika Owner', reachable: true, encodes: 'ready' } });
    expect(await call('GET', '/api/nas')).toEqual(paired);
    expect(tokens.length).toBeGreaterThan(0);
    expect(await call('DELETE', '/api/nas')).toEqual({ status: 200, body: { paired: false } });
    expect(existsSync(join(app.dataDir, 'nas.json'))).toBe(false);
    expect(await call('GET', '/api/nas')).toEqual({ status: 200, body: { paired: false } });
  });

  it('pairs from a link and says when the NAS keeps no encodes', async () => {
    const link = pairingLink(await bare.ownerCode(), { appUrl: 'https://seikou.example/', publicBase: bare.base, rendezvousUrl: undefined });
    expect((await call('POST', '/api/nas/pair', { link })).body).toMatchObject({ paired: true, reachable: true, encodes: 'not-configured' });
  });

  it('names the device after this machine', async () => {
    expect(encoderDeviceName('studio-mac')).toBe('Seikou encoder on studio-mac');
    expect(encoderDeviceName('x'.repeat(200))).toHaveLength(100);
  });

  it('refuses a guest code, a bad address, a spent code, a dead NAS and a bad body', async () => {
    expect(await call('POST', '/api/nas/pair', { code: await nas.guestCode(), base: nas.base })).toMatchObject({ status: 409, body: { error: 'not-owner' } });
    expect(existsSync(join(app.dataDir, 'nas.json'))).toBe(false);
    expect(await call('POST', '/api/nas/pair', { code: await nas.ownerCode(), base: 'http://nas.example/api/' })).toMatchObject({ status: 400, body: { error: 'bad-address' } });
    const code = await nas.ownerCode();
    await call('POST', '/api/nas/pair', { code, base: nas.base });
    expect(await call('POST', '/api/nas/pair', { code, base: nas.base })).toMatchObject({ status: 400, body: { error: 'bad-code' } });
    expect(await call('POST', '/api/nas/pair', { code: 'not a code', base: nas.base })).toMatchObject({ status: 400, body: { error: 'bad-code' } });
    expect(await call('POST', '/api/nas/pair', { code: await nas.ownerCode(), base: 'http://127.0.0.1:9/api/' })).toMatchObject({ status: 502, body: { error: 'unreachable' } });
    expect(await call('POST', '/api/nas/pair', { code: 7 })).toMatchObject({ status: 400, body: { error: 'bad-request' } });
    // the failures kept the pairing that worked
    expect((await call('GET', '/api/nas')).body).toMatchObject({ paired: true, reachable: true });
  });

  it('unpairing and pairing again close the client they replace', async () => {
    await call('POST', '/api/nas/pair', { code: await nas.ownerCode(), base: nas.base });
    const first = app.nas.client!;
    await call('POST', '/api/nas/pair', { code: await nas.ownerCode(), base: nas.base });
    const second = app.nas.client!;
    expect(second).not.toBe(first);
    await expect(first.request('me')).rejects.toMatchObject({ code: 'unauthorized', message: 'This app is no longer paired with the NAS.' });
    expect((await second.request('me')).status).toBe(200);
    await call('DELETE', '/api/nas');
    await expect(second.request('me')).rejects.toMatchObject({ code: 'unauthorized' });
  });

  it('a pair and an unpair sent together leave a client only with a pairing file', async () => {
    for (let i = 0; i < 4; i++) {
      await call('POST', '/api/nas/pair', { code: await nas.ownerCode(), base: nas.base });
      const code = await nas.ownerCode();
      const [paired, unpaired] = await Promise.all([call('POST', '/api/nas/pair', { code, base: nas.base }), call('DELETE', '/api/nas')]);
      expect(paired.body).toMatchObject({ paired: true });
      expect(unpaired.body).toEqual({ paired: false });
      const filed = existsSync(join(app.dataDir, 'nas.json'));
      expect(app.nas.client !== null).toBe(filed);
      expect((await call('GET', '/api/nas')).body).toMatchObject({ paired: filed });
    }
  });

  it('a NAS that stops answering is unreachable, with encodes unknown', async () => {
    const gone = await startNasTestServer({ discs: false, encodes: false });
    await call('POST', '/api/nas/pair', { code: await gone.ownerCode('Rin Owner'), base: gone.base });
    await gone.close();
    expect((await call('GET', '/api/nas')).body).toEqual({ paired: true, host: '127.0.0.1', personName: 'Rin Owner', reachable: false, encodes: 'unknown' });
    expect(readFileSync(join(app.dataDir, 'nas.json'), 'utf8')).toContain('Rin Owner');
  });
});
