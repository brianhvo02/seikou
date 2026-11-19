import { describe, expect, it } from 'vitest';
import { fixtureDiscFiles } from '../../../../tests/helpers/fixture-disc';
import { syntheticSource } from '../../../../tests/helpers/synthetic-disc';
import type { DiscManifest } from '@seikou/nas/nas-api';
import { NO_DISC_ID, discFingerprint, discScopes, javaDiscId, orgDirName, readBdjos, scopesFor, storeSource } from './scopes';

const HEX32 = /^[0-9a-f]{32}$/;

describe('scopesFor (BDJAppProxy.createStorage, BDJXletContext dvb.org.id)', () => {
  it("names a disc's scopes as libbluray's Java does, with the NAS contract's ids as keys (made-up ids of a typical disc)", () => {
    const s = scopesFor({ orgId: 0x7fff0123 }, '88000000000000000000000000139561', 'unused');
    expect(s.persistent).toEqual({ key: 'persistent/7fff0123', dir: '/persistent/7fff0123' });
    expect(s.buda).toEqual({ key: 'buda/7fff0123/88000000000000000000000000139561', dir: '/buda/7fff0123/88000000000000000000000000139561' });
    // the files beside the disc folders (ruling R14)
    expect(s.budaOrg).toEqual({ key: 'buda/7fff0123', dir: '/buda/7fff0123', looseOnly: true });
  });

  it('keeps Integer.toHexString in Java\'s directories (no leading zeros; negative ints as 8 digits) and 8 digits in the keys', () => {
    const small = scopesFor({ orgId: 0x0000a1b2 }, '88000000000000000000000000139561', 'unused');
    expect(small.persistent).toEqual({ key: 'persistent/0000a1b2', dir: '/persistent/a1b2' });
    expect(small.buda.dir).toBe('/buda/a1b2/88000000000000000000000000139561');
    expect(orgDirName(0xffff27dd)).toBe('ffff27dd'); // as the int -55331 prints
    expect(orgDirName(-55331)).toBe('ffff27dd');
    expect(scopesFor({ orgId: 0xffff27dd }, null, NO_DISC_ID).persistent.key).toBe('persistent/ffff27dd');
  });

  it("gives Java 32 zeros for a missing or all-zero id.bdmv disc ID (_bdj_init), but keys BUDA by the disc's fingerprint (Review Focus 5)", () => {
    expect(javaDiscId(null)).toBe(NO_DISC_ID);
    expect(javaDiscId('')).toBe(NO_DISC_ID);
    const fp = 'c0ffee00c0ffee00c0ffee00c0ffee00';
    for (const id of [null, NO_DISC_ID]) {
      const s = scopesFor({ orgId: 0x7fff0123 }, id, fp);
      expect(s.buda).toEqual({ key: `buda/7fff0123/${fp}`, dir: `/buda/7fff0123/${NO_DISC_ID}` });
      expect(s.persistent).toEqual({ key: 'persistent/7fff0123', dir: '/persistent/7fff0123' }); // shared by the organisation, as in libbluray
    }
  });
});

describe('discFingerprint', () => {
  const files = [
    { path: 'BDMV/INDEX.BDMV', size: 120 },
    { path: 'BDMV/STREAM/00000.M2TS', size: 6144 },
    { path: 'BDMV/JAR/00000.JAR', size: 3000 },
  ];

  it('is 32 hex digits from the BDMV files\' paths and sizes, in any order, ignoring backups and other folders', async () => {
    const fp = await discFingerprint(files);
    expect(fp).toMatch(HEX32);
    expect(await discFingerprint([...files].reverse())).toBe(fp);
    expect(await discFingerprint([...files, { path: 'BDMV/BACKUP/INDEX.BDMV', size: 120 }, { path: 'CERTIFICATE/APP.DISCROOT.CRT', size: 9 }])).toBe(fp);
  });

  it('tells two discs apart that differ in one size, so two discs without an ID do not share a BUDA scope', async () => {
    const other = files.map((f) => (f.path.endsWith('.M2TS') ? { ...f, size: f.size + 192 } : f));
    expect(await discFingerprint(other)).not.toBe(await discFingerprint(files));
  });
});

describe('discScopes', () => {
  it("reads the disc's BDJOs and gives each organisation's two scopes once (disc-bdj has no id.bdmv)", async () => {
    const source = syntheticSource(fixtureDiscFiles('disc-bdj'));
    const bdjos = await readBdjos(source);
    expect(bdjos.length).toBeGreaterThan(0);
    const orgs = [...new Set(bdjos.flatMap((b) => b.apps.map((a) => a.orgId >>> 0)))];
    const scopes = await discScopes(source, null);
    const fp = await discFingerprint(source.paths().map((path) => ({ path, size: source.size(path) })));
    expect(scopes).toEqual(orgs.sort((a, b) => a - b).flatMap((o) => {
      const s = scopesFor({ orgId: o }, null, fp);
      return [s.persistent, s.buda, s.budaOrg];
    }));
    expect(scopes.every((s) => !s.key.includes(NO_DISC_ID))).toBe(true);
  });

  it('has no scopes for a disc without BDJOs', async () => {
    expect(await discScopes(syntheticSource(fixtureDiscFiles('disc1')), null)).toEqual([]);
  });
});

describe('storeSource', () => {
  it('is nas:<nasDiscId> for a NAS disc and local for a picked folder', () => {
    const manifest: DiscManifest = { discId: 'd1e2', name: 'x', files: [], inline: {} };
    expect(storeSource({ kind: 'remote', base: 'https://nas/bluray/api/discs/d1e2/', token: 't', manifest })).toBe('nas:d1e2');
    expect(storeSource({ kind: 'files', entries: [] })).toBe('local');
  });
});
