import { describe, expect, it } from 'vitest';
import { ParseError } from './byte-reader';
import { parseBdid } from './bdid-parser';

function idBdmv(version = '0300'): Uint8Array {
  const bytes = new Uint8Array(104);
  bytes.set([...'BDID' + version].map((c) => c.charCodeAt(0)));
  bytes.set([0x7f, 0xff, 0x55, 0x53], 40);
  bytes.set([0x88, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0x13, 0x95, 0x61], 44);
  return bytes;
}

describe('parseBdid', () => {
  it('reads the organisation and disc IDs as lower-case hex', () => {
    expect(parseBdid(idBdmv())).toEqual({ orgId: '7fff5553', discId: '88000000000000000000000000139561' });
  });

  it('rejects a bad signature or version', () => {
    const bad = idBdmv();
    bad[0] = 0x58;
    expect(() => parseBdid(bad)).toThrow(ParseError);
    expect(() => parseBdid(idBdmv('0400'))).toThrow(ParseError);
  });

  it('rejects a file too short for the IDs', () => {
    expect(() => parseBdid(idBdmv().subarray(0, 50))).toThrow(ParseError);
  });
});
