// SPDX-License-Identifier: LGPL-3.0-or-later
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { gunzipSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { CadenceDetector, COMB_CLEAN, LOOKAHEAD, MATCH_RATIO, type FrameMetrics, type PlannedPicture } from './cadence';
import { evenTimestamps, NTSC_FRAME_US, orderFlags, simMetrics, telecine } from './metric-sequences';
import { combShare, frameMetrics, meanDifference, type Plane } from './metrics-cpu';

const REF = fileURLToPath(new URL('../../../../fixtures/synthetic/deinterlace-ref/', import.meta.url));

interface RefEntry {
  readonly file: string;
  readonly width: number;
  readonly height: number;
  readonly frames: number;
}

function refFrames(name: 'video' | 'telecine' | 'telecineFilm'): Plane[] {
  const refs = JSON.parse(readFileSync(`${REF}refs.json`, 'utf8')) as Record<string, RefEntry>;
  const r = refs[name]!;
  const bytes = new Uint8Array(gunzipSync(readFileSync(REF + r.file)));
  const size = r.width * r.height;
  expect(bytes.length).toBe(r.frames * size);
  return Array.from({ length: r.frames }, (_, i) => ({
    width: r.width,
    height: r.height,
    stride: r.width,
    data: bytes.subarray(i * size, (i + 1) * size),
  }));
}

function metricsOf(frames: readonly Plane[], order: 'tff' | 'bff'): FrameMetrics[] {
  return frames.map((f, i) => frameMetrics(frames[i - 1] ?? null, f, frames[i + 1] ?? null, order));
}

/** The picture of `top`'s top field (even rows) and `bottom`'s bottom field. */
function woven(top: Plane, bottom: Plane): Plane {
  const data = new Uint8Array(top.width * top.height);
  for (let y = 0; y < top.height; y++) {
    const src = y % 2 === 0 ? top : bottom;
    data.set(src.data.subarray(y * src.stride, y * src.stride + src.width), y * top.width);
  }
  return { width: top.width, height: top.height, stride: top.width, data };
}

/** The plane without its first row: its bottom field becomes the top field, so a top-first stream turns bottom-first. */
function shiftedRow(p: Plane): Plane {
  return { width: p.width, height: p.height - 1, stride: p.stride, data: p.data.subarray(p.stride) };
}

const FIRST_SEQ = 1000;

function plan(metrics: readonly FrameMetrics[]): { pictures: PlannedPicture[]; detector: CadenceDetector } {
  const detector = new CadenceDetector({ frameDurationUs: NTSC_FRAME_US, lookahead: LOOKAHEAD });
  const ts = evenTimestamps(metrics.length);
  const pictures: PlannedPicture[] = [];
  metrics.forEach((m, i) => pictures.push(...detector.push(FIRST_SEQ + i, ts[i]!, orderFlags('tff'), m)));
  pictures.push(...detector.flush());
  return { pictures, detector };
}

describe('frameMetrics on hard 3:2 telecine (00002)', () => {
  const frames = refFrames('telecine');
  const film = refFrames('telecineFilm');
  const metrics = metricsOf(frames, 'tff');

  // Each frame's position in the 3:2 cycle: [A A] [B B] [B C] [C D] [D D], the first field named first. A pairing is
  // clean where it joins two fields of one film frame.
  const CLEAN: readonly (readonly ('weave' | 'prev' | 'next')[])[] = [['weave'], ['weave', 'next'], ['prev', 'next'], ['prev', 'next'], ['weave', 'prev']];

  it('gives the 3:2 pattern: clean pairings join one film frame, the others comb', () => {
    // Frame 0 has no previous frame and frame 10 no next, so frames 1-9 have all three pairings measured.
    for (let i = 1; i <= 9; i++) {
      const m = metrics[i]!;
      const values = { weave: m.combWoven, prev: m.combMatchPrev, next: m.combMatchNext };
      const clean = CLEAN[i % 5]!;
      const worst = Math.max(...Object.values(values));
      for (const [op, v] of Object.entries(values) as ['weave' | 'prev' | 'next', number][]) {
        if (clean.includes(op)) {
          expect(v, `frame ${i} ${op}`).toBeLessThanOrEqual(COMB_CLEAN);
          expect(v, `frame ${i} ${op}`).toBeLessThan(MATCH_RATIO * worst);
        } else {
          expect(v, `frame ${i} ${op}`).toBeGreaterThan(4 * COMB_CLEAN);
        }
      }
    }
  });

  it("feeds the detector to the same decisions as the simulated clean hard 3:2", () => {
    // Frames 5-9 are a whole cycle with both neighbours measured; repeated, they stand for a long stretch of film.
    const cycle = metrics.slice(5, 10);
    const real = plan(Array.from({ length: 60 }, (_, i) => cycle[i % 5]!));
    const simulated = plan(simMetrics(telecine(0, 48)));
    expect(real.pictures).toEqual(simulated.pictures);
    expect(real.detector.mode).toBe('film');
    expect(real.detector.locks).toBe(1);
    expect(real.detector.breaks).toBe(0);
  });

  it('pairs the fields of each film frame: the clean pictures are the source frames, in order', () => {
    // [A A] woven, [B B] woven, [B C] with the next frame's top (C), [D D] woven; [C D] with the previous bottom is C again.
    const pictures: { picture: Plane; filmFrame: number }[] = [];
    for (let i = 0; i < 10; i++) {
      const c = Math.floor(i / 5) * 4;
      const f = frames[i]!;
      switch (i % 5) {
        case 0:
          pictures.push({ picture: f, filmFrame: c });
          break;
        case 1:
          pictures.push({ picture: f, filmFrame: c + 1 });
          break;
        case 2:
          pictures.push({ picture: woven(frames[i + 1]!, f), filmFrame: c + 2 });
          break;
        case 3:
          pictures.push({ picture: woven(f, frames[i - 1]!), filmFrame: c + 2 });
          break;
        case 4:
          pictures.push({ picture: f, filmFrame: c + 3 });
          break;
      }
    }
    for (const { picture, filmFrame } of pictures) {
      const diffs = film.map((s) => meanDifference(picture, s));
      expect(diffs.indexOf(Math.min(...diffs))).toBe(filmFrame);
      expect(combShare(picture, 0, picture)).toBeLessThanOrEqual(COMB_CLEAN);
    }
  });

  it('measures the duplicate frame as closer to the one before it', () => {
    // Positions 2 [B C] and 4 [D D] repeat a field of the frame before (B, D): their difference from it is smaller.
    for (const i of [2, 4, 7, 9]) expect(metrics[i]!.diffPrev).toBeLessThan(Math.min(metrics[i - 1]!.diffPrev, metrics[i + 1]?.diffPrev ?? 1));
  });
});

describe('frameMetrics on field-rate video (00000)', () => {
  const frames = refFrames('video');

  it('combs under every pairing, and the motion points to top field first', () => {
    for (let i = 1; i < frames.length - 1; i++) {
      const m = frameMetrics(frames[i - 1]!, frames[i]!, frames[i + 1]!, 'tff');
      const lo = Math.min(m.combWoven, m.combMatchPrev, m.combMatchNext);
      const hi = Math.max(m.combWoven, m.combMatchPrev, m.combMatchNext);
      expect(lo).toBeGreaterThan(COMB_CLEAN);
      expect(lo).toBeGreaterThan(MATCH_RATIO * hi);
      expect(m.motionTff).toBeLessThan(0.8 * m.motionBff);
    }
  });

  it('points to bottom field first when the rows are shifted by one', () => {
    const shifted = frames.map(shiftedRow);
    for (let i = 1; i < shifted.length - 1; i++) {
      const m = frameMetrics(shifted[i - 1]!, shifted[i]!, shifted[i + 1]!, 'bff');
      expect(m.motionBff).toBeLessThan(0.8 * m.motionTff);
    }
  });

  it('pairs by parity against the stream order: bff swaps which field meets which neighbour', () => {
    const [prev, cur, next] = [frames[1]!, frames[2]!, frames[3]!];
    const tff = frameMetrics(prev, cur, next, 'tff');
    const bff = frameMetrics(prev, cur, next, 'bff');
    expect(tff.combMatchPrev).toBe(combShare(cur, 0, prev));
    expect(tff.combMatchNext).toBe(combShare(cur, 1, next));
    expect(bff.combMatchPrev).toBe(combShare(cur, 1, prev));
    expect(bff.combMatchNext).toBe(combShare(cur, 0, next));
    expect([bff.combWoven, bff.diffPrev, bff.motionTff, bff.motionBff]).toEqual([tff.combWoven, tff.diffPrev, tff.motionTff, tff.motionBff]);
  });
});

describe('frameMetrics without neighbours', () => {
  const [a, b] = refFrames('video');

  it('measures a missing pairing as the woven frame, and the first frame as unlike any before', () => {
    const m = frameMetrics(null, a!, null, 'tff');
    expect(m.combMatchPrev).toBe(m.combWoven);
    expect(m.combMatchNext).toBe(m.combWoven);
    expect(m.diffPrev).toBe(1);
    expect([m.motionTff, m.motionBff]).toEqual([0, 0]);
  });

  it('gives nothing for a still picture', () => {
    const still = woven(b!, b!);
    const flat: Plane = { width: 64, height: 32, stride: 64, data: new Uint8Array(64 * 32).fill(90) };
    expect(frameMetrics(still, still, still, 'tff').diffPrev).toBe(0);
    expect(frameMetrics(flat, flat, flat, 'tff')).toEqual({ combWoven: 0, combMatchPrev: 0, combMatchNext: 0, diffPrev: 0, motionTff: 0, motionBff: 0 });
  });
});
