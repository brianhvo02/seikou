import { describe, expect, it } from 'vitest';
import { contentHash } from './content-hash';
import { discKeyOf, parseDiscKey, streamsOf } from './disc-key';

const ID = '0123456789abcdef';

describe('disc key', () => {
  it('keys a disc by the content fingerprint of its streams only', () => {
    const files = [
      { path: 'BDMV/STREAM/00001.M2TS', size: 1000 },
      { path: 'BDMV/STREAM/00002.M2TS', size: 2000 },
      { path: 'BDMV/PLAYLIST/00000.MPLS', size: 50 },
      { path: 'BDMV/STREAM/SSIF/00001.SSIF', size: 70 },
      { path: 'BDMV/STREAM/SSIF/00003.M2TS', size: 80 },
    ];
    expect(streamsOf(files)).toEqual([
      { name: '00001.M2TS', size: 1000 },
      { name: '00002.M2TS', size: 2000 },
    ]);
    const hash = contentHash([{ name: '00001.M2TS', size: 1000 }, { name: '00002.M2TS', size: 2000 }]);
    expect(hash).not.toBeNull();
    expect(discKeyOf(ID, files)).toBe(`f.${hash}`);
  });

  it('falls back to the disc id without streams', () => {
    expect(discKeyOf(ID, [{ path: 'BDMV/PLAYLIST/00000.MPLS', size: 5 }])).toBe(`d.${ID}`);
  });

  it('parses both forms and rejects the rest', () => {
    const fp = 'A'.repeat(32);
    expect(parseDiscKey(`f.${fp}`)).toEqual({ kind: 'fingerprint', fingerprint: fp });
    expect(parseDiscKey(`d.${ID}`)).toEqual({ kind: 'disc', discId: ID });
    for (const bad of ['', 'x.abc', 'f.xyz', 'd.ABC', 'f.']) expect(parseDiscKey(bad)).toBeNull();
  });
});
