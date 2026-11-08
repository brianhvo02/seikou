// SPDX-License-Identifier: LGPL-3.0-or-later
// Builders for MPEG-2 program-specific information (ISO/IEC 13818-1 §2.4.4): PAT and PMT sections and the
// 192-byte Blu-ray source packets that carry them. Used by the PMT tests and by encoder/scripts/patch-fixture-pmt.ts.

/** Size of a Blu-ray source packet: a 4-byte TP_extra_header and a 188-byte transport packet. */
export const SOURCE_PACKET = 192;
/** Size of the TP_extra_header (copy permission and arrival timestamp) before each transport packet. */
export const EXTRA_HEADER = 4;

/** CRC_32 of ISO/IEC 13818-1 Annex A (polynomial 0x04C11DB7, initial 0xFFFFFFFF, no reflection, no final XOR). */
export function crc32Mpeg(data: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of data) {
    crc ^= byte << 24;
    for (let i = 0; i < 8; i++) crc = (crc & 0x80000000) !== 0 ? (crc << 1) ^ 0x04c11db7 : crc << 1;
    crc >>>= 0;
  }
  return crc >>> 0;
}

/** A long-form section (`section_syntax_indicator` 1) with `section_length` and the CRC_32 filled in; `rest` starts after `section_length`. */
function section(tableId: number, rest: number[]): Uint8Array {
  const length = rest.length + 4;
  const body = new Uint8Array([tableId, 0xb0 | (length >> 8), length & 0xff, ...rest]);
  const out = new Uint8Array(body.length + 4);
  out.set(body);
  new DataView(out.buffer).setUint32(body.length, crc32Mpeg(body));
  return out;
}

/** A PAT section (§2.4.4.3), version 0, current, section 0 of 0, listing `programs` in order. */
export function patSection(programs: { program: number; pmtPid: number }[], transportStreamId = 1): Uint8Array {
  return section(0x00, [
    transportStreamId >> 8, transportStreamId & 0xff, 0xc1, 0x00, 0x00,
    ...programs.flatMap((p) => [p.program >> 8, p.program & 0xff, 0xe0 | (p.pmtPid >> 8), p.pmtPid & 0xff]),
  ]);
}

/**
 * A PMT section (§2.4.4.8) for `program`, version 0, current, with the "HDMV" registration descriptor
 * (§2.6.8) in its program info, as Blu-ray PMTs carry it, and one entry per stream with no ES descriptors.
 */
export function pmtSection(o: { program?: number; pcrPid: number; streams: { pid: number; streamType: number }[] }): Uint8Array {
  const program = o.program ?? 1;
  return section(0x02, [
    program >> 8, program & 0xff, 0xc1, 0x00, 0x00,
    0xe0 | (o.pcrPid >> 8), o.pcrPid & 0xff,
    0xf0, 0x06, 0x05, 0x04, 0x48, 0x44, 0x4d, 0x56,
    ...o.streams.flatMap((s) => [s.streamType, 0xe0 | (s.pid >> 8), s.pid & 0xff, 0xf0, 0x00]),
  ]);
}

/**
 * The source packets that carry `sec` on `pid`: the first with payload_unit_start_indicator and a zero
 * pointer_field (§2.4.4.2), the rest continuing it, stuffed with 0xFF. Each packet gets `extraHeader`.
 */
export function psiPackets(pid: number, sec: Uint8Array, extraHeader: Uint8Array = new Uint8Array(EXTRA_HEADER)): Uint8Array[] {
  const packets: Uint8Array[] = [];
  let at = 0;
  let cc = 0;
  while (at < sec.length || packets.length === 0) {
    const p = new Uint8Array(SOURCE_PACKET).fill(0xff);
    p.set(extraHeader.subarray(0, EXTRA_HEADER), 0);
    const first = packets.length === 0;
    p.set([0x47, (first ? 0x40 : 0x00) | (pid >> 8), pid & 0xff, 0x10 | cc], EXTRA_HEADER);
    let o = EXTRA_HEADER + 4;
    if (first) p[o++] = 0x00;
    const n = Math.min(SOURCE_PACKET - o, sec.length - at);
    p.set(sec.subarray(at, at + n), o);
    at += n;
    cc = (cc + 1) & 0x0f;
    packets.push(p);
  }
  return packets;
}

/** A source packet of the null PID 0x1FFF (§2.4.3.3), payload 0xFF. */
export function nullPacket(): Uint8Array {
  const p = new Uint8Array(SOURCE_PACKET).fill(0xff);
  p.set([0x00, 0x00, 0x00, 0x00, 0x47, 0x1f, 0xff, 0x10], 0);
  return p;
}
