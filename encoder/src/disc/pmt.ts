// SPDX-License-Identifier: LGPL-3.0-or-later
import { open } from 'node:fs/promises';
import { parseSourcePacket } from '@seikou/bdmv/demux/ts-packet';
import type { Playlist } from './playlist';

// A transport stream says which elementary streams make up a program in two tables of program-specific
// information (ISO/IEC 13818-1 §2.4.4): the Program Association Table on PID 0 names each program's PMT
// PID, and that Program Map Table lists the program's streams with their stream types, in an order that
// demuxers (libavformat among them) follow when they number streams. A Blu-ray clip holds one program and
// repeats both tables from its first packets on.

/** An m2ts file is a run of 192-byte source packets: a 4-byte TP_extra_header and a 188-byte transport packet. */
const SOURCE_PACKET_SIZE = 192;
/** PID of the Program Association Table (§2.4.4.3, Table 2-28). */
const PAT_PID = 0x0000;
/** `table_id` of a program_association_section (§2.4.4.4, Table 2-31). */
const PAT_TABLE_ID = 0x00;
/** `table_id` of a TS_program_map_section (§2.4.4.4, Table 2-31). */
const PMT_TABLE_ID = 0x02;
/** `descriptor_tag` of a registration_descriptor (§2.6.8, Table 2-45). */
const REGISTRATION_DESCRIPTOR = 0x05;
/** The registration_descriptor `format_identifier` Blu-ray PMTs carry: "HDMV". */
const HDMV = 0x48444d56;
/** PMT `stream_type` of Dolby TrueHD on Blu-ray, whose stream also carries an AC-3 version of the audio. */
const TRUEHD = 0x83;

/**
 * PMT `stream_type` values (§2.4.4.9, Table 2-34, user private range) that Blu-ray clips use for audio: 0x80 LPCM,
 * 0x81 AC-3, 0x82 DTS, 0x83 TrueHD, 0x84 E-AC-3, 0x85 DTS-HD High Resolution, 0x86 DTS-HD Master Audio, and the
 * secondary-audio types 0xA1 (E-AC-3) and 0xA2 (DTS-HD). libavformat makes an audio stream of each, in PMT order.
 */
export const AUDIO_STREAM_TYPES: ReadonlySet<number> = new Set([0x80, 0x81, 0x82, 0x83, 0x84, 0x85, 0x86, 0xa1, 0xa2]);

/** A clip's PAT or PMT is missing or does not hold what the plan needs; the message names the clip or the PIDs. */
export class PmtError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PmtError';
  }
}

/** One entry of a PMT's elementary stream loop (§2.4.4.8). */
export interface PmtStream {
  /** `elementary_PID`: the 13-bit PID of the packets that carry the stream. */
  pid: number;
  /** `stream_type`: the coding of the stream (Table 2-34; Blu-ray uses the CLPI coding types here). */
  streamType: number;
}

/** What a clip's first PMT says, as `readPmt` returns it. */
export interface PmtInfo {
  /** The PMT's PID, the `program_map_PID` the PAT gives for the clip's program. */
  pmtPid: number;
  /** The program's streams in PMT order. */
  streams: PmtStream[];
  /** True when the program info holds a registration_descriptor (§2.6.8) with `format_identifier` "HDMV", as Blu-ray PMTs do. */
  hdmv: boolean;
}

/** A PID as messages write it: `pidHex(0x100)` is `0x0100` (PIDs are 13 bits, so four hex digits). */
export function pidHex(pid: number): string {
  return `0x${pid.toString(16).padStart(4, '0')}`;
}

/** CRC_32 of Annex A (polynomial 0x04C11DB7, initial value 0xFFFFFFFF, no reflection); over a whole section, CRC included, it is 0. */
function crc32Mpeg(data: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of data) {
    crc ^= byte << 24;
    for (let i = 0; i < 8; i++) crc = (crc & 0x80000000) !== 0 ? (crc << 1) ^ 0x04c11db7 : crc << 1;
    crc >>>= 0;
  }
  return crc >>> 0;
}

/**
 * Gathers the sections one PID carries (§2.4.4.2): a packet with payload_unit_start_indicator begins with a
 * pointer_field, the number of bytes before the next section starts; a section is `section_length` + 3 bytes and
 * may continue in the following packets of the PID. Only the first section that starts in a packet is read,
 * which is enough for PAT and PMT sections (each table here is one section).
 */
class SectionReader {
  private parts: Uint8Array[] = [];
  private have = 0;
  private need = 0;

  /** Feeds one packet's payload; returns a complete section, or null while one is still being gathered. */
  push(payload: Uint8Array, unitStart: boolean): Uint8Array | null {
    let data = payload;
    if (unitStart) {
      if (data.length === 0) return null;
      const pointer = data[0]!;
      data = data.subarray(1 + pointer);
      this.parts = [];
      this.have = 0;
      if (data.length < 3 || data[0] === 0xff) {
        this.need = 0; // only stuffing follows
        return null;
      }
      // section_length: the 12 bits after table_id and the syntax and reserved bits, counting the bytes that follow it.
      this.need = 3 + (((data[1]! & 0x0f) << 8) | data[2]!);
    } else if (this.need === 0) {
      return null; // a continuation of a section whose start was not seen
    }
    const take = data.subarray(0, this.need - this.have);
    this.parts.push(take);
    this.have += take.length;
    if (this.have < this.need) return null;
    const section = new Uint8Array(this.need);
    let at = 0;
    for (const part of this.parts) {
      section.set(part, at);
      at += part.length;
    }
    this.need = 0;
    return section;
  }
}

/**
 * The fields of a long-form section header (§2.4.4.3 and §2.4.4.8 share it): returns the bytes between
 * `last_section_number` and the CRC_32, or null when the section is not `tableId`, not current
 * (`current_next_indicator` 0), not section 0, or fails its CRC_32.
 */
function sectionBody(section: Uint8Array, tableId: number): { idExtension: number; body: Uint8Array } | null {
  if (section.length < 12 || section[0] !== tableId) return null;
  if ((section[1]! & 0x80) === 0) return null; // section_syntax_indicator must be 1
  if (crc32Mpeg(section) !== 0) return null;
  const idExtension = (section[3]! << 8) | section[4]!; // transport_stream_id (PAT) or program_number (PMT)
  const currentNext = section[5]! & 0x01;
  const sectionNumber = section[6]!;
  if (currentNext !== 1 || sectionNumber !== 0) return null;
  return { idExtension, body: section.subarray(8, section.length - 4) };
}

/** PAT (§2.4.4.3): the first program with a non-zero `program_number` and its `program_map_PID` (number 0 names the network PID). */
function parsePat(section: Uint8Array): { program: number; pmtPid: number } | null {
  const s = sectionBody(section, PAT_TABLE_ID);
  if (!s) return null;
  for (let o = 0; o + 4 <= s.body.length; o += 4) {
    const program = (s.body[o]! << 8) | s.body[o + 1]!;
    const pid = ((s.body[o + 2]! & 0x1f) << 8) | s.body[o + 3]!;
    if (program !== 0) return { program, pmtPid: pid };
  }
  return null;
}

/**
 * PMT (§2.4.4.8): after the header, 3 reserved bits and the 13-bit `PCR_PID`, 4 reserved bits and the 12-bit
 * `program_info_length` with that many bytes of descriptors, then per stream an 8-bit `stream_type`, 3 reserved
 * bits, the 13-bit `elementary_PID`, 4 reserved bits and the 12-bit `ES_info_length` with its descriptors.
 * Null when the section is not the PMT of `program`.
 */
function parsePmt(section: Uint8Array, program: number): { streams: PmtStream[]; hdmv: boolean } | null {
  const s = sectionBody(section, PMT_TABLE_ID);
  if (!s || s.idExtension !== program) return null;
  const b = s.body;
  if (b.length < 4) return null;
  const programInfoLength = ((b[2]! & 0x0f) << 8) | b[3]!;
  // Descriptors (§2.6): an 8-bit descriptor_tag, an 8-bit descriptor_length and that many bytes; a
  // registration_descriptor's first four are its 32-bit format_identifier.
  let hdmv = false;
  for (let d = 4; d + 2 <= 4 + programInfoLength && d + 2 <= b.length; d += 2 + b[d + 1]!) {
    if (b[d] === REGISTRATION_DESCRIPTOR && b[d + 1]! >= 4 && d + 6 <= b.length) {
      if (((b[d + 2]! << 24) | (b[d + 3]! << 16) | (b[d + 4]! << 8) | b[d + 5]!) >>> 0 === HDMV) hdmv = true;
    }
  }
  const streams: PmtStream[] = [];
  let o = 4 + programInfoLength;
  while (o + 5 <= b.length) {
    const streamType = b[o]!;
    const pid = ((b[o + 1]! & 0x1f) << 8) | b[o + 2]!;
    const esInfoLength = ((b[o + 3]! & 0x0f) << 8) | b[o + 4]!;
    streams.push({ pid, streamType });
    o += 5 + esInfoLength;
  }
  return { streams, hdmv };
}

/**
 * Reads the first PAT and then the first PMT of the PAT's first program from the start of an m2ts file, looking
 * at no more than `maxPackets` source packets (a Blu-ray clip carries both in its first few packets). Sections
 * that fail their CRC_32, are not yet current or continue a table past section 0 are skipped. Rejects with
 * `PmtError` naming the clip when either table is not found in that many packets.
 */
export async function readPmt(m2tsPath: string, maxPackets = 1000): Promise<PmtInfo> {
  const file = await open(m2tsPath, 'r');
  let buf: Uint8Array;
  try {
    buf = new Uint8Array(SOURCE_PACKET_SIZE * maxPackets);
    const { bytesRead } = await file.read(buf, 0, buf.length, 0);
    buf = buf.subarray(0, bytesRead - (bytesRead % SOURCE_PACKET_SIZE));
  } finally {
    await file.close();
  }

  const patReader = new SectionReader();
  let pmtReader: SectionReader | null = null;
  let pat: { program: number; pmtPid: number } | null = null;
  for (let off = 0; off < buf.length; off += SOURCE_PACKET_SIZE) {
    const packet = parseSourcePacket(buf, off);
    if (packet === null || !packet.hasPayload) continue;
    if (pat === null) {
      if (packet.pid !== PAT_PID) continue;
      const section = patReader.push(packet.payload, packet.payloadUnitStart);
      if (section) pat = parsePat(section);
      if (pat) pmtReader = new SectionReader();
    } else if (packet.pid === pat.pmtPid && pmtReader) {
      const section = pmtReader.push(packet.payload, packet.payloadUnitStart);
      const pmt = section ? parsePmt(section, pat.program) : null;
      if (pmt) return { pmtPid: pat.pmtPid, ...pmt };
    }
  }
  const packets = buf.length / SOURCE_PACKET_SIZE;
  if (pat === null) throw new PmtError(`${m2tsPath}: no PAT in its first ${packets} packets`);
  throw new PmtError(`${m2tsPath}: no PMT for program ${pat.program} (PID ${pidHex(pat.pmtPid)}) in its first ${packets} packets`);
}

/** `readPmt` for every clip `playlist` plays, keyed by clip id; each clip is read once. Rejects as `readPmt` does. */
export async function readPlaylistPmts(playlist: Pick<Playlist, 'items'>, maxPackets = 1000): Promise<Map<string, PmtInfo>> {
  const pmts = new Map<string, PmtInfo>();
  for (const item of playlist.items) {
    if (!pmts.has(item.clipId)) pmts.set(item.clipId, await readPmt(item.m2tsPath, maxPackets));
  }
  return pmts;
}

/**
 * The 1-based position of `pid` among the audio streams libavformat makes of `pmt`: the `n` of BestSource's
 * `AudioSource(track=-n)`. libavformat makes one audio stream per PMT entry whose stream type is in
 * `AUDIO_STREAM_TYPES`, in PMT order, and in an "HDMV" program a second one right after each TrueHD entry (0x83)
 * for the AC-3 version of the audio that the TrueHD stream carries; the TrueHD stream itself comes first. Throws
 * `PmtError` naming the PID and every PID of the PMT when `pid` is not one of its audio streams.
 */
export function audioTrackIndex(pmt: PmtInfo, pid: number): number {
  let n = 0;
  for (const s of pmt.streams) {
    if (!AUDIO_STREAM_TYPES.has(s.streamType)) continue;
    n++;
    if (s.pid === pid) return n;
    if (pmt.hdmv && s.streamType === TRUEHD) n++;
  }
  throw new PmtError(
    `PID ${pidHex(pid)} is not an audio stream of the PMT (PID ${pidHex(pmt.pmtPid)}), which lists ${pmt.streams.map((s) => pidHex(s.pid)).join(', ')}`,
  );
}
