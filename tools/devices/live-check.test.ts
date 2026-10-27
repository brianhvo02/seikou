import { describe, expect, it } from 'vitest';
import { checkOrigin, clockLabel, countOf, libraryPath, ownTestFolder, parseLiveArgs, parseMap, parseOwnerCode, parseRoots, storeHashes, testDiscFolder, UNCONFIRMED } from './live-check';

// The two shapes read from the NAS: the LIBRARY_ROOTS line of its .env, and its compose.override.yaml's bind mounts.
const ENV = 'LIBRARY_ROOTS=media0=/library-mnt/media0/Movies,media0-dl=/library-mnt/media0/Downloads@Downloads,media2-extras=/library-mnt/media2/Extras@Extras\n';
const OVERRIDE = `
services:
  bluray-server:
    volumes:
      - type: bind
        source: /mnt/media0
        target: /library-mnt/media0
        read_only: true
      - type: bind
        source: /mnt/media2
        target: /library-mnt/media2
        read_only: true
`;

describe('live-check', () => {
  it('maps a host path to the library path of the root that holds it', () => {
    const roots = parseRoots(ENV, OVERRIDE);
    expect(roots).toEqual([
      { name: 'media0', hostDir: '/mnt/media0/Movies' },
      { name: 'media0-dl', hostDir: '/mnt/media0/Downloads' },
      { name: 'media2-extras', hostDir: '/mnt/media2/Extras' },
    ]);
    expect(libraryPath('/mnt/media0/Movies/Some Disc', roots)).toBe('media0/Some Disc');
    expect(libraryPath('/mnt/media0/Downloads/A Set/DISC1', roots)).toBe('media0-dl/A Set/DISC1');
    expect(libraryPath('/mnt/media9/Movies/Elsewhere', roots)).toBeNull();
    expect(libraryPath('/mnt/media0/MoviesX/Not a root', roots)).toBeNull();
  });

  it('places the test disc in a folder of its own and deletes only that folder', () => {
    const roots = parseRoots(ENV, OVERRIDE);
    const f = testDiscFolder(roots[0]!, '0a1b2c3d');
    expect(f).toEqual({ hostDir: '/mnt/media0/Movies/zz-live-check-0a1b2c3d', libraryPath: 'media0/zz-live-check-0a1b2c3d/disc-bdj-store' });
    expect(() => testDiscFolder(roots[0]!, "x'; rm -rf /")).toThrow();
    expect(() => testDiscFolder({ name: 'odd', hostDir: '/srv/x y' }, '0a1b2c3d')).toThrow();
    expect(ownTestFolder(f.hostDir, '0a1b2c3d', roots)).toBe(true);
    expect(ownTestFolder(f.hostDir, 'ffffffff', roots)).toBe(false); // another run's folder
    expect(ownTestFolder('/mnt/media0/Movies', '0a1b2c3d', roots)).toBe(false);
    expect(ownTestFolder('/mnt/media0/Movies/zz-live-check-0a1b2c3d/disc-bdj-store', '0a1b2c3d', roots)).toBe(false);
    expect(ownTestFolder('/mnt/media0/Movies/zz-live-check-0a1b2c3d/..', '0a1b2c3d', roots)).toBe(false);
    expect(ownTestFolder('/mnt/media9/Movies/zz-live-check-0a1b2c3d', '0a1b2c3d', roots)).toBe(false);
  });

  it('reads the roots from the NAS settings and refuses a NAS without them', () => {
    expect(() => parseRoots('TMDB_API_KEY=x\n', OVERRIDE)).toThrow(/no LIBRARY_ROOTS/);
    expect(parseRoots('LIBRARY_ROOTS="a=/library/a"\n', '')).toEqual([{ name: 'a', hostDir: '/library/a' }]);
  });

  it('has no default root for the test disc', () => {
    const args = ['--origin', 'https://spec-x.bluray.pages.dev', '--out', '/tmp/lc', '--nas', 'https://nas.example/bluray/api'];
    expect(() => parseLiveArgs(args, {})).toThrow(/--place-root/);
    expect(parseLiveArgs([...args, '--store-disc', 'none'], {}).placeRoot).toBe('');
  });

  it('reads map.tsv', () => {
    expect(parseMap('id\tbdj\tfingerprint\tpath\nabc\t1\tf\t/mnt/media0/Movies/X\n\n').get('abc')).toBe('/mnt/media0/Movies/X');
  });

  it('reads the owner tooling output', () => {
    const out = 'Owner pairing code: ABCD-EFGH\nPairing link: https://x/?pair=ABCD-EFGH\nExpires: …\nPerson: Mika (test)\n\n▀▀\nRendezvous: registered\n';
    expect(parseOwnerCode(out)).toEqual({ code: 'ABCD-EFGH', person: 'Mika (test)', rendezvous: true });
    expect(() => parseOwnerCode('nothing')).toThrow();
  });

  it('runs on a preview origin only', () => {
    expect(checkOrigin('https://spec-x.bluray.pages.dev')).toBe('https://spec-x.bluray.pages.dev');
    expect(checkOrigin('https://spec-x.bluray.pages.dev/')).toBe('https://spec-x.bluray.pages.dev');
    expect(() => checkOrigin('https://bluray.pages.dev')).toThrow(/live site/);
    expect(() => checkOrigin('https://example.com')).toThrow();
    expect(() => checkOrigin('https://spec-x.bluray.pages.dev/app')).toThrow();
  });

  it('keeps results out of the repository and safaridriver off the stand-in ports', () => {
    const base = ['--origin', 'https://spec-x.bluray.pages.dev', '--nas', 'https://nas.example/bluray/api', '--place-root', 'media0'];
    expect(() => parseLiveArgs([...base, '--out', 'tools/devices/out'], {})).toThrow(/outside the repository/);
    expect(() => parseLiveArgs([...base, '--out', '/tmp/lc', '--wd-ports', '4191,4211'], {})).toThrow(/4191/);
    expect(() => parseLiveArgs([...base, '--out', '/tmp/lc', '--wd-ports', '4100,4211'], {})).toThrow();
    const o = parseLiveArgs([...base, '--out', '/tmp/lc', '--mika-phone', 'sim:iPhone 17', '--library'], {});
    expect(o.discs).toEqual([...UNCONFIRMED]);
    expect(o.discs).toHaveLength(14);
    expect(o.wdPorts).toEqual([4211, 4212]);
    expect(o.nas).toBe('https://nas.example/bluray/api/');
    expect(() => parseLiveArgs([...base, '--out', '/tmp/lc', '--mika-phone', 'iphone'], {})).toThrow(/unknown target/);
  });

  it('takes the NAS from --nas or LIVE_CHECK_NAS, with no default (review minor 9)', () => {
    const base = ['--origin', 'https://spec-x.bluray.pages.dev', '--out', '/tmp/lc', '--place-root', 'media0'];
    expect(() => parseLiveArgs(base, {})).toThrow(/no NAS given: pass --nas <api base> or set LIVE_CHECK_NAS/);
    expect(parseLiveArgs(base, { LIVE_CHECK_NAS: 'https://nas.example/bluray/api/' }).nas).toBe('https://nas.example/bluray/api/');
    expect(parseLiveArgs([...base, '--nas', 'https://other.example/api'], { LIVE_CHECK_NAS: 'https://nas.example/bluray/api/' }).nas).toBe('https://other.example/api/');
  });

  it('reads the count from the plane hash', () => {
    const hashes = storeHashes();
    expect(new Set(hashes).size).toBe(3);
    expect(countOf(hashes[1]!, hashes)).toBe(1);
    expect(countOf('nope', hashes)).toBeNull();
    expect(countOf(null, hashes)).toBeNull();
  });
});

describe('clockLabel', () => {
  it('shows a place as the resume prompt does, m:ss rounded down', () => {
    expect(clockLabel(0)).toBe('0:00');
    expect(clockLabel(8_999_999)).toBe('0:08');
    expect(clockLabel(61_000_000)).toBe('1:01');
  });
});
