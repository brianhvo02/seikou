import { SOURCE_PACKET_SIZE } from './constants';

export interface TsPacket {
  readonly pid: number;
  readonly payloadUnitStart: boolean;
  readonly continuityCounter: number;
  readonly hasPayload: boolean;
  readonly payload: Uint8Array;
}

/** Parses the 192-byte source packet at `offset` (4-byte TP_extra_header + TS packet). Null if unusable. */
export function parseSourcePacket(buf: Uint8Array, offset: number): TsPacket | null {
  const o = offset + 4;
  if (buf[o] !== 0x47) return null;
  const b1 = buf[o + 1];
  const b2 = buf[o + 2];
  const b3 = buf[o + 3];
  if (b1 & 0x80) return null; // transport_error_indicator
  const adaptationFieldControl = (b3 >> 4) & 0x3;
  let payloadStart = o + 4;
  if (adaptationFieldControl & 0x2) payloadStart += 1 + buf[o + 4];
  const end = offset + SOURCE_PACKET_SIZE;
  if (payloadStart > end) return null;
  const hasPayload = (adaptationFieldControl & 0x1) !== 0 && payloadStart < end;
  return {
    pid: ((b1 & 0x1f) << 8) | b2,
    payloadUnitStart: (b1 & 0x40) !== 0,
    continuityCounter: b3 & 0x0f,
    hasPayload,
    payload: buf.subarray(hasPayload ? payloadStart : end, end),
  };
}
