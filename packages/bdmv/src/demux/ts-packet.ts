import { SOURCE_PACKET_SIZE } from './constants';

/** The header fields of one transport packet that the demuxer uses (ISO/IEC 13818-1 §2.4.3.2 and §2.4.3.3). */
export interface TsPacket {
  /** The 13-bit PID: which elementary stream or table the packet belongs to. */
  readonly pid: number;
  /** `payload_unit_start_indicator`: the payload starts a new PES packet (or a PSI section). */
  readonly payloadUnitStart: boolean;
  /** The 4-bit `continuity_counter`, which steps by one per packet with payload on the same PID. */
  readonly continuityCounter: number;
  /** `adaptation_field_control` says the packet has a payload, and it is not empty. */
  readonly hasPayload: boolean;
  /** The bytes after the header and any adaptation field (§2.4.3.4), as a view into the read buffer; empty without a payload. */
  readonly payload: Uint8Array;
}

/**
 * Parses the 192-byte source packet at `offset` (4-byte TP_extra_header, then the TS packet). Null when it is unusable:
 * no 0x47 sync byte, `transport_error_indicator` set, or an adaptation field longer than the packet.
 */
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
