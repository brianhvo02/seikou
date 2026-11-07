// SPDX-License-Identifier: LGPL-3.0-or-later
// Regenerates fixtures/disc1-late from fixtures/disc1: the same disc with every audio PES timestamp
// (PID 0x1100) moved 1800 ticks at 90 kHz (20 ms) later, so the audio starts after the video as it
// often does on real discs. Only PTS/DTS bytes change; file sizes and packet counts stay identical.
// Run: npx tsx scripts/make-late-audio-disc.ts
import { cpSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const SRC = 'fixtures/disc1';
const DST = 'fixtures/disc1-late';
const PACKET = 192;
const HEADER = 4;
const AUDIO_PID = 0x1100;
const SHIFT90 = 1800;
const WRAP = 2 ** 33;

function readTimestamp(b: Buffer, o: number): number {
  return (
    ((b[o]! >> 1) & 0x07) * 2 ** 30 +
    (b[o + 1]! << 22) +
    ((b[o + 2]! >> 1) << 15) +
    (b[o + 3]! << 7) +
    (b[o + 4]! >> 1)
  );
}

/** Rewrites the 33-bit value, keeping the 4-bit prefix and the three marker bits. */
function writeTimestamp(b: Buffer, o: number, value: number): void {
  const v = value % WRAP;
  const high = Math.floor(v / 2 ** 30);
  const low = v % 2 ** 30;
  b[o] = (b[o]! & 0xf0) | (high << 1) | 1;
  b[o + 1] = (low >> 22) & 0xff;
  b[o + 2] = (((low >> 15) & 0x7f) << 1) | 1;
  b[o + 3] = (low >> 7) & 0xff;
  b[o + 4] = ((low & 0x7f) << 1) | 1;
}

function shiftAudio(file: string): number {
  const buf = readFileSync(file);
  if (buf.length % PACKET !== 0) throw new Error(`${file}: not a whole number of source packets`);
  let shifted = 0;
  for (let off = 0; off < buf.length; off += PACKET) {
    const ts = off + HEADER;
    if (buf[ts] !== 0x47) throw new Error(`${file}: lost sync at ${off}`);
    const pid = ((buf[ts + 1]! & 0x1f) << 8) | buf[ts + 2]!;
    const pusi = (buf[ts + 1]! & 0x40) !== 0;
    if (pid !== AUDIO_PID || !pusi) continue;
    const afc = (buf[ts + 3]! >> 4) & 0x03;
    if ((afc & 0x01) === 0) continue; // no payload
    let p = ts + 4;
    if (afc === 0x03) p += 1 + buf[p]!;
    if (buf[p] !== 0 || buf[p + 1] !== 0 || buf[p + 2] !== 1) throw new Error(`${file}: no PES start code at ${off}`);
    const flags = buf[p + 7]! >> 6;
    if ((flags & 0x02) !== 0) writeTimestamp(buf, p + 9, readTimestamp(buf, p + 9) + SHIFT90);
    if (flags === 0x03) writeTimestamp(buf, p + 14, readTimestamp(buf, p + 14) + SHIFT90);
    if (flags !== 0) shifted++;
  }
  writeFileSync(file, buf);
  return shifted;
}

rmSync(DST, { recursive: true, force: true });
cpSync(SRC, DST, { recursive: true });
const streamDir = path.join(DST, 'BDMV', 'STREAM');
for (const name of readdirSync(streamDir).filter((n) => n.endsWith('.m2ts')).sort()) {
  const n = shiftAudio(path.join(streamDir, name));
  console.log(`${name}: shifted ${n} audio PES timestamps by ${SHIFT90} ticks`);
}
