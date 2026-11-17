// SPDX-License-Identifier: LGPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import { CadenceDetector, LOCK_CYCLES, LOOKAHEAD, UNLOCK_FRAMES, type CadenceMode, type FrameMetrics, type PlannedPicture } from './cadence';
import type { FieldFlags } from './field-input';
import {
  FILM_FRAME_US,
  SIM_COMB_CLEAN,
  SIM_COMB_HIGH,
  NTSC_FRAME_US,
  completeFilmFrames,
  evenTimestamps,
  filmNumber,
  orderFlags,
  pictureFields,
  progressiveFrames,
  simMetrics,
  softPulldownTimestamps,
  telecine,
  videoFrames,
  type SimFrame,
  type SimOptions,
} from './metric-sequences';

const FIRST_SEQ = 1000;

interface Run {
  readonly detector: CadenceDetector;
  readonly pictures: PlannedPicture[];
  /** The mode after each push. */
  readonly modes: CadenceMode[];
  /** `locks` after each push. */
  readonly locks: number[];
}

interface RunOptions extends SimOptions {
  readonly frameUs?: number;
  readonly timestamps?: readonly number[];
  readonly flags?: (i: number) => FieldFlags;
  readonly detector?: CadenceDetector;
  readonly firstSeq?: number;
  readonly flush?: boolean;
  /** Changes the simulated metrics before they are pushed. */
  readonly tweak?: (metrics: FrameMetrics[]) => void;
}

function run(frames: readonly SimFrame[], opts: RunOptions = {}): Run {
  const frameUs = opts.frameUs ?? NTSC_FRAME_US;
  const detector = opts.detector ?? new CadenceDetector({ frameDurationUs: frameUs, lookahead: LOOKAHEAD });
  const metrics = simMetrics(frames, opts);
  opts.tweak?.(metrics);
  const ts = opts.timestamps ?? evenTimestamps(frames.length, frameUs);
  const firstSeq = opts.firstSeq ?? FIRST_SEQ;
  const pictures: PlannedPicture[] = [];
  const modes: CadenceMode[] = [];
  const locks: number[] = [];
  frames.forEach((_, i) => {
    pictures.push(...detector.push(firstSeq + i, ts[i]!, opts.flags?.(i) ?? orderFlags('tff'), metrics[i]!));
    modes.push(detector.mode);
    locks.push(detector.locks);
  });
  if (opts.flush ?? true) pictures.push(...detector.flush());
  return { detector, pictures, modes, locks };
}

/** Pictures per frame index, from frame `from` on. */
function countsPerFrame(pictures: readonly PlannedPicture[], frameCount: number): number[] {
  const counts = new Array<number>(frameCount).fill(0);
  for (const p of pictures) counts[p.frame - FIRST_SEQ]! += 1;
  return counts;
}

function expectFilmSpacing(pictures: readonly PlannedPicture[]): void {
  for (let i = 1; i < pictures.length; i++) {
    expect(Math.abs(pictures[i]!.timestampUs - pictures[i - 1]!.timestampUs - FILM_FRAME_US)).toBeLessThanOrEqual(1);
  }
}

/** The film frames the pictures show, each picture's fields all from one film frame. */
function filmFramesShown(pictures: readonly PlannedPicture[], frames: readonly SimFrame[]): number[] {
  return pictures.map((p) => {
    const labels = new Set(pictureFields(p, frames, FIRST_SEQ));
    expect(labels.size).toBe(1);
    const n = filmNumber([...labels][0]!);
    expect(n).not.toBeNull();
    return n!;
  });
}

function expectIncreasingTimes(pictures: readonly PlannedPicture[]): void {
  for (let i = 1; i < pictures.length; i++) {
    expect(pictures[i]!.timestampUs).toBeGreaterThan(pictures[i - 1]!.timestampUs);
  }
}

describe('CadenceDetector', () => {
  it('starts on an assumed top field first', () => {
    const d = new CadenceDetector({ frameDurationUs: NTSC_FRAME_US, lookahead: LOOKAHEAD });
    expect(d.fieldOrder).toBe('tff');
    expect(d.fieldOrderSource).toBe('assumed');
    expect(d.mode).toBe('video');
  });

  it('clean video', () => {
    const frames = videoFrames(0, 30);
    const ts = evenTimestamps(frames.length);
    const { detector, pictures } = run(frames, { timestamps: ts });
    expect(pictures).toHaveLength(60);
    frames.forEach((_, k) => {
      expect(pictures[2 * k]).toEqual({ frame: FIRST_SEQ + k, op: { kind: 'interpolate', field: 'top' }, timestampUs: ts[k] });
      expect(pictures[2 * k + 1]).toEqual({
        frame: FIRST_SEQ + k,
        op: { kind: 'interpolate', field: 'bottom' },
        timestampUs: ts[k]! + NTSC_FRAME_US / 2,
      });
    });
    expect(detector.mode).toBe('video');
    expect(detector.locks).toBe(0);
  });

  it('holds pictures back by the lookahead and plans them in order', () => {
    const frames = videoFrames(0, 12);
    const d = new CadenceDetector({ frameDurationUs: NTSC_FRAME_US, lookahead: LOOKAHEAD });
    const metrics = simMetrics(frames);
    const ts = evenTimestamps(frames.length);
    for (let i = 0; i < LOOKAHEAD; i++) expect(d.push(FIRST_SEQ + i, ts[i]!, orderFlags('tff'), metrics[i]!)).toEqual([]);
    const next = d.push(FIRST_SEQ + LOOKAHEAD, ts[LOOKAHEAD]!, orderFlags('tff'), metrics[LOOKAHEAD]!);
    expect(next.map((p) => p.frame)).toEqual([FIRST_SEQ, FIRST_SEQ]);
  });

  it('clean hard 3:2', () => {
    const frames = telecine(0, 48); // 60 frames, 12 cycles
    const { detector, pictures } = run(frames);
    const lockedFrom = LOCK_CYCLES * 5;
    const counts = countsPerFrame(pictures, frames.length);
    for (let c = lockedFrom; c + 5 <= frames.length; c += 5) {
      expect(counts.slice(c, c + 5).reduce((a, b) => a + b, 0)).toBe(4);
    }
    const film = pictures.filter((p) => p.frame - FIRST_SEQ >= lockedFrom);
    for (const p of film) expect(['weave', 'match']).toContain(p.op.kind);
    const shown = filmFramesShown(film, frames);
    shown.forEach((n, i) => i > 0 && expect(n).toBe(shown[i - 1]! + 1));
    expect(shown.at(-1)).toBe(47);
    expectFilmSpacing(film);
    expect(detector.mode).toBe('film');
    expect(detector.locks).toBe(1);
    expect(detector.breaks).toBe(0);
  });

  it('soft pulldown', () => {
    const count = 24;
    const ts = softPulldownTimestamps(count, 900_000);
    const flagSets: ((i: number) => FieldFlags)[] = [
      (i) => ({ fieldOrder: 'tff', progressive: false, repeatFirstField: i % 2 === 0 }),
      () => ({ fieldOrder: null, progressive: true, repeatFirstField: false }),
    ];
    for (const flags of flagSets) {
      const { detector, pictures } = run(progressiveFrames(0, count), { timestamps: ts, flags });
      expect(pictures).toHaveLength(count);
      pictures.forEach((p, k) => {
        expect(p.frame).toBe(FIRST_SEQ + k);
        expect(p.op).toEqual({ kind: 'weave' });
        expect(Math.abs(p.timestampUs - (ts[0]! + k * FILM_FRAME_US))).toBeLessThanOrEqual(1);
      });
      expect(detector.mode).toBe('film');
    }
  });

  it('progressive', () => {
    const frames = progressiveFrames(0, 20);
    const ts = evenTimestamps(frames.length, NTSC_FRAME_US, 5_000);
    const { detector, pictures } = run(frames, { timestamps: ts });
    expect(pictures).toEqual(frames.map((_, k) => ({ frame: FIRST_SEQ + k, op: { kind: 'weave' }, timestampUs: ts[k] })));
    expect(detector.mode).toBe('progressive');
  });

  function expectRelock(into: number, skip: number): void {
    const before = telecine(0, 24).slice(0, 4 * 5 + into); // four cycles, then `into` frames into the fifth
    const after = telecine(100, 40, skip); // 3:2 again, `skip` fields into its pattern
    const frames = [...before, ...after];
    const cut = before.length;
    const { detector, pictures, modes, locks } = run(frames);
    const lockedFrom = LOCK_CYCLES * 5;
    const film = pictures.filter((p) => p.frame - FIRST_SEQ >= lockedFrom);
    for (const p of film) expect(['weave', 'match']).toContain(p.op.kind);
    const shown = filmFramesShown(film, frames);
    // No picture repeats or skips: exactly the whole film frames from the first one shown, in order.
    expect(shown).toEqual(completeFilmFrames(frames).filter((n) => n >= shown[0]!));
    expect(modes.slice(lockedFrom + LOOKAHEAD).every((m) => m === 'film')).toBe(true);
    const counts = countsPerFrame(pictures, frames.length);
    for (let c = cut + 2 * 5; c + 5 <= frames.length; c += 5) {
      expect(counts.slice(c, c + 5).reduce((a, b) => a + b, 0)).toBe(4);
    }
    expectIncreasingTimes(pictures);
    expectFilmSpacing(film.filter((p) => p.frame - FIRST_SEQ >= cut + 2 * 5));
    if (detector.breaks > 0) {
      expect(detector.breaks).toBe(1);
      const relocked = locks.findIndex((n) => n === 2);
      expect(relocked).toBeGreaterThanOrEqual(cut);
      expect(relocked).toBeLessThan(cut + 2 * 5);
    }
  }

  it('re-locks after a cut mid-cycle', () => {
    expectRelock(2, 3);
    const { detector } = run([...telecine(0, 24).slice(0, 22), ...telecine(100, 40, 3)]);
    expect(detector.breaks).toBe(1);
    expect(detector.locks).toBe(2);
  });

  it('re-locks after a cut at any point of the cycle into any phase', () => {
    for (let into = 0; into < 5; into++) {
      for (let skip = 0; skip < 10; skip++) expectRelock(into, skip);
    }
  });

  it('film with combed overlay stays matched', () => {
    const frames = telecine(0, 48);
    const { detector, pictures, modes } = run(frames, { overlay: 0.06 });
    const lockedFrom = LOCK_CYCLES * 5;
    const film = pictures.filter((p) => p.frame - FIRST_SEQ >= lockedFrom);
    for (const p of film) expect(['weave', 'match']).toContain(p.op.kind);
    const shown = filmFramesShown(film, frames);
    shown.forEach((n, i) => i > 0 && expect(n).toBe(shown[i - 1]! + 1));
    expect(modes.slice(lockedFrom + LOOKAHEAD).every((m) => m === 'film')).toBe(true);
    expect(detector.breaks).toBe(0);
  });

  it('keeps the lock through a still scene', () => {
    const frames = telecine(0, 48);
    const still = (m: FrameMetrics): FrameMetrics => ({
      ...m,
      combWoven: SIM_COMB_CLEAN,
      combMatchPrev: SIM_COMB_CLEAN,
      combMatchNext: SIM_COMB_CLEAN,
      diffPrev: 0,
    });
    const { detector, pictures, modes } = run(frames, {
      tweak: (ms) => ms.forEach((m, i) => i >= 25 && i < 40 && (ms[i] = still(m))),
    });
    expect(modes.slice(LOCK_CYCLES * 5 + LOOKAHEAD).every((m) => m === 'film')).toBe(true);
    expect(detector.breaks).toBe(0);
    const counts = countsPerFrame(pictures, frames.length);
    for (let c = LOCK_CYCLES * 5; c + 5 <= frames.length; c += 5) {
      expect(counts.slice(c, c + 5).reduce((a, b) => a + b, 0)).toBe(4);
    }
    expectFilmSpacing(pictures.filter((p) => p.frame - FIRST_SEQ >= LOCK_CYCLES * 5));
  });

  it('shows a lone frame that combs under every pairing in film as one interpolated field', () => {
    const frames = telecine(0, 48);
    const glitch = 30; // a frame the cycle keeps woven
    const { detector, pictures } = run(frames, {
      tweak: (ms) => {
        ms[glitch] = { ...ms[glitch]!, combWoven: SIM_COMB_HIGH, combMatchPrev: SIM_COMB_HIGH, combMatchNext: SIM_COMB_HIGH };
      },
    });
    expect(pictures.filter((p) => p.frame === FIRST_SEQ + glitch)).toEqual([
      expect.objectContaining({ op: { kind: 'interpolate', field: 'top' } }),
    ]);
    expect(detector.mode).toBe('film');
    expect(detector.breaks).toBe(0);
  });

  it('drops the pair frame closer to the frame before it', () => {
    const frames = telecine(0, 48);
    // Make the second frame of each pair the one closer to its predecessor: the first then matches forward.
    const { pictures } = run(frames, {
      tweak: (ms) => ms.forEach((m, i) => i % 5 === 3 && (ms[i] = { ...m, diffPrev: 0 })),
    });
    const late = pictures.filter((p) => p.frame - FIRST_SEQ >= LOCK_CYCLES * 5);
    expect(late.filter((p) => (p.frame - FIRST_SEQ) % 5 === 3)).toEqual([]);
    for (const p of late.filter((q) => (q.frame - FIRST_SEQ) % 5 === 2)) {
      expect(p.op).toEqual({ kind: 'match', with: 'next' });
    }
    const shown = filmFramesShown(late, frames);
    shown.forEach((n, i) => i > 0 && expect(n).toBe(shown[i - 1]! + 1));
  });

  it('leaves film when video starts', () => {
    const film = telecine(0, 32).slice(0, 37); // locked, then cut mid-cycle
    const video = videoFrames(0, 20);
    const frames = [...film, ...video];
    const { pictures, modes } = run(frames);
    expect(modes[film.length + UNLOCK_FRAMES - 1]).toBe('video');
    // Every video field is shown, first then second, half a frame apart.
    const videoPictures = pictures.filter((p) => p.frame - FIRST_SEQ >= film.length);
    expect(videoPictures).toHaveLength(2 * video.length);
    videoPictures.forEach((p, i) => {
      expect(pictureFields(p, frames, FIRST_SEQ)).toEqual([`v${i}`]);
    });
    // Every whole film frame after the lock is shown once.
    const filmPictures = pictures.filter((p) => {
      const i = p.frame - FIRST_SEQ;
      return i >= LOCK_CYCLES * 5 && i < film.length;
    });
    const shown = filmFramesShown(filmPictures, frames);
    expect(shown).toEqual(completeFilmFrames(film).filter((n) => n >= shown[0]!));
    expectIncreasingTimes(pictures);
  });

  it('detects bottom field first', () => {
    const frames = videoFrames(0, 20);
    const { detector, pictures } = run(frames, { order: 'bff', flags: () => orderFlags(null) });
    expect(detector.fieldOrder).toBe('bff');
    expect(detector.fieldOrderSource).toBe('detected');
    frames.forEach((_, k) => {
      expect(pictures[2 * k]!.op).toEqual({ kind: 'interpolate', field: 'bottom' });
      expect(pictures[2 * k + 1]!.op).toEqual({ kind: 'interpolate', field: 'top' });
    });
  });

  it('stream field order wins', () => {
    const frames = videoFrames(0, 20);
    const { detector, pictures } = run(frames, { order: 'bff', flags: () => orderFlags('tff') });
    expect(detector.fieldOrder).toBe('tff');
    expect(detector.fieldOrderSource).toBe('stream');
    expect(pictures[0]!.op).toEqual({ kind: 'interpolate', field: 'top' });
  });

  it('follows a field order that changes frame by frame', () => {
    const frames = videoFrames(0, 10);
    const { pictures } = run(frames, { flags: (i) => orderFlags(i % 5 === 4 ? 'bff' : 'tff') });
    expect(pictures[2 * 4]!.op).toEqual({ kind: 'interpolate', field: 'bottom' });
    expect(pictures[2 * 5]!.op).toEqual({ kind: 'interpolate', field: 'top' });
  });

  it('reset clears the cadence', () => {
    const d = new CadenceDetector({ frameDurationUs: NTSC_FRAME_US, lookahead: LOOKAHEAD });
    const first = run(telecine(0, 32), { detector: d, flush: false });
    expect(first.detector.mode).toBe('film');
    d.reset();
    expect(d.mode).toBe('video');
    const frames = telecine(200, 32);
    const second = run(frames, { detector: d, firstSeq: FIRST_SEQ });
    const early = second.pictures.filter((p) => p.frame - FIRST_SEQ < 2 * 5);
    expect(early.length).toBe(2 * 2 * 5);
    for (const p of early) expect(p.op.kind).toBe('interpolate');
    expect(d.mode).toBe('film');
    expect(d.locks).toBe(2);
  });

  it('never takes a 25 frame source for film', () => {
    const frames = telecine(0, 48);
    const { detector, pictures } = run(frames, { frameUs: 40_000 });
    expect(detector.mode).toBe('video');
    expect(detector.locks).toBe(0);
    expect(pictures).toHaveLength(2 * frames.length);
  });
});
