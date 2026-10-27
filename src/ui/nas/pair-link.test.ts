import { describe, expect, it } from 'vitest';
import { allowedPairUrl, foreignHosts, parsePairLink, workerBase } from './pair-link';

const APP = 'https://bluray.pages.dev/';
const link = (query: string, dev = false) => parsePairLink(new URL(`${APP}?${query}`), { dev });
const enc = encodeURIComponent;

describe('parsePairLink', () => {
  it('is null without pair', () => {
    expect(link('')).toBeNull();
    expect(link(`nas=${enc('https://nas.example.com/bluray/api/')}`)).toBeNull();
  });

  it('keeps an https nas and rv', () => {
    expect(link(`pair=ABCD-EFGH-JKMN&nas=${enc('https://nas.example.com/bluray/api/')}`)).toEqual({
      code: 'ABCD-EFGH-JKMN',
      nas: 'https://nas.example.com/bluray/api/',
    });
    expect(link(`pair=ABCD-EFGH-JKMN&rv=${enc('https://rendezvous.example.workers.dev/')}`)).toEqual({
      code: 'ABCD-EFGH-JKMN',
      rv: 'https://rendezvous.example.workers.dev',
    });
  });

  it("gives a nas base its trailing slash, and drops a query or fragment", () => {
    expect(link(`pair=X&nas=${enc('https://nas.example.com/bluray/api?x=1#y')}`)?.nas).toBe('https://nas.example.com/bluray/api/');
  });

  it('drops http, other schemes, credentials and garbage, and says which it dropped', () => {
    for (const bad of ['http://nas.example.com/api/', 'ftp://nas.example.com/', 'javascript:alert(1)', 'https://user:pw@nas.example.com/', 'not a url', '']) {
      expect(link(`pair=X&nas=${enc(bad)}&rv=${enc(bad)}`)).toEqual({ code: 'X', dropped: ['nas', 'rv'] });
    }
    expect(link(`pair=X&nas=${enc('https://nas.example.com/api/')}&rv=${enc('http://rendezvous.example.workers.dev')}`)).toEqual({
      code: 'X',
      nas: 'https://nas.example.com/api/',
      dropped: ['rv'],
    });
  });

  it('keeps http only for a loopback host, and only when the app is on a loopback origin', () => {
    expect(link(`pair=X&nas=${enc('http://localhost:4192/api/')}`)).toEqual({ code: 'X', dropped: ['nas'] });
    expect(link(`pair=X&nas=${enc('http://localhost:4192/api/')}&rv=${enc('http://127.0.0.1:4191')}`, true)).toEqual({
      code: 'X',
      nas: 'http://localhost:4192/api/',
      rv: 'http://127.0.0.1:4191',
    });
    expect(link(`pair=X&rv=${enc('http://[::1]:4191/')}`, true)?.rv).toBe('http://[::1]:4191');
    expect(link(`pair=X&nas=${enc('http://192.168.1.20/api/')}`, true)).toEqual({ code: 'X', dropped: ['nas'] });
    expect(link(`pair=X&nas=${enc('http://localhost.example.com/api/')}`, true)).toEqual({ code: 'X', dropped: ['nas'] });
  });
});

describe('workerBase', () => {
  it('compares Workers by their parsed URL: host case, default port and trailing slashes do not matter', () => {
    expect(workerBase('https://Rendezvous.Example.NET:443/')).toBe('https://rendezvous.example.net');
    expect(workerBase(' https://rendezvous.example.net/x// ')).toBe('https://rendezvous.example.net/x');
    expect(workerBase('http://localhost:80')).toBe('http://localhost');
    expect(workerBase('http://localhost:4191/')).toBe('http://localhost:4191');
  });
});

describe('allowedPairUrl', () => {
  it('is null for nothing', () => {
    expect(allowedPairUrl(null, { dev: true })).toBeNull();
    expect(allowedPairUrl('  ', { dev: true })).toBeNull();
  });
});

describe('foreignHosts', () => {
  const builtIn = 'https://rendezvous.example.net';
  it('lists the server and another Worker, but not the built-in Worker', () => {
    expect(foreignHosts({ nas: 'https://nas.example.com/bluray/api/' }, builtIn)).toEqual(['nas.example.com']);
    expect(foreignHosts({ rv: 'https://rendezvous.example.workers.dev' }, builtIn)).toEqual(['rendezvous.example.workers.dev']);
    expect(foreignHosts({ rv: 'https://rendezvous.example.net' }, `${builtIn}/`)).toEqual([]);
    expect(foreignHosts({ nas: 'https://nas.example.com/api/', rv: 'https://rendezvous.example.workers.dev' }, builtIn)).toEqual([
      'nas.example.com',
      'rendezvous.example.workers.dev',
    ]);
    expect(foreignHosts({}, builtIn)).toEqual([]);
    expect(foreignHosts({ rv: 'https://rendezvous.example.net' }, 'https://RENDEZVOUS.example.net:443/')).toEqual([]);
  });

  it('counts any rv as foreign without a built-in Worker, and keeps ports', () => {
    expect(foreignHosts({ rv: 'https://rendezvous.example.net' }, undefined)).toEqual(['rendezvous.example.net']);
    expect(foreignHosts({ rv: 'http://127.0.0.1:4191' }, 'http://localhost:4191')).toEqual(['127.0.0.1:4191']);
  });
});
