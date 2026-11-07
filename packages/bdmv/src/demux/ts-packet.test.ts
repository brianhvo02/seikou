import { describe, expect, it } from 'vitest';
import { muxM2ts } from '../../../../tests/helpers/ts-muxer';
import { parseSourcePacket } from './ts-packet';

describe('parseSourcePacket', () => {
  const { bytes } = muxM2ts([{ pid: 0x1011, streamId: 0xe0, pts: 900_000, payload: new Uint8Array(300).fill(7) }]);

  it('parses a full-payload packet with unit start', () => {
    const p = parseSourcePacket(bytes, 0);
    expect(p).toMatchObject({ pid: 0x1011, payloadUnitStart: true, continuityCounter: 0, hasPayload: true });
    expect(p?.payload.length).toBe(184);
    expect(Array.from(p?.payload.subarray(0, 4) ?? [])).toEqual([0, 0, 1, 0xe0]);
  });

  it('skips adaptation-field stuffing', () => {
    const p = parseSourcePacket(bytes, 192);
    expect(p).toMatchObject({ pid: 0x1011, payloadUnitStart: false, continuityCounter: 1 });
    expect(p?.payload.length).toBe(314 - 184);
  });

  it('returns null for a lost sync byte or transport error', () => {
    const broken = bytes.slice(0, 192);
    broken[4] = 0x00;
    expect(parseSourcePacket(broken, 0)).toBeNull();
    const tei = bytes.slice(0, 192);
    tei[5] |= 0x80;
    expect(parseSourcePacket(tei, 0)).toBeNull();
  });

  it('reports no payload for null packets padded by the muxer', () => {
    const p = parseSourcePacket(bytes, 192 * 31);
    expect(p?.pid).toBe(0x1fff);
  });
});
