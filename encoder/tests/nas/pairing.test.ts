// SPDX-License-Identifier: LGPL-3.0-or-later
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { pairingLink } from '../../../server/src/codes';
import { NasError } from '../../src/nas/client';
import { readNasPairing, removeNasPairing } from '../../src/nas/nas-store';
import { checkNasBase, pairWithNas, parsePairingInput } from '../../src/nas/pairing';
import { startNasTestServer, type NasTestServer } from './nas-test-server';

const CODE = 'K7QM-4XP2-R9TD';
const APP = 'https://seikou.example/';

describe('parsePairingInput', () => {
  it('reads a typed code with an address', () => {
    expect(parsePairingInput({ code: ' k7qm-4xp2-r9td ', base: 'https://nas.example/bluray/api' })).toEqual({ code: 'K7QM4XP2R9TD', base: 'https://nas.example/bluray/api/' });
  });

  it('reads a link that names the NAS', () => {
    const link = pairingLink(CODE, { appUrl: APP, publicBase: 'https://nas.example/bluray/api/', rendezvousUrl: undefined });
    expect(parsePairingInput({ link })).toEqual({ code: 'K7QM4XP2R9TD', base: 'https://nas.example/bluray/api/' });
  });

  it('reads a link that names a rendezvous Worker', () => {
    const link = pairingLink(CODE, { appUrl: APP, publicBase: 'https://nas.example/bluray/api/', rendezvousUrl: 'https://rv.example/' });
    expect(parsePairingInput({ link })).toEqual({ code: 'K7QM4XP2R9TD', rendezvous: 'https://rv.example' });
  });

  it('refuses a link that names neither, and a code that is not one', () => {
    expect(() => parsePairingInput({ link: `${APP}?pair=${CODE}` })).toThrow(expect.objectContaining({ code: 'bad-address' }));
    expect(() => parsePairingInput({ code: 'nope', base: 'https://nas.example/api/' })).toThrow(expect.objectContaining({ code: 'http', status: 400 }));
    expect(() => parsePairingInput({ code: CODE })).toThrow(expect.objectContaining({ code: 'bad-address' }));
  });
});

describe('checkNasBase', () => {
  it('refuses plain http to another machine', () => {
    expect(() => checkNasBase('http://nas.example/api/')).toThrow(NasError);
    expect(() => checkNasBase('http://nas.example/api/')).toThrow(expect.objectContaining({ code: 'bad-address' }));
  });

  it('accepts http on this machine and adds the slash', () => {
    expect(checkNasBase('http://127.0.0.1:4192/api')).toBe('http://127.0.0.1:4192/api/');
    expect(checkNasBase('http://localhost:4192/api/')).toBe('http://localhost:4192/api/');
  });

  it('drops the query and refuses a path that is not an API base', () => {
    expect(checkNasBase('https://nas.example/bluray/api/?x=1#y')).toBe('https://nas.example/bluray/api/');
    expect(() => checkNasBase('https://nas.example/bluray/')).toThrow(expect.objectContaining({ code: 'bad-address' }));
    expect(() => checkNasBase('https://user:pw@nas.example/api/')).toThrow(expect.objectContaining({ code: 'bad-address' }));
  });
});

describe('pairWithNas', () => {
  let nas: NasTestServer;
  let dataDir: string;
  beforeAll(async () => {
    nas = await startNasTestServer({ discs: false, encodes: false });
  });
  afterAll(async () => {
    await nas.close();
  });
  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), 'encoder-pair-'));
  });
  afterEach(() => {
    rmSync(dataDir, { recursive: true, force: true });
  });

  it('pairs with an owner code and keeps the key in a 0600 file without a token', async () => {
    const pairing = await pairWithNas(dataDir, { code: await nas.ownerCode('Mika Owner'), base: nas.base }, 'Seikou encoder on test');
    expect(pairing.personName).toBe('Mika Owner');
    const file = join(dataDir, 'nas.json');
    expect(statSync(file).mode & 0o777).toBe(0o600);
    const stored = JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>;
    expect(Object.keys(stored).sort()).toEqual(['base', 'deviceId', 'pairedAt', 'personId', 'personName', 'privateKeyJwk']);
    expect(stored.base).toBe(nas.base);
    expect((stored.privateKeyJwk as { d?: string }).d).toBeTypeOf('string');
    expect(await readNasPairing(dataDir)).toEqual(pairing);
  });

  it('pairs from a link that names the NAS', async () => {
    const link = pairingLink(await nas.ownerCode(), { appUrl: APP, publicBase: nas.base, rendezvousUrl: undefined });
    expect((await pairWithNas(dataDir, { link }, 'Seikou encoder on test')).base).toBe(nas.base);
  });

  it('refuses a guest code and writes nothing', async () => {
    await expect(pairWithNas(dataDir, { code: await nas.guestCode(), base: nas.base }, 'Seikou encoder on test')).rejects.toMatchObject({ code: 'not-owner' });
    expect(existsSync(join(dataDir, 'nas.json'))).toBe(false);
  });

  it('a spent code is refused with 401', async () => {
    const code = await nas.ownerCode();
    await pairWithNas(dataDir, { code, base: nas.base }, 'Seikou encoder on test');
    await expect(pairWithNas(dataDir, { code, base: nas.base }, 'Seikou encoder on test')).rejects.toMatchObject({ code: 'http', status: 401 });
  });

  it('pairing again replaces the pairing and forgets what was fetched', async () => {
    await pairWithNas(dataDir, { code: await nas.ownerCode(), base: nas.base }, 'Seikou encoder on test');
    mkdirSync(join(dataDir, 'fetch'));
    writeFileSync(join(dataDir, 'nas-library.json'), '{}');
    const second = await pairWithNas(dataDir, { code: await nas.ownerCode('Rin Owner'), base: nas.base }, 'Seikou encoder on test');
    expect((await readNasPairing(dataDir))?.deviceId).toBe(second.deviceId);
    expect(existsSync(join(dataDir, 'fetch'))).toBe(false);
    expect(existsSync(join(dataDir, 'nas-library.json'))).toBe(false);
    await removeNasPairing(dataDir);
    expect(await readNasPairing(dataDir)).toBeNull();
  });

  describe('through a rendezvous Worker', () => {
    let worker: Server;
    let workerUrl: string;
    beforeAll(async () => {
      worker = createServer((req, res) => {
        let body = '';
        req.on('data', (c: Buffer) => (body += c.toString()));
        req.on('end', () => {
          const known = req.url === '/codes/lookup' && (JSON.parse(body) as { code: string }).code !== 'ZZZZZZZZZZZZ';
          res.writeHead(known ? 200 : 404, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify(known ? { nasId: 'abc', routes: { https: nas.base } } : { error: 'not found' }));
        });
      });
      await new Promise<void>((r) => worker.listen(0, '127.0.0.1', r));
      workerUrl = `http://127.0.0.1:${(worker.address() as AddressInfo).port}`;
    });
    afterAll(() => {
      worker.close();
    });

    it('looks the code up and pairs with the NAS it names', async () => {
      const link = pairingLink(await nas.ownerCode(), { appUrl: APP, publicBase: 'unused', rendezvousUrl: workerUrl });
      expect((await pairWithNas(dataDir, { link }, 'Seikou encoder on test')).base).toBe(nas.base);
    });

    it('a code the Worker does not know is a bad code', async () => {
      const link = pairingLink('ZZZZ-ZZZZ-ZZZZ', { appUrl: APP, publicBase: 'unused', rendezvousUrl: workerUrl });
      await expect(pairWithNas(dataDir, { link }, 'Seikou encoder on test')).rejects.toMatchObject({ code: 'http', status: 400 });
    });

    it('a Worker that does not answer is unreachable', async () => {
      const link = pairingLink(CODE, { appUrl: APP, publicBase: 'unused', rendezvousUrl: 'http://127.0.0.1:9' });
      await expect(pairWithNas(dataDir, { link }, 'Seikou encoder on test')).rejects.toMatchObject({ code: 'unreachable' });
    });
  });
});
