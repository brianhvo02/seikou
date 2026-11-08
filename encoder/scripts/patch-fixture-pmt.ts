// SPDX-License-Identifier: LGPL-3.0-or-later
// The synthetic fixture clips carry no PAT/PMT at all, so libavformat guesses stream types and reads the
// BD LPCM audio (PID 0x1100) as mp3. Real Blu-ray streams start with a PAT and a PMT that has a program-level
// "HDMV" registration descriptor, which makes libavformat pick pcm_bluray for stream type 0x80, and number the
// audio streams in PMT order (the encoder reads the PMT from a clip's first packets to find that order).
// This script puts a PAT and such a PMT (ISO/IEC 13818-1 §2.4.4.3, §2.4.4.8) in the first source packets of
// each clip and removes as many null packets (PID 0x1fff) from further on, so the file size stays the same.
// Every packet before a removed one moves later; the CLPI's EP map is rewritten to match, and each entry is
// checked to point at the same packet as before. The PMT, on the CLPI's program_map_PID, lists the streams of
// the clip's CLPI with their coding types as stream types (0x80 LPCM, 0x81 AC-3 and so on, the values the
// Blu-ray PMT uses), the first video stream carrying the PCR. A clip patched by an earlier version of this
// script, which wrote the tables over two null packets in place, has those packets removed instead.
// Idempotent: a clip whose first packet is already a PAT is left alone.
//
// Usage: tsx encoder/scripts/patch-fixture-pmt.ts [disc folder]; the default is encoder/fixtures/disc1.
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseClpi, type Clpi, type ProgramStream } from '@seikou/bdmv/clpi-parser';
import { EXTRA_HEADER, patSection, pmtSection, psiPackets, SOURCE_PACKET } from '../tests/helpers/psi';

/** The PMT PID the earlier version of this script used, whatever the CLPI said. */
const OLD_PMT_PID = 0x1000;
const NULL_PID = 0x1fff;
/** CLPI coding types of video streams (MPEG-2, H.264, HEVC, VC-1); the first one present carries the PCR. */
const VIDEO_CODING = new Set([0x02, 0x1b, 0x24, 0xea]);
/** SPN_EP_fine holds the low 17 bits of an entry's source packet number. */
const FINE_SPAN = 0x20000;

function pidAt(buf: Uint8Array, packet: number): number {
  const o = packet * SOURCE_PACKET + EXTRA_HEADER;
  return ((buf[o + 1]! & 0x1f) << 8) | buf[o + 2]!;
}

function tablesFor(clpi: Clpi, extraHeader: Uint8Array): Uint8Array[] {
  const program = clpi.programs[0];
  const streams: readonly ProgramStream[] = program?.streams ?? [];
  if (!program || streams.length === 0) throw new Error('its CLPI lists no streams');
  const pcrPid = (streams.find((s) => VIDEO_CODING.has(s.codingType)) ?? streams[0]!).pid;
  return [
    ...psiPackets(0, patSection([{ program: 1, pmtPid: program.programMapPid }]), extraHeader),
    ...psiPackets(program.programMapPid, pmtSection({ pcrPid, streams: streams.map((s) => ({ pid: s.pid, streamType: s.codingType })) }), extraHeader),
  ];
}

/** Rewrites every SPN_EP_coarse and SPN_EP_fine of the CLPI's EP map in place through `move`. */
function rewriteEpMap(clpi: Uint8Array, move: (spn: number) => number): void {
  const view = new DataView(clpi.buffer, clpi.byteOffset, clpi.byteLength);
  const cpiStart = view.getUint32(16);
  if (cpiStart === 0 || view.getUint32(cpiStart) === 0 || (view.getUint16(cpiStart + 4) & 0x0f) !== 1) return;
  const epMapStart = cpiStart + 6;
  const pidCount = clpi[epMapStart + 1]!;
  for (let p = 0; p < pidCount; p++) {
    const h = epMapStart + 2 + p * 12;
    // reserved(10) EP_stream_type(4) number_of_EP_coarse_entries(16) number_of_EP_fine_entries(18) in 6 bytes
    const bits = view.getUint16(h + 2) * 2 ** 32 + view.getUint32(h + 4);
    const coarseCount = Math.floor(bits / 2 ** 18) % 2 ** 16;
    const fineCount = bits % 2 ** 18;
    const start = epMapStart + view.getUint32(h + 8);
    const fineStart = start + view.getUint32(start);
    for (let c = 0; c < coarseCount; c++) {
      const at = start + 4 + c * 8;
      const ref = view.getUint32(at) >>> 14;
      const end = c + 1 < coarseCount ? view.getUint32(at + 8) >>> 14 : fineCount;
      const oldCoarse = view.getUint32(at + 4);
      const newCoarse = move(oldCoarse);
      view.setUint32(at + 4, newCoarse);
      for (let f = ref; f < end; f++) {
        const fat = fineStart + f * 4;
        const word = view.getUint32(fat);
        const full = Math.floor(oldCoarse / FINE_SPAN) * FINE_SPAN + (word & 0x1ffff);
        const moved = move(full);
        if (Math.floor(moved / FINE_SPAN) !== Math.floor(newCoarse / FINE_SPAN)) {
          throw new Error(`EP entry at SPN ${full} would cross a ${FINE_SPAN}-packet boundary`);
        }
        view.setUint32(fat, ((word & ~0x1ffff) | (moved % FINE_SPAN)) >>> 0);
      }
    }
  }
}

function patchClip(m2tsFile: string, clpiFile: string): 'patched' | 'already patched' {
  const buf = new Uint8Array(readFileSync(m2tsFile));
  if (buf.length % SOURCE_PACKET !== 0) throw new Error(`${m2tsFile}: not a multiple of ${SOURCE_PACKET} bytes`);
  const count = buf.length / SOURCE_PACKET;
  if (count > 0 && pidAt(buf, 0) === 0) return 'already patched';

  const clpiBytes = new Uint8Array(readFileSync(clpiFile));
  const clpi = parseClpi(clpiBytes);
  const starts = [
    ...clpi.atcSequences.flatMap((a) => [a.spnAtcStart, ...a.stc.map((s) => s.spnStcStart)]),
    ...clpi.programs.map((p) => p.spnProgramSequenceStart),
  ];
  if (starts.some((s) => s !== 0)) throw new Error(`${clpiFile}: an ATC, STC or program sequence starts after SPN 0`);

  const tables = tablesFor(clpi, buf.subarray(0, EXTRA_HEADER));
  const earlier = Array.from({ length: count }, (_, i) => i).some((i) => pidAt(buf, i) === 0);
  const droppable: number[] = [];
  for (let i = 0; i < count && droppable.length < tables.length; i++) {
    const pid = pidAt(buf, i);
    if (pid === NULL_PID || (earlier && (pid === 0 || pid === OLD_PMT_PID))) droppable.push(i);
  }
  if (droppable.length < tables.length) throw new Error(`${m2tsFile}: needs ${tables.length} null packets to make room for the PAT and PMT`);

  const dropped = new Set(droppable);
  const out = new Uint8Array(buf.length);
  tables.forEach((t, i) => out.set(t, i * SOURCE_PACKET));
  let at = tables.length;
  for (let i = 0; i < count; i++) {
    if (dropped.has(i)) continue;
    out.set(buf.subarray(i * SOURCE_PACKET, (i + 1) * SOURCE_PACKET), at * SOURCE_PACKET);
    at++;
  }
  const move = (spn: number): number => {
    if (dropped.has(spn)) throw new Error(`EP entry at SPN ${spn} points at a packet being removed`);
    return spn + tables.length - droppable.filter((d) => d < spn).length;
  };
  const newClpi = clpiBytes.slice();
  rewriteEpMap(newClpi, move);

  // Every EP entry must still point at the packet it pointed at.
  const before = clpi.epMaps.flatMap((m) => m.entries);
  const after = parseClpi(newClpi).epMaps.flatMap((m) => m.entries);
  before.forEach((e, i) => {
    const n = after[i]!;
    const was = buf.subarray(e.spn * SOURCE_PACKET + EXTRA_HEADER, (e.spn + 1) * SOURCE_PACKET);
    const now = out.subarray(n.spn * SOURCE_PACKET + EXTRA_HEADER, (n.spn + 1) * SOURCE_PACKET);
    if (n.pts !== e.pts || Buffer.compare(was, now) !== 0) throw new Error(`${clpiFile}: EP entry ${i} no longer points at its packet`);
  });

  writeFileSync(m2tsFile, out);
  writeFileSync(clpiFile, newClpi);
  return 'patched';
}

const disc = process.argv[2] ?? path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'fixtures', 'disc1');
const dir = path.join(disc, 'BDMV', 'STREAM');
for (const name of readdirSync(dir).filter((n) => n.endsWith('.m2ts')).sort()) {
  const file = path.join(dir, name);
  const clpiFile = path.join(disc, 'BDMV', 'CLIPINF', name.replace(/\.m2ts$/, '.clpi'));
  console.log(`${file}: ${patchClip(file, clpiFile)}`);
}
