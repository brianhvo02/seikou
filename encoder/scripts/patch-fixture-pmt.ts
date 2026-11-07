// SPDX-License-Identifier: LGPL-3.0-or-later
// The synthetic fixture clips carry no PAT/PMT at all, so libavformat guesses stream types and reads the
// BD LPCM audio (PID 0x1100) as mp3. Real Blu-ray streams have a PMT with a program-level "HDMV"
// registration descriptor, which makes libavformat pick pcm_bluray for stream type 0x80.
// This script writes a PAT and such a PMT over the first two trailing null packets (PID 0x1fff) of each
// clip, so the file size and every source packet number stay the same. The PMT lists the streams of the
// clip's CLPI with their coding types as stream types (0x80 LPCM, 0x81 AC-3 and so on, the values the
// Blu-ray PMT uses), the first video stream carrying the PCR. Idempotent.
//
// Usage: tsx encoder/scripts/patch-fixture-pmt.ts [disc folder]; the default is encoder/fixtures/disc1.
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseClpi, type ProgramStream } from '@seikou/bdmv/clpi-parser';

const PACKET = 192;
const HEADER = 4;
const PMT_PID = 0x1000;
/** CLPI coding types of video streams (MPEG-2, H.264, HEVC, VC-1); the first one present carries the PCR. */
const VIDEO_CODING = new Set([0x02, 0x1b, 0x24, 0xea]);

function crc32Mpeg(data: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of data) {
    crc ^= byte << 24;
    for (let i = 0; i < 8; i++) crc = (crc & 0x80000000) !== 0 ? (crc << 1) ^ 0x04c11db7 : crc << 1;
    crc >>>= 0;
  }
  return crc >>> 0;
}

function withCrc(section: number[]): Buffer {
  const body = Buffer.from(section);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32Mpeg(body));
  return Buffer.concat([body, crc]);
}

/** A section with the 3-byte header's length field filled in; `rest` excludes the CRC. */
function section(tableId: number, rest: number[]): Buffer {
  const length = rest.length + 4;
  return withCrc([tableId, 0xb0 | (length >> 8), length & 0xff, ...rest]);
}

const PAT = section(0x00, [0x00, 0x01, 0xc1, 0x00, 0x00, 0x00, 0x01, 0xe0 | (PMT_PID >> 8), PMT_PID & 0xff]);
function pmtFor(streams: readonly ProgramStream[]): Buffer {
  const pcr = (streams.find((s) => VIDEO_CODING.has(s.codingType)) ?? streams[0]).pid;
  return section(0x02, [
    0x00, 0x01, 0xc1, 0x00, 0x00,
    0xe0 | (pcr >> 8), pcr & 0xff, // PCR PID
    0xf0, 0x06, 0x05, 0x04, 0x48, 0x44, 0x4d, 0x56, // program_info: registration descriptor "HDMV"
    ...streams.flatMap((s) => [s.codingType, 0xe0 | (s.pid >> 8), s.pid & 0xff, 0xf0, 0x00]),
  ]);
}

function sourcePacket(pid: number, sec: Buffer, extraHeader: Buffer): Buffer {
  const p = Buffer.alloc(PACKET, 0xff);
  extraHeader.copy(p, 0);
  p.set([0x47, 0x40 | (pid >> 8), pid & 0xff, 0x10, 0x00], HEADER);
  sec.copy(p, HEADER + 5);
  return p;
}

function pidAt(buf: Buffer, off: number): number {
  return ((buf[off + HEADER + 1] & 0x1f) << 8) | buf[off + HEADER + 2];
}

function patchFile(file: string, pmt: Buffer): boolean {
  const buf = readFileSync(file);
  if (buf.length % PACKET !== 0) throw new Error(`${file}: not a multiple of ${PACKET} bytes`);
  const nulls: number[] = [];
  for (let off = 0; off < buf.length; off += PACKET) {
    const pid = pidAt(buf, off);
    if (pid === 0) return false;
    if (pid === 0x1fff) nulls.push(off);
  }
  if (nulls.length < 2) throw new Error(`${file}: needs two null packets to hold the PAT and PMT`);
  sourcePacket(0, PAT, buf.subarray(nulls[0], nulls[0] + HEADER)).copy(buf, nulls[0]);
  sourcePacket(PMT_PID, pmt, buf.subarray(nulls[1], nulls[1] + HEADER)).copy(buf, nulls[1]);
  writeFileSync(file, buf);
  return true;
}

const disc = process.argv[2] ?? path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'fixtures', 'disc1');
const dir = path.join(disc, 'BDMV', 'STREAM');
for (const name of readdirSync(dir).filter((n) => n.endsWith('.m2ts')).sort()) {
  const file = path.join(dir, name);
  const clpi = parseClpi(new Uint8Array(readFileSync(path.join(disc, 'BDMV', 'CLIPINF', name.replace(/\.m2ts$/, '.clpi')))));
  const streams = clpi.programs[0]?.streams ?? [];
  if (streams.length === 0) throw new Error(`${file}: its CLPI lists no streams`);
  console.log(`${file}: ${patchFile(file, pmtFor(streams)) ? 'patched' : 'already patched'}`);
}
