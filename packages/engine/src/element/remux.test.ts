// SPDX-License-Identifier: LGPL-3.0-or-later
// testdata/avc-1280x720.h264 was made once with:
//   npx tsx -e "import('./scripts/x264.ts').then(m=>require('fs').writeFileSync('packages/engine/src/element/testdata/avc-1280x720.h264',Buffer.concat(m.encodeTestVideo(48,'1280x720'))))"
import { readFileSync } from 'node:fs';
import { PesAssembler } from '@seikou/bdmv/demux/pes-assembler';
import { parseSourcePacket } from '@seikou/bdmv/demux/ts-packet';
import { describe, expect, it } from 'vitest';
import { fixtureDiscFiles } from '../../../../tests/helpers/fixture-disc';
import { VIDEO_PID } from '../../../../tests/helpers/synthetic-disc';
import { ElementRemux } from './remux';
import type { RemuxOutput } from './remux';

interface Unit { data: Uint8Array; ptsUs: number; dtsUs?: number; inRange: boolean }

const toUs = (t: number): number => (t * 100) / 9;

function units(disc: string, count: number): Unit[] {
  const m2ts = fixtureDiscFiles(disc).get('BDMV/STREAM/00001.m2ts')!;
  const out: Unit[] = [];
  const asm = new PesAssembler((pes) => {
    if (pes.pid === VIDEO_PID && pes.pts !== undefined && out.length < count) {
      out.push({ data: pes.payload, ptsUs: toUs(pes.pts), dtsUs: pes.dts === undefined ? undefined : toUs(pes.dts), inRange: true });
    }
  });
  for (let o = 0; o + 192 <= m2ts.length && out.length < count; o += 192) {
    const pkt = parseSourcePacket(m2ts, o);
    if (pkt && pkt.pid === VIDEO_PID) asm.push(pkt);
  }
  asm.flush();
  return out.slice(0, count);
}

/** Splits an Annex B stream at access unit delimiters, as scripts/x264.ts does. */
function testdataUnits(startUs: number): Unit[] {
  const s = new Uint8Array(readFileSync(new URL('./testdata/avc-1280x720.h264', import.meta.url)));
  const starts: number[] = [];
  for (let i = 0; i + 3 < s.length; i++) {
    if (s[i] === 0 && s[i + 1] === 0 && s[i + 2] === 1 && (s[i + 3] & 0x1f) === 9) starts.push(i > 0 && s[i - 1] === 0 ? i - 1 : i);
  }
  return starts.map((a, k) => ({
    data: s.subarray(a, k + 1 < starts.length ? starts[k + 1] : s.length),
    ptsUs: startUs + (k * 1e6) / 24,
    inRange: true,
  }));
}

function run(us: Unit[], flush = true): RemuxOutput[] {
  const out: RemuxOutput[] = [];
  const r = new ElementRemux('avc', (o) => out.push(o));
  for (const u of us) r.push(u);
  if (flush) r.flush();
  return out;
}

describe('ElementRemux', () => {
  it('gives init, a segment at the second IRAP and one on flush', () => {
    const us = units('disc1', 48);
    const out: RemuxOutput[] = [];
    const r = new ElementRemux('avc', (o) => out.push(o));
    expect(r.endUs).toBe(-Infinity);
    for (const u of us) r.push(u);
    expect(out.map((o) => o.kind)).toEqual(['init', 'segment']);
    r.flush();
    expect(out.map((o) => o.kind)).toEqual(['init', 'segment', 'segment']);
    const segs = out.filter((o) => o.kind === 'segment');
    const first = segs[0] as Extract<RemuxOutput, { kind: 'segment' }>;
    const second = segs[1] as Extract<RemuxOutput, { kind: 'segment' }>;
    expect(first.startUs).toBe(us[0].ptsUs);
    expect(first.endUs).toBeCloseTo(us[24].ptsUs, -1);
    expect(second.startUs).toBe(us[24].ptsUs);
    expect(second.endUs).toBeGreaterThan(us[47].ptsUs);
    expect(r.endUs).toBe(second.endUs);
  });

  it('emits nothing before the first IRAP and drops out-of-range units', () => {
    const us = units('disc1', 48);
    expect(run(us.slice(1, 24)).length).toBe(0);
    const dropped = us.map((u, i) => (i === 5 ? { ...u, inRange: false } : u));
    const segs = run(dropped.slice(0, 24)).filter((o) => o.kind === 'segment');
    expect(segs.length).toBe(1);
  });

  it('keeps composition offsets equal to pts - dts for B-frames', () => {
    const us = units('disc2', 24);
    expect(us.some((u) => u.dtsUs !== undefined && u.dtsUs !== u.ptsUs)).toBe(true);
    const out = run(us);
    const segs = out.filter((o) => o.kind === 'segment') as Extract<RemuxOutput, { kind: 'segment' }>[];
    expect(segs.length).toBeGreaterThan(0);
    // trun: version 1, flags with duration, size, flags, cts offset; walk it
    const offs: number[] = [];
    for (const s of segs) {
      const b = s.bytes;
      const v = new DataView(b.buffer, b.byteOffset, b.byteLength);
      for (let o = 0; o + 8 <= b.length; o++) {
        if (b[o + 4] === 0x74 && b[o + 5] === 0x72 && b[o + 6] === 0x75 && b[o + 7] === 0x6e) {
          const flags = v.getUint32(o + 8) & 0xffffff;
          const n = v.getUint32(o + 12);
          let p = o + 16;
          if (flags & 1) p += 4;
          if (flags & 4) p += 4;
          for (let i = 0; i < n; i++) {
            if (flags & 0x100) p += 4;
            if (flags & 0x200) p += 4;
            if (flags & 0x400) p += 4;
            if (flags & 0x800) { offs.push(v.getInt32(p)); p += 4; }
          }
        }
      }
    }
    const expected = us.map((u) => Math.round(u.ptsUs * 0.09) - Math.round((u.dtsUs ?? u.ptsUs) * 0.09));
    expect(offs.length).toBe(us.length);
    expect(offs).toEqual(expected);
  });

  it('reset then the same units gives a second init', () => {
    const us = units('disc1', 24);
    const out: RemuxOutput[] = [];
    const r = new ElementRemux('avc', (o) => out.push(o));
    for (const u of us) r.push(u);
    r.flush();
    r.reset();
    expect(r.endUs).toBe(-Infinity);
    for (const u of us) r.push(u);
    r.flush();
    expect(out.map((o) => o.kind)).toEqual(['init', 'segment', 'init', 'segment']);
  });

  it('a new SPS mid-stream emits a new init before the next segment', () => {
    const a = units('disc1', 48);
    const b = testdataUnits(a[47].ptsUs + 1e6 / 24);
    const out = run([...a, ...b]);
    const inits = out.filter((o) => o.kind === 'init') as Extract<RemuxOutput, { kind: 'init' }>[];
    expect(inits.length).toBe(2);
    expect(inits[1].width).toBe(1280);
    expect(inits[0].width).not.toBe(1280);
    const kinds = out.map((o) => o.kind);
    const second = kinds.lastIndexOf('init');
    expect(kinds.slice(0, second)).toEqual(['init', 'segment', 'segment']);
    expect(kinds[second + 1]).toBe('segment');
  });
});
