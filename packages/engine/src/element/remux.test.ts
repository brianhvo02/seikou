// SPDX-License-Identifier: LGPL-3.0-or-later
// testdata/avc-1280x720.h264 was made once with:
//   npx tsx -e "import('./scripts/x264.ts').then(m=>require('fs').writeFileSync('packages/engine/src/element/testdata/avc-1280x720.h264',Buffer.concat(m.encodeTestVideo(48,'1280x720'))))"
import { readFileSync } from 'node:fs';
import { PesAssembler } from '@seikou/bdmv/demux/pes-assembler';
import { parseSourcePacket } from '@seikou/bdmv/demux/ts-packet';
import { describe, expect, it } from 'vitest';
import { fixtureDiscFiles } from '../../../../tests/helpers/fixture-disc';
import { VIDEO_PID } from '../../../../tests/helpers/synthetic-disc';
import { analyzeAvc } from '@seikou/bdmv/codecs/h264';
import { ELEMENT_TIME_OFFSET_US, mediaSegment } from './fmp4';
import { ElementRemux, elementCodec } from './remux';
import { PROGRESSIVE_SPS, avcAu } from '../../../../tests/helpers/h264-units';
import type { RemuxOutput } from './remux';

interface Unit { data: Uint8Array; ptsUs: number; dtsUs?: number; inRange: boolean }

const toUs = (t: number): number => (t * 100) / 9;

/** Units as the pipeline delivers them: times relative to the first picture's PTS (a play item's IN time). */
function mapped(disc: string, count: number): Unit[] {
  const us = units(disc, count);
  const base = us[0].ptsUs;
  return us.map((u) => ({ ...u, ptsUs: u.ptsUs - base, dtsUs: u.dtsUs === undefined ? undefined : u.dtsUs - base }));
}

interface Parsed { tfdt: number; durs: number[]; cts: number[] }

function parseSegment(b: Uint8Array): Parsed {
  const v = new DataView(b.buffer, b.byteOffset, b.byteLength);
  const at = (t: string): number => {
    for (let o = 4; o + 4 <= b.length; o++) if (String.fromCharCode(...b.subarray(o, o + 4)) === t) return o - 4;
    throw new Error(t);
  };
  const td = at('tfdt');
  const tfdt = v.getUint32(td + 12) * 2 ** 32 + v.getUint32(td + 16);
  const tr = at('trun');
  const n = v.getUint32(tr + 12);
  const durs: number[] = [];
  const cts: number[] = [];
  let p = tr + 20;
  for (let i = 0; i < n; i++) {
    durs.push(v.getUint32(p));
    cts.push(v.getInt32(p + 12));
    p += 16;
  }
  return { tfdt, durs, cts };
}

function segments(out: RemuxOutput[]): Extract<RemuxOutput, { kind: 'segment' }>[] {
  return out.filter((o) => o.kind === 'segment') as Extract<RemuxOutput, { kind: 'segment' }>[];
}

function expectAbut(out: RemuxOutput[]): void {
  const ps = segments(out).map((s) => parseSegment(s.bytes));
  for (let i = 0; i + 1 < ps.length; i++) {
    expect(ps[i].tfdt + ps[i].durs.reduce((a, b) => a + b, 0)).toBe(ps[i + 1].tfdt);
  }
}

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

  it('keeps composition offsets equal to pts - dts for B-frames and bounds the segment by min and max PTS', () => {
    const us = units('disc2', 48);
    expect(us.some((u) => u.dtsUs !== undefined && u.dtsUs !== u.ptsUs)).toBe(true);
    const out = run(us);
    const segs = segments(out);
    const parsed = segs.map((x) => parseSegment(x.bytes));
    const offs = parsed.flatMap((p) => p.cts);
    const expected = us.map((u) => Math.round(u.ptsUs * 0.09) - Math.round((u.dtsUs ?? u.ptsUs) * 0.09));
    expect(offs).toEqual(expected);
    const last = parsed[parsed.length - 1];
    const lastSeg = segs[segs.length - 1];
    const maxPts = Math.max(...us.slice(us.length - last.cts.length).map((u) => u.ptsUs));
    expect(lastSeg.endUs).toBeGreaterThan(maxPts);
    expect(lastSeg.endUs).toBeCloseTo(maxPts + (last.durs[last.durs.length - 1] * 1e6) / 90000, 3);
    expect(segs[0].startUs).toBe(Math.min(...us.slice(0, parsed[0].cts.length).map((u) => u.ptsUs)));
    expectAbut(out);
  });

  it('writes a positive tfdt of dts + offset for playlist-mapped B-frame units', () => {
    const us = mapped('disc2', 48);
    expect(us[0].dtsUs!).toBeLessThan(0);
    const out = run(us);
    const first = parseSegment(segments(out)[0].bytes);
    expect(first.tfdt).toBe(Math.round(us[0].dtsUs! * 0.09) + Math.round(ELEMENT_TIME_OFFSET_US * 0.09));
    expect(first.tfdt).toBeGreaterThan(0);
    expect(segments(out)[0].startUs).toBe(0);
    expectAbut(out);
  });

  it('segments of disc1 abut', () => {
    expectAbut(run(units('disc1', 48)));
  });

  it('uses the next IRAP decode time for the last sample of a segment', () => {
    const us = units('disc1', 1);
    const a = us[0];
    const out = run([a, { ...a, ptsUs: a.ptsUs + 125_000, dtsUs: a.ptsUs + 125_000 }]);
    const segs = segments(out);
    expect(segs.length).toBe(2);
    expect(parseSegment(segs[0].bytes).durs).toEqual([11250]);
    expectAbut(out);
  });

  it('rejects a negative or fractional base decode time', () => {
    const s = [{ data: new Uint8Array(4), durationTicks: 1, ctsOffsetTicks: 0, sync: true }];
    expect(() => mediaSegment(1, -1, s)).toThrow(RangeError);
    expect(() => mediaSegment(1, 1.5, s)).toThrow(RangeError);
  });

  it('remuxes HEVC into an hvc1 init and two segments', () => {
    const us = mapped('disc-hdr', 48);
    const out: RemuxOutput[] = [];
    const r = new ElementRemux('hevc', (o) => out.push(o));
    for (const u of us) r.push(u);
    r.flush();
    expect(out[0].kind).toBe('init');
    expect((out[0] as Extract<RemuxOutput, { kind: 'init' }>).codec).toMatch(/^hvc1\./);
    expect(segments(out).length).toBe(2);
    expectAbut(out);
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

describe('ElementRemux init segments', () => {
  const inits = (out: RemuxOutput[]): Extract<RemuxOutput, { kind: 'init' }>[] =>
    out.filter((o) => o.kind === 'init') as Extract<RemuxOutput, { kind: 'init' }>[];
  const has = (bytes: Uint8Array, type: string): boolean => {
    for (let o = 0; o + 4 <= bytes.length; o++) if (String.fromCharCode(...bytes.subarray(o, o + 4)) === type) return true;
    return false;
  };

  it("carries disc-hdr's colour, mastering display, content light and aspect", () => {
    const out: RemuxOutput[] = [];
    const r = new ElementRemux('hevc', (o) => out.push(o));
    for (const u of mapped('disc-hdr', 24)) r.push(u);
    const [init] = inits(out);
    for (const type of ['colr', 'mdcv', 'clli', 'pasp']) expect(has(init.bytes, type), type).toBe(true);
    expect(init).toMatchObject({ width: 1920, height: 1080 });
  });

  it('reports the display size of a stream whose samples are 4:3', () => {
    // a Baseline SPS, 48x16, whose VUI gives a 4:3 sample aspect ratio
    const head = '01000010' + '00000000' + '00011110' + '1' + '1' + '011' + '010' + '0' + '011' + '1' + '1' + '1' + '0';
    const ar = '1' + '11111111' + (4).toString(2).padStart(16, '0') + (3).toString(2).padStart(16, '0');
    const bits = head + '1' + ar + '0' + '0' + '0' + '0' + '0' + '0' + '0' + '0' + '0' + '1';
    const sps = new Uint8Array(Math.ceil(bits.length / 8) + 1);
    sps[0] = 0x67;
    for (let i = 0; i < bits.length; i++) if (bits[i] === '1') sps[1 + (i >> 3)] |= 0x80 >> (i & 7);
    const [init] = inits(run([{ data: avcAu({ idr: true, spsNal: sps }), ptsUs: 0, inRange: true }]));
    expect(init).toMatchObject({ width: 64, height: 16 });
  });
});

describe('ElementRemux on open GOPs', () => {
  const run = (us: Unit[]): RemuxOutput[] => {
    const out: RemuxOutput[] = [];
    const r = new ElementRemux('avc', (o) => out.push(o));
    for (const u of us) r.push(u);
    r.flush();
    return out;
  };

  it("starts a segment at an open GOP's I picture (a recovery point, where the EP map points), not only at IDRs", () => {
    const all = mapped('disc2', 120);
    const keys = all.filter((u) => analyzeAvc(u.data).key);
    expect(keys.some((u) => !analyzeAvc(u.data).idr)).toBe(true); // disc2 has open GOPs
    const segs = segments(run(all));
    expect(segs).toHaveLength(keys.length);
    // in a continuous stream a GOP's leading pictures stay with it, and show just before its I picture
    segs.forEach((seg, i) => {
      expect(seg.startUs).toBeLessThanOrEqual(keys[i]!.ptsUs);
      if (i > 0) expect(seg.startUs).toBeGreaterThan(keys[i - 1]!.ptsUs);
    });
    expectAbut(run(all));
  });

  it("a session started at an open GOP drops that GOP's leading pictures, whose references it never gets", () => {
    const all = mapped('disc2', 120);
    const at = all.findIndex((u) => { const i = analyzeAvc(u.data); return i.key && !i.idr; });
    const from = all.slice(at);
    const leading = from.slice(1).findIndex((u) => u.ptsUs < from[0]!.ptsUs);
    expect(leading).toBeGreaterThanOrEqual(0); // the I picture has leading B pictures after it
    const first = segments(run(from))[0]!;
    expect(first.startUs).toBe(from[0]!.ptsUs);
    const nextKey = from.slice(1).findIndex((u) => analyzeAvc(u.data).key) + 1;
    const kept = from.slice(0, nextKey).filter((u) => u.ptsUs >= from[0]!.ptsUs).length;
    expect(parseSegment(first.bytes).durs).toHaveLength(kept);
  });
});

describe('elementCodec', () => {
  it("gives the init segment's codec string for a unit with an SPS, and null for none or one it can't read", () => {
    expect(elementCodec('avc', avcAu({ idr: true, spsNal: PROGRESSIVE_SPS }))).toMatch(/^avc1\.640029$/i);
    expect(elementCodec('avc', avcAu({ fill: 10 }))).toBeNull();
    expect(elementCodec('avc', avcAu({ idr: true }))).toBeNull(); // TEST_SPS is cut short
  });
});
