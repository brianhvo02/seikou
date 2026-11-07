// SPDX-License-Identifier: LGPL-3.0-or-later
// The synthetic fixture clips carry no PAT/PMT at all, so libavformat guesses stream types and reads the
// BD LPCM audio (PID 0x1100) as mp3. Real Blu-ray streams have a PMT with a program-level "HDMV"
// registration descriptor, which makes libavformat pick pcm_bluray for stream type 0x80.
// This script writes a PAT and such a PMT over the first two trailing null packets (PID 0x1fff) of each
// clip, so the file size and every source packet number stay the same. Idempotent.
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const PACKET = 192;
const HEADER = 4;
const PMT_PID = 0x1000;
const VIDEO_PID = 0x1011;
const AUDIO_PID = 0x1100;

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
const PMT = section(0x02, [
  0x00, 0x01, 0xc1, 0x00, 0x00,
  0xe0 | (VIDEO_PID >> 8), VIDEO_PID & 0xff, // PCR PID
  0xf0, 0x06, 0x05, 0x04, 0x48, 0x44, 0x4d, 0x56, // program_info: registration descriptor "HDMV"
  0x1b, 0xe0 | (VIDEO_PID >> 8), VIDEO_PID & 0xff, 0xf0, 0x00,
  0x80, 0xe0 | (AUDIO_PID >> 8), AUDIO_PID & 0xff, 0xf0, 0x00,
]);

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

function patchFile(file: string): boolean {
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
  sourcePacket(PMT_PID, PMT, buf.subarray(nulls[1], nulls[1] + HEADER)).copy(buf, nulls[1]);
  writeFileSync(file, buf);
  return true;
}

const dir = path.join('fixtures', 'disc1', 'BDMV', 'STREAM');
for (const name of readdirSync(dir).filter((n) => n.endsWith('.m2ts')).sort()) {
  const file = path.join(dir, name);
  console.log(`${file}: ${patchFile(file) ? 'patched' : 'already patched'}`);
}
