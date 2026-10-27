import type { webcrypto } from 'node:crypto';
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { request } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { appHandlers } from './app';
import { Auth, AuthConflict, AuthNotFound } from './auth';
import { BdjStore } from './bdj-store';
import { ownerCode } from './cli';
import { codeHash } from './codes';
import type { CodeRegistrar } from './codes';
import { createServer } from './http';
import { Library } from './library';
import { FailureLimiter, trustedProxy } from './routes/pair';
import { Store } from './store';

type JsonWebKey = webcrypto.JsonWebKey;

let tmp: string;
let clock: number;
const now = (): number => clock;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'auth-'));
  clock = 1_800_000_000_000;
});
afterEach(() => rmSync(tmp, { recursive: true, force: true }));

const MINUTE = 60_000;

/** A code for a new guest, or for the first owner person. */
function mint(auth: Auth, owner: boolean) {
  return auth.createCode(owner ? { personId: auth.firstOwnerPerson().id } : { newPerson: { name: 'Guest', owner: false } });
}

async function deviceKey(): Promise<{ jwk: JsonWebKey; sign: (text: string) => Promise<string> }> {
  const pair = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign', 'verify']);
  const jwk = await crypto.subtle.exportKey('jwk', pair.publicKey);
  const sign = async (text: string): Promise<string> => {
    const sig = await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, pair.privateKey, new TextEncoder().encode(text));
    return Buffer.from(sig).toString('base64url');
  };
  return { jwk, sign };
}

async function session(auth: Auth, deviceId: string, sign: (text: string) => Promise<string>) {
  const challenge = auth.challenge(deviceId)!;
  return auth.startSession(deviceId, challenge, await sign(challenge));
}

describe('Auth', () => {
  it('redeems a code once', async () => {
    const auth = new Auth(new Store(tmp), now);
    const { code } = mint(auth, false);
    const { jwk } = await deviceKey();
    expect(auth.redeem(code, 'iPad', jwk)).not.toBeNull();
    expect(auth.redeem(code, 'iPad', jwk)).toBeNull();
  });

  it('accepts the code typed loosely', async () => {
    const auth = new Auth(new Store(tmp), now);
    const { code } = mint(auth, false);
    const typed = `${code.slice(0, 4).toLowerCase()}-${code.slice(4, 8)} ${code.slice(8)}`;
    expect(auth.redeem(typed, 'iPad', (await deviceKey()).jwk)).not.toBeNull();
  });

  it('refuses a code 10 minutes old', async () => {
    const auth = new Auth(new Store(tmp), now);
    const { code, record } = mint(auth, false);
    expect(record.expiresAt).toBe(clock + 10 * MINUTE);
    clock += 10 * MINUTE;
    expect(auth.redeem(code, 'iPad', (await deviceKey()).jwk)).toBeNull();
  });

  it('makes owner devices from owner codes only', async () => {
    const auth = new Auth(new Store(tmp), now);
    const { jwk } = await deviceKey();
    const owner = auth.redeem(auth.createCode({ personId: auth.firstOwnerPerson().id }).code, 'Mac', jwk)!;
    const plain = auth.redeem(mint(auth, false).code, 'Phone', jwk)!;
    expect(owner.owner).toBe(true);
    expect(plain.owner).toBe(false);
    expect(owner.name).toBe('Mac');
    expect(owner.pairedAt).toBe(clock);
  });

  it('refuses a private or non-P-256 key without spending the code', async () => {
    const auth = new Auth(new Store(tmp), now);
    const { code } = mint(auth, false);
    const priv = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
    const p384 = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-384' }, true, ['sign', 'verify']);
    expect(auth.redeem(code, 'x', await crypto.subtle.exportKey('jwk', priv.privateKey))).toBeNull();
    expect(auth.redeem(code, 'x', await crypto.subtle.exportKey('jwk', p384.publicKey))).toBeNull();
    expect(auth.redeem(code, 'x', { kty: 'EC', crv: 'P-256', x: 'AAAA', y: 'AAAA' })).toBeNull();
    expect(auth.redeem(code, 'x', (await deviceKey()).jwk)).not.toBeNull();
  });

  it('starts a session from a signed challenge', async () => {
    const auth = new Auth(new Store(tmp), now);
    const { jwk, sign } = await deviceKey();
    const device = auth.redeem(mint(auth, false).code, 'iPad', jwk)!;
    const started = await session(auth, device.id, sign);
    expect(started).not.toBeNull();
    expect(started!.expiresAt).toBe(clock + 60 * MINUTE);
    expect(auth.verify(started!.token)?.id).toBe(device.id);
  });

  it('refuses a wrong signature, a reused or stale challenge, and another device key', async () => {
    const auth = new Auth(new Store(tmp), now);
    const { jwk, sign } = await deviceKey();
    const other = await deviceKey();
    const device = auth.redeem(mint(auth, false).code, 'iPad', jwk)!;

    const c1 = auth.challenge(device.id)!;
    expect(auth.startSession(device.id, c1, await other.sign(c1))).toBeNull();
    // A failed attempt spends the challenge.
    expect(auth.startSession(device.id, c1, await sign(c1))).toBeNull();

    const c2 = auth.challenge(device.id)!;
    expect(auth.startSession(device.id, c2, await sign(c2))).not.toBeNull();
    expect(auth.startSession(device.id, c2, await sign(c2))).toBeNull();

    const c3 = auth.challenge(device.id)!;
    clock += 60_000;
    expect(auth.startSession(device.id, c3, await sign(c3))).toBeNull();

    const c4 = auth.challenge(device.id)!;
    expect(auth.startSession(device.id, c4, 'not base64url!')).toBeNull();
    expect(auth.startSession('unknown', c4, await sign(c4))).toBeNull();
    expect(auth.challenge('unknown')).toBeNull();
  });

  it('verifies a token until it expires', async () => {
    const auth = new Auth(new Store(tmp), now);
    const { jwk, sign } = await deviceKey();
    const device = auth.redeem(mint(auth, false).code, 'iPad', jwk)!;
    const { token, expiresAt } = (await session(auth, device.id, sign))!;
    clock = expiresAt - 1;
    expect(auth.verify(token)).not.toBeNull();
    clock = expiresAt;
    expect(auth.verify(token)).toBeNull();
  });

  it('refuses forged and malformed tokens', async () => {
    const auth = new Auth(new Store(tmp), now);
    const { jwk, sign } = await deviceKey();
    const device = auth.redeem(mint(auth, false).code, 'iPad', jwk)!;
    const { token } = (await session(auth, device.id, sign))!;
    const [, mac] = token.split('.');
    const longer = Buffer.from(`${device.id}.${clock + 1e9}`).toString('base64url');
    expect(auth.verify(`${longer}.${mac}`)).toBeNull();
    expect(auth.verify(`${token}x`)).toBeNull();
    expect(auth.verify(token.split('.')[0]!)).toBeNull();
    expect(auth.verify('')).toBeNull();
    expect(auth.verify('a.b.c')).toBeNull();
  });

  it('rejects tokens of a revoked device at once', async () => {
    const auth = new Auth(new Store(tmp), now);
    const { jwk, sign } = await deviceKey();
    const device = auth.redeem(mint(auth, false).code, 'iPad', jwk)!;
    const { token } = (await session(auth, device.id, sign))!;
    auth.revokeDevice(device.id);
    expect(auth.verify(token)).toBeNull();
    expect(auth.devices()).toEqual([]);
  });

  it('keeps only code hashes on disk, with private file modes, and survives a restart', async () => {
    const auth = new Auth(new Store(tmp), now);
    const { code, record } = auth.createCode({ personId: auth.firstOwnerPerson().id });
    const unused = mint(auth, false);
    const { jwk, sign } = await deviceKey();
    const device = auth.redeem(code, 'Mac', jwk)!;
    const { token } = (await session(auth, device.id, sign))!;

    const raw = readFileSync(join(tmp, 'auth.json'), 'utf8');
    expect(raw).not.toContain(code);
    expect(raw).not.toContain(unused.code);
    expect(raw).toContain(unused.record.hash);
    expect(statSync(join(tmp, 'auth.json')).mode & 0o777).toBe(0o600);
    expect(statSync(join(tmp, 'secret')).mode & 0o777).toBe(0o600);

    const again = new Auth(new Store(tmp), now);
    expect(again.verify(token)?.id).toBe(device.id);
    expect(again.devices().map((d) => d.id)).toEqual([device.id]);
    expect(again.codes().map((c) => c.id)).toEqual([unused.record.id]);
    expect(again.redeem(code, 'Mac', jwk)).toBeNull();
    expect(record.personId).toBe(again.people()[0]!.id);
  });

  it('sees codes made by another process on the same data dir', async () => {
    const server = new Auth(new Store(tmp), now);
    server.devices();
    const cli = new Auth(new Store(tmp), now);
    const { code } = cli.createCode({ personId: cli.firstOwnerPerson().id });
    expect(server.redeem(code, 'Mac', (await deviceKey()).jwk)?.owner).toBe(true);
  });

  it('deletes codes and drops expired ones from the list', () => {
    const auth = new Auth(new Store(tmp), now);
    const a = mint(auth, false);
    const b = mint(auth, false);
    auth.deleteCode(a.record.id);
    expect(auth.codes().map((c) => c.id)).toEqual([b.record.id]);
    clock += 10 * MINUTE;
    expect(auth.codes()).toEqual([]);
  });

  it('keeps at most 5 challenges per device, dropping the oldest', async () => {
    const auth = new Auth(new Store(tmp), now);
    const { jwk, sign } = await deviceKey();
    const device = auth.redeem(mint(auth, false).code, 'iPad', jwk)!;
    const other = auth.redeem(mint(auth, false).code, 'Phone', jwk)!;
    const otherChallenge = auth.challenge(other.id)!;
    const challenges = Array.from({ length: 6 }, () => auth.challenge(device.id)!);
    expect(auth.startSession(device.id, challenges[0]!, await sign(challenges[0]!))).toBeNull();
    for (const c of challenges.slice(1)) expect(auth.startSession(device.id, c, await sign(c))).not.toBeNull();
    expect(auth.startSession(other.id, otherChallenge, await sign(otherChallenge))).not.toBeNull();
  });

  it('writes the secret whole, once, without leftovers', () => {
    const first = new Store(tmp).secret();
    expect(first).toHaveLength(32);
    expect(new Store(tmp).secret().equals(first)).toBe(true);
    expect(readdirSync(tmp).sort()).toEqual(['secret']);
  });

  it.each([
    ['{', /auth\.json is corrupt: not valid JSON/],
    ['[]', /auth\.json is corrupt: not a JSON object/],
    ['{"devices":{},"codes":[]}', /auth\.json is corrupt: "devices" is not an array/],
    ['{"devices":[],"codes":null}', /auth\.json is corrupt: "codes" is not an array/],
    ['{"devices":[{"id":1,"owner":false}],"codes":[]}', /auth\.json is corrupt: devices\[0\]\.id is not a string/],
    ['{"devices":[],"codes":[{"id":"a","hash":"h","owner":true,"expiresAt":"soon"}]}', /auth\.json is corrupt: codes\[0\]\.expiresAt is not a number/],
  ])('names the file and the fault of a corrupt auth.json (%s)', (content, message) => {
    writeFileSync(join(tmp, 'auth.json'), content);
    const auth = new Auth(new Store(tmp), now);
    expect(() => auth.devices()).toThrow(message);
    expect(() => auth.verify('a.b')).not.toThrow();
    expect(() => auth.createCode({ personId: auth.firstOwnerPerson().id })).toThrow(message);
  });
});

describe('People', () => {
  const pair = async (auth: Auth, ref: Parameters<Auth['createCode']>[0], name: string) => {
    const { jwk, sign } = await deviceKey();
    const { code } = auth.createCode(ref);
    const device = auth.redeem(code, name, jwk)!;
    return { device, token: (await session(auth, device.id, sign))!.token };
  };

  it('codes name their person', async () => {
    const auth = new Auth(new Store(tmp), now);
    const { code, person } = auth.createCode({ newPerson: { name: 'Mika', owner: false } });
    expect(person.name).toBe('Mika');
    const device = auth.redeem(code, 'Phone', (await deviceKey()).jwk)!;
    expect(device.personName).toBe('Mika');
    expect(device.personId).toBe(person.id);
    expect(device.owner).toBe(false);
  });

  it('invite codes last 3 days', () => {
    const auth = new Auth(new Store(tmp), now);
    const { record } = auth.createCode({ newPerson: { name: 'Mika', owner: false } }, { invite: true });
    expect(record.invite).toBe(true);
    expect(record.expiresAt).toBe(clock + 3 * 24 * 60 * 60_000);
    expect(auth.createCode({ personId: record.personId }).record.expiresAt).toBe(clock + 10 * MINUTE);
  });

  it('owner is derived from the person', async () => {
    const auth = new Auth(new Store(tmp), now);
    const { device, token } = await pair(auth, { newPerson: { name: 'Mika', owner: false } }, 'Phone');
    expect(auth.verify(token)!.owner).toBe(false);
    auth.updatePerson(device.personId, { owner: true });
    expect(auth.verify(token)!.owner).toBe(true);
    expect(auth.devices()[0]!.owner).toBe(true);
  });

  it('refuses to leave no owner device', async () => {
    const auth = new Auth(new Store(tmp), now);
    const owner = await pair(auth, { personId: auth.firstOwnerPerson().id }, 'Mac');
    const mika = auth.createPerson('Mika', false);
    const conflict = (fn: () => void): void => {
      try {
        fn();
        expect.unreachable('should have thrown');
      } catch (err) {
        expect(err).toBeInstanceOf(AuthConflict);
        expect((err as AuthConflict).reason).toBe('last-owner');
      }
    };
    conflict(() => auth.revokeDevice(owner.device.id));
    conflict(() => auth.moveDevice(owner.device.id, mika.id));
    conflict(() => auth.updatePerson(owner.device.personId, { owner: false }));
    conflict(() => auth.removePerson(owner.device.personId));
    expect(auth.verify(owner.token)?.owner).toBe(true);
    expect(auth.people().find((p) => p.id === owner.device.personId)?.owner).toBe(true);
  });

  it('lets an owner device go when another remains', async () => {
    const auth = new Auth(new Store(tmp), now);
    const a = await pair(auth, { personId: auth.firstOwnerPerson().id }, 'Mac');
    const b = await pair(auth, { personId: a.device.personId }, 'Laptop');
    auth.revokeDevice(a.device.id);
    expect(auth.verify(a.token)).toBeNull();
    expect(auth.verify(b.token)).not.toBeNull();
  });

  it('tells listeners when a device goes: on revoke and on removing its person, once per device, not on a move', async () => {
    const auth = new Auth(new Store(tmp), now);
    await pair(auth, { personId: auth.firstOwnerPerson().id }, 'Mac');
    const phone = await pair(auth, { newPerson: { name: 'Mika', owner: false } }, 'Phone');
    const tablet = await pair(auth, { personId: phone.device.personId }, 'Tablet');
    const tv = await pair(auth, { newPerson: { name: 'Den TV', owner: false } }, 'TV');
    const gone: string[] = [];
    const stop = auth.onDeviceGone((id) => gone.push(id));
    auth.moveDevice(tv.device.id, phone.device.personId);
    expect(gone).toEqual([]);
    auth.revokeDevice(tv.device.id);
    expect(gone).toEqual([tv.device.id]);
    auth.revokeDevice(tv.device.id);
    expect(gone).toEqual([tv.device.id]);
    auth.removePerson(phone.device.personId);
    expect(gone.slice(1).sort()).toEqual([phone.device.id, tablet.device.id].sort());
    stop();
    const other = await pair(auth, { newPerson: { name: 'Sora', owner: false } }, 'Laptop');
    auth.revokeDevice(other.device.id);
    expect(gone).toHaveLength(3);
  });

  it('notes the route a device last used, keeps it across a restart, and reads files without it', async () => {
    const auth = new Auth(new Store(tmp), now);
    const { device } = await pair(auth, { personId: auth.firstOwnerPerson().id }, 'Mac');
    expect(auth.devices()[0]!.lastRoute).toBeUndefined();
    auth.noteRoute(device.id, 'relay');
    expect(new Auth(new Store(tmp), now).devices()[0]!.lastRoute).toBe('relay');
    auth.noteRoute('nope', 'https');
    const file = join(tmp, 'auth.json');
    const data = JSON.parse(readFileSync(file, 'utf8')) as { devices: Record<string, unknown>[] };
    data.devices[0]!.lastRoute = 'carrier-pigeon';
    writeFileSync(file, JSON.stringify(data));
    expect(() => new Auth(new Store(tmp), now).devices()).toThrow(/lastRoute/);
  });

  it('removing a person revokes their devices and codes', async () => {
    const auth = new Auth(new Store(tmp), now);
    await pair(auth, { personId: auth.firstOwnerPerson().id }, 'Mac');
    const mika = await pair(auth, { newPerson: { name: 'Mika', owner: false } }, 'Phone');
    const pending = auth.createCode({ personId: mika.device.personId });
    auth.removePerson(mika.device.personId);
    expect(auth.verify(mika.token)).toBeNull();
    expect(auth.people().map((p) => p.name)).toEqual(['Owner']);
    expect(auth.codes().map((c) => c.id)).not.toContain(pending.record.id);
  });

  it('names unknown people and devices, and bad names', () => {
    const auth = new Auth(new Store(tmp), now);
    expect(() => auth.updatePerson('nobody', { name: 'X' })).toThrow(AuthNotFound);
    expect(() => auth.removePerson('nobody')).toThrow(AuthNotFound);
    expect(() => auth.moveDevice('nobody', 'nobody')).toThrow(AuthNotFound);
    expect(() => auth.createCode({ personId: 'nobody' })).toThrow(AuthNotFound);
    expect(() => auth.createPerson('   ', false)).toThrow(RangeError);
    expect(() => auth.createPerson('x'.repeat(101), false)).toThrow(RangeError);
    expect(auth.createPerson('  Mika  ', false).name).toBe('Mika');
  });

  it('pruneOrphans drops people made for codes never used, once their codes are gone, and never an owner', async () => {
    const auth = new Auth(new Store(tmp), now);
    auth.createCode({ newPerson: { name: 'Mika', owner: false } });
    const deleted = auth.createCode({ newPerson: { name: 'Den', owner: false } });
    auth.createCode({ newPerson: { name: 'Sora', owner: false } }, { invite: true });
    auth.createCode({ newPerson: { name: 'Second owner', owner: true } });
    const paired = await pair(auth, { newPerson: { name: 'Kai', owner: false } }, 'Phone');
    auth.createPerson('Rin', false);
    auth.deleteCode(deleted.record.id);
    auth.pruneOrphans();
    expect(auth.people().map((p) => p.name)).toEqual(['Mika', 'Sora', 'Second owner', 'Kai', 'Rin']);
    clock += 10 * MINUTE;
    auth.pruneOrphans();
    expect(auth.people().map((p) => p.name)).toEqual(['Sora', 'Second owner', 'Kai', 'Rin']);
    // a person who once had a device stays when it goes
    auth.revokeDevice(paired.device.id);
    clock += 3 * 24 * 60 * MINUTE;
    auth.pruneOrphans();
    expect(auth.people().map((p) => p.name)).toEqual(['Second owner', 'Kai', 'Rin']);
  });

  it('pruneOrphans keeps a person a device was moved to', async () => {
    const auth = new Auth(new Store(tmp), now);
    const owner = await pair(auth, { personId: auth.firstOwnerPerson().id }, 'Mac');
    const phone = await pair(auth, { newPerson: { name: 'Kai', owner: false } }, 'Phone');
    const { person: mika } = auth.createCode({ newPerson: { name: 'Mika', owner: false } });
    auth.moveDevice(phone.device.id, mika.id);
    auth.moveDevice(phone.device.id, owner.device.personId);
    clock += 10 * MINUTE;
    auth.pruneOrphans();
    expect(auth.people().map((p) => p.name)).toEqual(['Owner', 'Kai', 'Mika']);
  });

  it('firstOwnerPerson makes Owner once', () => {
    const auth = new Auth(new Store(tmp), now);
    const first = auth.firstOwnerPerson();
    expect(first).toMatchObject({ name: 'Owner', owner: true });
    expect(auth.firstOwnerPerson().id).toBe(first.id);
    expect(auth.people()).toHaveLength(1);
  });
});

describe('FailureLimiter', () => {
  afterEach(() => vi.useRealTimers());

  it('holds a slot per attempt in flight', () => {
    const limiter = new FailureLimiter(now, 2);
    const a = limiter.admit('x')!;
    const b = limiter.admit('x')!;
    expect(limiter.admit('x')).toBeNull();
    a.release();
    a.fail();
    const c = limiter.admit('x')!;
    b.fail();
    c.fail();
    expect(limiter.recentFailures('x')).toBe(2);
    expect(limiter.admit('x')).toBeNull();
    expect(limiter.admit('y')).not.toBeNull();
  });

  it('forgets stale keys on a timer', () => {
    vi.useFakeTimers();
    const limiter = new FailureLimiter(now);
    limiter.admit('x')!.fail();
    expect(limiter.size).toBe(1);
    clock += MINUTE;
    vi.advanceTimersByTime(MINUTE);
    expect(limiter.size).toBe(0);
  });
});

describe('trustedProxy', () => {
  it('trusts an IP as given, IPv4-mapped too', async () => {
    const trust = await trustedProxy('172.18.0.2', async () => Promise.reject(new Error('no lookups for IPs')));
    expect(trust('172.18.0.2')).toBe(true);
    expect(trust('::ffff:172.18.0.2')).toBe(true);
    expect(trust('172.18.0.3')).toBe(false);
  });

  it('resolves a hostname once', async () => {
    const lookup = vi.fn(async () => [{ address: '172.18.0.5' }, { address: 'fd00::5' }]);
    const trust = await trustedProxy('caddy', lookup);
    expect(trust('172.18.0.5')).toBe(true);
    expect(trust('fd00::5')).toBe(true);
    expect(trust('172.18.0.6')).toBe(false);
    expect(lookup).toHaveBeenCalledOnce();
  });

  it('trusts nobody when no proxy is set', async () => {
    const trust = await trustedProxy(null, async () => Promise.reject(new Error('no lookups')));
    expect(trust('172.18.0.2')).toBe(false);
  });

  it('trusts nobody when the hostname does not resolve', async () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    const trust = await trustedProxy('caddy', async () => Promise.reject(new Error('ENOTFOUND')));
    expect(trust('172.18.0.5')).toBe(false);
    expect(errors).toHaveBeenCalled();
    errors.mockRestore();
  });
});

describe('HTTP', () => {
  let base = '';
  let close: (() => void) | undefined;
  let auth: Auth;
  let library: Library;
  afterEach(() => close?.());

  async function start(
    opts: { registrar?: CodeRegistrar; registrarDeadlineMs?: number; trustProxy?: (address: string) => boolean } = {},
  ): Promise<void> {
    auth = new Auth(new Store(join(tmp, 'data')), now);
    library = new Library([], join(tmp, 'data', 'library.json'), { scanPauseMs: 0 });
    const server = createServer(
      appHandlers({ auth, library, bdjStore: new BdjStore(join(tmp, 'data')), now, publicBase: 'https://nas.example/bluray/api/', registrar: opts.registrar, registrarDeadlineMs: opts.registrarDeadlineMs, trustProxy: opts.trustProxy }),
    );
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    close = () => {
      server.close();
      server.closeAllConnections();
    };
  }

  const post = (path: string, body: unknown, headers: Record<string, string> = {}): Promise<Response> =>
    fetch(`${base}${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body) });

  async function pairedToken(owner: boolean): Promise<string> {
    const { jwk, sign } = await deviceKey();
    const { code } = mint(auth, owner);
    const redeemed = await post('/api/pair/redeem', { code, deviceName: owner ? 'Mac' : 'Phone', publicKeyJwk: jwk });
    expect(redeemed.status).toBe(200);
    const { deviceId, owner: isOwner } = (await redeemed.json()) as { deviceId: string; owner: boolean };
    expect(isOwner).toBe(owner);
    const { challenge } = (await (await post('/api/session/challenge', { deviceId })).json()) as { challenge: string };
    const res = await post('/api/session', { deviceId, challenge, signature: await sign(challenge) });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { token: string; expiresAt: number };
    expect(body.expiresAt).toBe(clock + 60 * MINUTE);
    return body.token;
  }

  it('answers health and redeem without a token', async () => {
    await start();
    expect((await fetch(`${base}/api/health`)).status).toBe(200);
    await pairedToken(false);
  });

  it('answers 401 to the library without a valid token, and the listing with one', async () => {
    await start();
    const res = await fetch(`${base}/api/library`);
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: 'unauthorized' });
    expect((await fetch(`${base}/api/library?t=nope`)).status).toBe(401);
    expect((await fetch(`${base}/api/anything-else`)).status).toBe(401);

    const token = await pairedToken(false);
    expect((await fetch(`${base}/api/library?t=${encodeURIComponent(token)}`)).status).toBe(200);
    expect((await fetch(`${base}/api/library`, { headers: { Authorization: `Bearer ${token}` } })).status).toBe(200);
    clock += 60 * MINUTE;
    expect((await fetch(`${base}/api/library?t=${encodeURIComponent(token)}`)).status).toBe(401);
  });

  it('answers 403 to a non-owner on every admin route', async () => {
    await start();
    const token = await pairedToken(false);
    const auth = { Authorization: `Bearer ${token}` };
    const calls: [string, string][] = [
      ['GET', '/api/admin/devices'],
      ['GET', '/api/admin/codes'],
      ['POST', '/api/admin/codes'],
      ['DELETE', '/api/admin/devices/x'],
      ['DELETE', '/api/admin/codes/x'],
      ['POST', '/api/admin/rescan'],
    ];
    for (const [method, path] of calls) {
      const res = await fetch(`${base}${path}`, {
        method,
        headers: { ...auth, 'Content-Type': 'application/json' },
        body: method === 'POST' ? '{"newPerson":{"name":"Mika","owner":false}}' : undefined,
      });
      expect(res.status, `${method} ${path}`).toBe(403);
      expect((await fetch(`${base}${path}`, { method })).status, `${method} ${path} without a token`).toBe(401);
    }
  });

  it('lets an owner list, mint, delete and revoke', async () => {
    const registrar = { registerCode: vi.fn(async () => {}), unregisterCode: vi.fn(async () => {}) };
    await start({ registrar });
    const token = await pairedToken(true);
    const headers = { Authorization: `Bearer ${token}` };

    const minted = await post('/api/admin/codes', { newPerson: { name: 'Mika', owner: false } }, headers);
    expect(minted.status).toBe(200);
    const body = (await minted.json()) as { code: string; link: string; expiresAt: number; rendezvous: boolean };
    expect(body.code).toMatch(/^[0-9A-Z]{4}-[0-9A-Z]{4}-[0-9A-Z]{4}$/);
    expect(body.link).toBe(`https://bluray.pages.dev/?pair=${body.code.replaceAll('-', '')}&nas=https%3A%2F%2Fnas.example%2Fbluray%2Fapi%2F`);
    expect(body.expiresAt).toBe(clock + 10 * MINUTE);
    expect(body.rendezvous).toBe(true);
    const codeHashArg = registrar.registerCode.mock.calls[0] as unknown as [string, { https: string }, number];
    expect(codeHashArg[1]).toEqual({ https: 'https://nas.example/bluray/api/' });
    expect(codeHashArg[2]).toBe(body.expiresAt);
    expect(codeHashArg[0]).toMatch(/^[0-9a-f]{64}$/);

    const codes = (await (await fetch(`${base}/api/admin/codes`, { headers })).json()) as { codes: { id: string }[] };
    expect(codes.codes).toHaveLength(1);
    expect(codes.codes[0]).toEqual({ id: expect.any(String), personId: expect.any(String), personName: 'Mika', invite: false, expiresAt: body.expiresAt });
    expect((await fetch(`${base}/api/admin/codes/${codes.codes[0]!.id}`, { method: 'DELETE', headers })).status).toBe(204);
    expect((await fetch(`${base}/api/admin/codes/${codes.codes[0]!.id}`, { method: 'DELETE', headers })).status).toBe(404);
    expect((await post('/api/pair/redeem', { code: body.code, deviceName: 'x', publicKeyJwk: (await deviceKey()).jwk })).status).toBe(401);

    const phone = await pairedToken(false);
    const devices = (await (await fetch(`${base}/api/admin/devices`, { headers })).json()) as {
      devices: { id: string; name: string; owner: boolean; pairedAt: number; lastSeen: number }[];
    };
    expect(devices.devices.map((d) => d.name)).toEqual(['Mac', 'Phone']);
    expect(Object.keys(devices.devices[0]!).sort()).toEqual(['id', 'lastSeen', 'name', 'owner', 'pairedAt', 'personId', 'personName']);
    const phoneId = devices.devices[1]!.id;
    expect((await fetch(`${base}/api/admin/devices/${phoneId}`, { method: 'DELETE', headers })).status).toBe(204);
    expect((await fetch(`${base}/api/library?t=${encodeURIComponent(phone)}`)).status).toBe(401);

    const scan = vi.spyOn(library, 'scan');
    expect((await fetch(`${base}/api/admin/rescan`, { method: 'POST', headers })).status).toBe(202);
    expect(scan).toHaveBeenCalledOnce();
    // The 202 comes before the scan has written its cache under tmp; let it finish, or afterEach's rmSync can race
    // the write and fail with ENOTEMPTY.
    await scan.mock.results[0]!.value;
  }, 20_000); // about a dozen HTTP round trips plus device key generation: more than vitest's 5 s default under load

  it("pairs an owner with a code for an owner person, and a guest with a code for a new guest", async () => {
    await start();
    const headers = { Authorization: `Bearer ${await pairedToken(true)}` };
    for (const owner of [true, false]) {
      const target = owner ? { personId: auth.firstOwnerPerson().id } : { newPerson: { name: 'Mum', owner: false } };
      const { code } = (await (await post('/api/admin/codes', target, headers)).json()) as { code: string };
      const redeemed = await post('/api/pair/redeem', { code, deviceName: 'Mum', publicKeyJwk: (await deviceKey()).jwk });
      expect(redeemed.status).toBe(200);
      expect(((await redeemed.json()) as { owner: boolean }).owner).toBe(owner);
    }
  });

  it('still returns the code when the rendezvous registration fails, or with no registrar', async () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    await start({ registrar: { registerCode: async () => Promise.reject(new Error('down')), unregisterCode: async () => {} } });
    const headers = { Authorization: `Bearer ${await pairedToken(true)}` };
    const res = await post('/api/admin/codes', { personId: auth.firstOwnerPerson().id }, headers);
    expect(res.status).toBe(200);
    expect(((await res.json()) as { rendezvous: boolean }).rendezvous).toBe(false);
    expect(errors).toHaveBeenCalled();
    close!();

    await start();
    const res2 = await post('/api/admin/codes', { newPerson: { name: 'Mika', owner: false } }, { Authorization: `Bearer ${await pairedToken(true)}` });
    expect(((await res2.json()) as { rendezvous: boolean }).rendezvous).toBe(false);
  });

  it('returns the code with rendezvous: false when the registration misses its deadline', async () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    await start({ registrar: { registerCode: () => new Promise<void>(() => {}), unregisterCode: async () => {} }, registrarDeadlineMs: 50 });
    const started = Date.now();
    const res = await post('/api/admin/codes', { newPerson: { name: 'Mika', owner: false } }, { Authorization: `Bearer ${await pairedToken(true)}` });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { rendezvous: boolean }).rendezvous).toBe(false);
    expect(Date.now() - started).toBeLessThan(2_000);
    expect(errors).toHaveBeenCalledWith('rendezvous registration failed', expect.objectContaining({ message: 'rendezvous registration took over 50 ms' }));
    errors.mockRestore();
  });

  it('refuses an admin token passed in the query', async () => {
    await start();
    const token = await pairedToken(true);
    expect((await fetch(`${base}/api/admin/devices?t=${encodeURIComponent(token)}`)).status).toBe(401);
  });

  it('checks request bodies', async () => {
    await start();
    expect((await fetch(`${base}/api/pair/redeem`, { method: 'POST', body: '{}' })).status).toBe(415);
    expect((await fetch(`${base}/api/pair/redeem`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{' })).status).toBe(400);
    expect((await post('/api/pair/redeem', { code: 'x' })).status).toBe(400);
    expect((await post('/api/pair/redeem', { code: 'x', deviceName: 'y', publicKeyJwk: { kty: 'EC' } })).status).toBe(400);
    expect((await post('/api/pair/redeem', { pad: 'x'.repeat(17_000) })).status).toBe(413);
    expect((await post('/api/session/challenge', { deviceId: 'nobody' })).status).toBe(401);
    expect((await post('/api/session', { deviceId: 'nobody', challenge: 'c', signature: 's' })).status).toBe(401);
  });

  it('allows 10 failed redeems a minute per client, then 429', async () => {
    await start();
    const { jwk } = await deviceKey();
    const bad = { code: 'K7QM-4XP2-R9TD', deviceName: 'x', publicKeyJwk: jwk };
    for (let i = 0; i < 10; i++) expect((await post('/api/pair/redeem', bad)).status).toBe(401);
    const { code } = mint(auth, false);
    const blocked = await post('/api/pair/redeem', { ...bad, code });
    expect(blocked.status).toBe(429);
    expect(blocked.headers.get('retry-after')).toBe('60');
    clock += MINUTE;
    expect((await post('/api/pair/redeem', { ...bad, code })).status).toBe(200);
  });

  it('counts failures per forwarded client when the request comes through the proxy', async () => {
    await start({ trustProxy: await trustedProxy('127.0.0.1') });
    const { jwk } = await deviceKey();
    const bad = { code: 'K7QM-4XP2-R9TD', deviceName: 'x', publicKeyJwk: jwk };
    for (let i = 0; i < 10; i++) expect((await post('/api/pair/redeem', bad, { 'X-Forwarded-For': '100.64.0.1, 172.18.0.2' })).status).toBe(401);
    expect((await post('/api/pair/redeem', bad, { 'X-Forwarded-For': '100.64.0.1' })).status).toBe(429);
    expect((await post('/api/pair/redeem', bad, { 'X-Forwarded-For': '100.64.0.2' })).status).toBe(401);
  });

  it('ignores X-Forwarded-For from an untrusted peer', async () => {
    await start({ trustProxy: await trustedProxy('10.9.9.9') });
    const { jwk } = await deviceKey();
    const bad = { code: 'K7QM-4XP2-R9TD', deviceName: 'x', publicKeyJwk: jwk };
    for (let i = 0; i < 10; i++) expect((await post('/api/pair/redeem', bad, { 'X-Forwarded-For': `100.64.0.${i}` })).status).toBe(401);
    expect((await post('/api/pair/redeem', bad, { 'X-Forwarded-For': '100.64.0.99' })).status).toBe(429);
  });

  it('admits at most 10 concurrent bad redeems from one client', async () => {
    await start();
    const { jwk } = await deviceKey();
    const body = JSON.stringify({ code: 'K7QM-4XP2-R9TD', deviceName: 'x', publicKeyJwk: jwk });
    // Every request is admitted before any body is complete, so none has failed yet when the others arrive.
    const requests = Array.from({ length: 20 }, () => {
      const req = request(`${base}/api/pair/redeem`, {
        method: 'POST',
        agent: false,
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
      });
      const status = new Promise<number>((resolve, reject) => {
        req.on('response', (res) => {
          res.resume();
          resolve(res.statusCode!);
        });
        req.on('error', reject);
      });
      req.write(body.slice(0, 5));
      return { req, status };
    });
    await new Promise((r) => setTimeout(r, 100));
    for (const { req } of requests) req.end(body.slice(5));
    const statuses = await Promise.all(requests.map((r) => r.status));
    expect(statuses.filter((s) => s === 401).length).toBeLessThanOrEqual(10);
    expect(statuses.filter((s) => s !== 401).every((s) => s === 429)).toBe(true);
    expect((await post('/api/pair/redeem', JSON.parse(body))).status).toBe(429);
  });

  it('refuses to revoke the last owner device', async () => {
    await start();
    const headers = { Authorization: `Bearer ${await pairedToken(true)}` };
    const [mac] = auth.devices();
    const res = await fetch(`${base}/api/admin/devices/${mac!.id}`, { method: 'DELETE', headers });
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: 'last-owner' });
    await pairedToken(true);
    expect((await fetch(`${base}/api/admin/devices/${mac!.id}`, { method: 'DELETE', headers })).status).toBe(204);
  });

  it('fails closed when auth.json is corrupt', async () => {
    await start();
    const token = await pairedToken(false);
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    writeFileSync(join(tmp, 'data', 'auth.json'), '{"devices":"oops","codes":[]}');
    const res = await fetch(`${base}/api/library?t=${encodeURIComponent(token)}`);
    expect(res.status).toBe(500);
    expect(errors).toHaveBeenCalledWith(expect.objectContaining({ message: expect.stringMatching(/auth\.json is corrupt/) }));
    errors.mockRestore();
  });
});

const LINKS = { publicBase: 'https://nas.example/bluray/api/', appUrl: 'https://bluray.pages.dev/', rendezvousUrl: undefined };

describe('owner-code', () => {
  it('prints an owner code that the server in the same data dir redeems', async () => {
    const lines: string[] = [];
    await ownerCode(tmp, now, (line) => lines.push(line), { publicBase: 'https://nas.example/bluray/api/', appUrl: 'https://bluray.pages.dev/', rendezvousUrl: undefined });
    const code = /^Owner pairing code: ([0-9A-Z]{4}-[0-9A-Z]{4}-[0-9A-Z]{4})$/.exec(lines[0]!)?.[1];
    expect(code).toBeDefined();
    expect(lines[1]).toBe(`Pairing link: https://bluray.pages.dev/?pair=${code!.replaceAll('-', '')}&nas=https%3A%2F%2Fnas.example%2Fbluray%2Fapi%2F`);
    expect(lines[2]).toMatch(/^Expires: \d{4}-\d\d-\d\d \d\d:\d\d:\d\d /);
    expect(lines[3]).toBe('Person: Owner');
    expect(lines[5]).toMatch(/^[█▀▄ \n]+$/);
    const server = new Auth(new Store(tmp), now);
    expect(server.redeem(code!, 'Mac', (await deviceKey()).jwk)?.owner).toBe(true);
    expect(lines.at(-1)).toBe('Rendezvous: not configured (RENDEZVOUS_URL is unset)');
  });

  it('mints for the owner person named by --person, making it when there is none', async () => {
    const lines: string[] = [];
    const auth = new Auth(new Store(tmp), now);
    auth.firstOwnerPerson();
    auth.createPerson('Mika', false);
    await ownerCode(tmp, now, (line) => lines.push(line), LINKS, 'Mika');
    expect(lines[3]).toBe('Person: Mika');
    const mikas = auth.people().filter((p) => p.name === 'Mika');
    expect(mikas.map((p) => p.owner)).toEqual([false, true]);
    const code = /([0-9A-Z]{4}-[0-9A-Z]{4}-[0-9A-Z]{4})$/.exec(lines[0]!)![1]!;
    expect(auth.redeem(code, 'Laptop', (await deviceKey()).jwk)).toMatchObject({ owner: true, personId: mikas[1]!.id });

    lines.length = 0;
    await ownerCode(tmp, now, (line) => lines.push(line), LINKS, 'Mika');
    expect(auth.people().filter((p) => p.name === 'Mika')).toHaveLength(2);
    expect(lines[3]).toBe('Person: Mika');
  });

  it('registers the code with the rendezvous service, and still prints it when that fails', async () => {
    const lines: string[] = [];
    const registrar = { registerCode: vi.fn(async () => {}), unregisterCode: vi.fn(async () => {}) };
    await ownerCode(tmp, now, (line) => lines.push(line), { ...LINKS, registrar, rendezvousUrl: 'https://rendezvous.example.workers.dev' });
    const code = /([0-9A-Z]{4}-[0-9A-Z]{4}-[0-9A-Z]{4})$/.exec(lines[0]!)![1]!;
    expect(registrar.registerCode).toHaveBeenCalledWith(codeHash(code), { https: 'https://nas.example/bluray/api/' }, clock + 10 * MINUTE);
    expect(lines[1]).toContain('&rv=https%3A%2F%2Frendezvous.example.workers.dev');
    expect(lines.at(-1)).toBe('Rendezvous: registered');

    lines.length = 0;
    const down = { registerCode: async () => Promise.reject(new Error('fetch failed')), unregisterCode: async () => {} };
    await ownerCode(tmp, now, (line) => lines.push(line), { ...LINKS, registrar: down });
    expect(lines[0]).toMatch(/^Owner pairing code: /);
    expect(lines.at(-1)).toBe('Rendezvous: not registered (fetch failed)');
  });
});
