// SPDX-License-Identifier: LGPL-3.0-or-later
// The cadence detector: our own design (not derived from any field-matching or decimation filter's code). Each
// frame's measurements say whether it weaves clean, whether one of its fields pairs clean with a neighbouring frame's
// field (3:2 film), or whether it combs whatever is paired (field-rate video). A run of consistent 3:2 cycles locks
// film: each cycle's duplicate frame is dropped and the four kept pictures are retimed to the film grid.

import type { FieldFlags } from './field-input';

/**
 * One frame's measurements (from the GPU, or the CPU reference). Comb values are the share of the frame's pixels
 * that comb under a pairing, 0 to 1; higher means more combing.
 */
export interface FrameMetrics {
  /** The frame as coded. */
  readonly combWoven: number;
  /** Its first field with the previous frame's second field. */
  readonly combMatchPrev: number;
  /** Its second field with the next frame's first field. */
  readonly combMatchNext: number;
  /** Mean absolute difference of this frame from the previous, 0 to 1 (for decimation). */
  readonly diffPrev: number;
  /** Field-order evidence: how inconsistent the motion is if the top field is first (lower is likelier) … */
  readonly motionTff: number;
  /** … and if the bottom field is first. */
  readonly motionBff: number;
}

/**
 * How a picture is made from its frame: woven as coded, its first field matched with the previous frame's second
 * (`prev`) or its second field with the next frame's first (`next`), or one field interpolated to a full picture.
 */
export type PictureOp =
  | { readonly kind: 'weave' }
  | { readonly kind: 'match'; readonly with: 'prev' | 'next' }
  | { readonly kind: 'interpolate'; readonly field: 'top' | 'bottom' };

/** One output picture: the frame it is made from (its ring sequence number), how, and when it shows. */
export interface PlannedPicture {
  readonly frame: number;
  readonly op: PictureOp;
  readonly timestampUs: number;
}

/** What the detector takes the content to be: progressive frames, 3:2 film, or field-rate video. */
export type CadenceMode = 'progressive' | 'film' | 'video';

/** Consistent 3:2 cycles seen before film locks. */
export const LOCK_CYCLES = 3;
/** Consecutive frames whose combing no match removes before film is left for video. */
export const UNLOCK_FRAMES = 4;
/** Frames the detector waits for after a frame before planning it. */
export const LOOKAHEAD = 5;
/** Consecutive frames that weave clean before video is taken for progressive. */
export const PROGRESSIVE_FRAMES = 4;
/** Frames after a broken lock that film waits for a new phase before it is left for video. */
export const SEARCH_FRAMES = 10;
/** A comb value at or below this is clean whatever the others are. */
export const COMB_CLEAN = 0.02;
/** A pairing explains the combing when its comb value is at most this share of the worst pairing's. */
export const MATCH_RATIO = 0.5;
/** A pairing is as good as the best when its comb value is at most this many times the best's. */
export const TIE_RATIO = 1.5;

/** One film frame at 23.976 frames a second, in microseconds. */
const FILM_FRAME_US = 1_001_000 / 24;
/** One frame at 29.97 frames a second, in microseconds. */
const NTSC_FRAME_US = 1_001_000 / 30;
const CYCLE = 5;
/** Position in a locked cycle of the frame that starts it (the first whole film frame after the pair). */
const CYCLE_START = 3;
/** Field-order votes that decide the order, and the most the score holds (hysteresis). */
const ORDER_VOTES = 4;
const ORDER_SCORE_MAX = 16;
/** How much lower one order's motion evidence must be to count as a vote. */
const ORDER_MARGIN = 0.1;
/** Frames either side of a frame in which pulldown evidence makes progressive frames soft-pulldown film. */
const PULLDOWN_WINDOW = 5;

type FrameClass = 'woven' | 'matched' | 'combed';
type BestOp = 'weave' | 'prev' | 'next';
type Segment =
  | { readonly kind: 'video' }
  | { readonly kind: 'progressive' }
  | { readonly kind: 'locked'; readonly phase: number }
  | { readonly kind: 'search' };

interface Frame {
  /** Frames pushed before this one since the last reset. */
  readonly index: number;
  readonly seq: number;
  readonly timestampUs: number;
  readonly flags: FieldFlags;
  readonly metrics: FrameMetrics;
  readonly cls: FrameClass;
  readonly best: BestOp;
  seg: Segment;
}

const VIDEO: Segment = { kind: 'video' };
const PROGRESSIVE: Segment = { kind: 'progressive' };
const SEARCH: Segment = { kind: 'search' };

function mod(a: number, n: number): number {
  return ((a % n) + n) % n;
}

function combOf(m: FrameMetrics, op: BestOp): number {
  return op === 'weave' ? m.combWoven : op === 'prev' ? m.combMatchPrev : m.combMatchNext;
}

/** The pairing's comb value is as good as the frame's best pairing. */
function usable(m: FrameMetrics, op: BestOp): boolean {
  const lo = Math.min(m.combWoven, m.combMatchPrev, m.combMatchNext);
  return combOf(m, op) <= Math.max(COMB_CLEAN, lo * TIE_RATIO);
}

function classify(m: FrameMetrics): { cls: FrameClass; best: BestOp } {
  const lo = Math.min(m.combWoven, m.combMatchPrev, m.combMatchNext);
  const hi = Math.max(m.combWoven, m.combMatchPrev, m.combMatchNext);
  const best: BestOp = usable(m, 'weave') ? 'weave' : usable(m, 'prev') ? 'prev' : 'next';
  if (!(lo <= COMB_CLEAN || lo <= MATCH_RATIO * hi)) return { cls: 'combed', best };
  return { cls: best === 'weave' ? 'woven' : 'matched', best };
}

/**
 * Turns per-frame field measurements into output pictures: two interpolated fields per frame for video, the 3:2
 * film reassembled to four pictures per five frames at an even 1001/24000 s, or one woven picture per frame for
 * progressive content (soft-pulldown film evened to the film grid). A frame is planned once `lookahead` later frames
 * have arrived, so a mode change can take effect from where the content changed.
 */
export class CadenceDetector {
  private readonly frameDurationUs: number;
  private readonly lookahead: number;
  /** Film is only ever taken for 29.97-frame sources; 50 Hz 2:2 content weaves as progressive. */
  private readonly filmRate: boolean;

  private pending: Frame[] = [];
  private count = 0;
  private state: Segment = VIDEO;
  /** The classes of the two frames before the latest (the nearer first). */
  private recentClasses: [FrameClass | null, FrameClass | null] = [null, null];
  private combedRun = 0;
  private wovenRun = 0;
  private candidate: { phase: number; pairs: number } | null = null;
  private lastConfirm = -1;
  private searchSince = 0;
  private lastPulldown = -Infinity;
  private prevTimestampUs: number | null = null;
  private softActive = false;
  private orderScore = 0;
  private detectedOrder: 'tff' | 'bff' | null = null;
  private lastStreamOrder: 'tff' | 'bff' | null = null;
  /** The pair frame dropped in place of the one before it (that one then matches forward). */
  private dropIndex = -1;
  private grid: { anchorUs: number; k: number } | null = null;
  private recentFields: number[] = [];
  private lastTimeUs = -Infinity;
  private lockCount = 0;
  private breakCount = 0;

  constructor(opts: { readonly frameDurationUs: number; readonly lookahead: number }) {
    this.frameDurationUs = opts.frameDurationUs;
    this.lookahead = Math.max(0, opts.lookahead);
    this.filmRate = Math.abs(opts.frameDurationUs - NTSC_FRAME_US) < 200;
  }

  /** What the content is taken to be, as of the latest frame. */
  get mode(): CadenceMode {
    switch (this.state.kind) {
      case 'video':
        return 'video';
      case 'progressive':
        return this.softActive ? 'film' : 'progressive';
      default:
        return 'film';
    }
  }

  /** Which field is first in time, as of the latest frame. */
  get fieldOrder(): 'tff' | 'bff' {
    return this.lastStreamOrder ?? this.detectedOrder ?? 'tff';
  }

  /** Where `fieldOrder` comes from: the latest frame's flags, measured motion, or the top-first default. */
  get fieldOrderSource(): 'stream' | 'detected' | 'assumed' {
    if (this.lastStreamOrder !== null) return 'stream';
    return this.detectedOrder !== null ? 'detected' : 'assumed';
  }

  /** Times film was taken up (a 3:2 lock, or soft pulldown). */
  get locks(): number {
    return this.lockCount;
  }

  /** Times a film lock was lost (its phase broke, or the content left film). */
  get breaks(): number {
    return this.breakCount;
  }

  /** Adds one decoded frame; answers the pictures now decided, in order. */
  push(seq: number, timestampUs: number, flags: FieldFlags, metrics: FrameMetrics): readonly PlannedPicture[] {
    const index = this.count++;
    const { cls, best } = classify(metrics);
    const frame: Frame = { index, seq, timestampUs, flags, metrics, cls, best, seg: this.state };
    this.noteOrder(flags, metrics);
    this.notePulldown(index, timestampUs, flags);
    this.pending.push(frame);
    this.update(frame);
    const out: PlannedPicture[] = [];
    while (this.pending.length > 0 && this.pending[0]!.index <= index - this.lookahead) {
      this.decide(this.pending.shift()!, out);
    }
    return out;
  }

  /** End of stream: decides the frames still waiting for lookahead. */
  flush(): readonly PlannedPicture[] {
    const out: PlannedPicture[] = [];
    while (this.pending.length > 0) this.decide(this.pending.shift()!, out);
    return out;
  }

  /** Forgets the frames and the cadence (a seek or a new play item); the lock and break counts stay. */
  reset(): void {
    this.pending = [];
    this.count = 0;
    this.state = VIDEO;
    this.recentClasses = [null, null];
    this.combedRun = 0;
    this.wovenRun = 0;
    this.candidate = null;
    this.lastConfirm = -1;
    this.searchSince = 0;
    this.lastPulldown = -Infinity;
    this.prevTimestampUs = null;
    this.softActive = false;
    this.orderScore = 0;
    this.detectedOrder = null;
    this.lastStreamOrder = null;
    this.dropIndex = -1;
    this.grid = null;
    this.recentFields = [];
    this.lastTimeUs = -Infinity;
  }

  private noteOrder(flags: FieldFlags, m: FrameMetrics): void {
    this.lastStreamOrder = flags.fieldOrder;
    if (flags.fieldOrder !== null) return;
    const hi = Math.max(m.motionTff, m.motionBff);
    if (hi <= 0 || Math.abs(m.motionTff - m.motionBff) <= ORDER_MARGIN * hi) return;
    const vote = m.motionTff < m.motionBff ? 1 : -1;
    this.orderScore = Math.max(-ORDER_SCORE_MAX, Math.min(ORDER_SCORE_MAX, this.orderScore + vote));
    if (this.orderScore >= ORDER_VOTES) this.detectedOrder = 'tff';
    else if (this.orderScore <= -ORDER_VOTES) this.detectedOrder = 'bff';
  }

  private notePulldown(index: number, timestampUs: number, flags: FieldFlags): void {
    const fd = this.frameDurationUs;
    const prev = this.prevTimestampUs;
    this.prevTimestampUs = timestampUs;
    const uneven = prev !== null && Math.abs(timestampUs - prev - 1.5 * fd) < fd / 4;
    if (flags.repeatFirstField || uneven) this.lastPulldown = index;
  }

  /** Moves the frames still waiting, from `from` on, to `seg`. */
  private apply(seg: Segment, from: number): void {
    for (const f of this.pending) if (f.index >= from) f.seg = seg;
  }

  private earliestPending(): number {
    return this.pending[0]!.index;
  }

  /** The state machine, run on each frame as it arrives. */
  private update(f: Frame): void {
    const i = f.index;
    const [c1, c2] = this.recentClasses;
    this.recentClasses = [f.cls, c1];
    const pairStart = f.cls === 'matched' && c1 === 'matched' && c2 !== 'matched' ? i - 1 : null;
    this.combedRun = f.cls === 'combed' ? this.combedRun + 1 : 0;
    this.wovenRun = f.cls === 'woven' ? this.wovenRun + 1 : 0;

    switch (this.state.kind) {
      case 'video':
      case 'progressive':
        this.trackCandidate(f, c1, pairStart);
        if (this.candidate !== null && this.candidate.pairs >= LOCK_CYCLES) {
          this.lock(this.candidate.phase, i);
        } else if (this.state.kind === 'video' && this.wovenRun >= PROGRESSIVE_FRAMES) {
          this.state = PROGRESSIVE;
          this.apply(PROGRESSIVE, i - PROGRESSIVE_FRAMES + 1);
        } else if (this.state.kind === 'progressive' && f.cls !== 'woven') {
          this.state = VIDEO;
          this.apply(VIDEO, i);
        }
        break;
      case 'locked': {
        if (this.combedRun >= UNLOCK_FRAMES) {
          this.leaveFilm(i);
          break;
        }
        const pos = mod(i - this.state.phase, CYCLE);
        if (f.cls === 'matched' && pos !== 0 && pos !== 1) {
          this.breakCount++;
          this.state = SEARCH;
          this.searchSince = i;
          this.apply(SEARCH, this.lastConfirm + 1);
          if (pairStart !== null) this.lock(mod(pairStart, CYCLE), i);
        } else if (pairStart !== null && mod(pairStart - this.state.phase, CYCLE) === 0) {
          this.lastConfirm = i;
        }
        break;
      }
      case 'search':
        if (this.combedRun >= UNLOCK_FRAMES) this.leaveFilm(i);
        else if (pairStart !== null) this.lock(mod(pairStart, CYCLE), i);
        else if (i - this.searchSince >= SEARCH_FRAMES) {
          this.state = VIDEO;
          this.apply(VIDEO, i);
        }
        break;
    }
    this.updateSoft(i);
  }

  private trackCandidate(f: Frame, c1: FrameClass | null, pairStart: number | null): void {
    if (!this.filmRate) return;
    if (f.cls === 'combed') {
      this.candidate = null;
      return;
    }
    if (f.cls !== 'matched') return;
    const cand = this.candidate;
    if (cand !== null) {
      const pos = mod(f.index - cand.phase, CYCLE);
      if (pos !== 0 && pos !== 1) this.candidate = null;
    }
    if (c1 === 'matched' && pairStart === null) this.candidate = null; // three matched in a row is no 3:2
    if (pairStart === null) return;
    const phase = mod(pairStart, CYCLE);
    if (this.candidate !== null && this.candidate.phase === phase) this.candidate.pairs++;
    else this.candidate = { phase, pairs: 1 };
  }

  /**
   * Locks film at `phase` from the earliest waiting frame that starts a cycle. After a break one pair at a new phase
   * is enough: the content is still film.
   */
  private lock(phase: number, i: number): void {
    const seg: Segment = { kind: 'locked', phase };
    this.lockCount++;
    this.candidate = null;
    this.lastConfirm = i;
    this.state = seg;
    let from = this.earliestPending();
    while (mod(from - phase, CYCLE) !== CYCLE_START) from++;
    this.apply(seg, from);
  }

  private leaveFilm(i: number): void {
    this.breakCount++;
    this.candidate = null;
    this.state = VIDEO;
    this.apply(VIDEO, Math.max(this.earliestPending(), i - UNLOCK_FRAMES + 1));
  }

  private updateSoft(i: number): void {
    const soft = this.state.kind === 'progressive' && this.isSoft(i);
    if (soft && !this.softActive) this.lockCount++;
    if (!soft && this.softActive && this.state.kind !== 'locked' && this.state.kind !== 'search') this.breakCount++;
    this.softActive = soft;
  }

  private isSoft(index: number): boolean {
    return this.filmRate && Math.abs(index - this.lastPulldown) <= PULLDOWN_WINDOW;
  }

  private orderOf(f: Frame): 'tff' | 'bff' {
    return f.flags.fieldOrder ?? this.detectedOrder ?? 'tff';
  }

  private emit(out: PlannedPicture[], f: Frame, op: PictureOp, timestampUs: number): void {
    const t = timestampUs > this.lastTimeUs ? timestampUs : this.lastTimeUs + 1;
    this.lastTimeUs = t;
    out.push({ frame: f.seq, op, timestampUs: t });
  }

  /** The field ids (index × 2, plus 1 for the second field) a picture shows. */
  private fieldsOf(f: Frame, op: BestOp | 'first'): number[] {
    const i = f.index;
    if (op === 'weave') return [2 * i, 2 * i + 1];
    if (op === 'prev') return [2 * i, 2 * i - 1];
    if (op === 'next') return [2 * i + 1, 2 * i + 2];
    return [2 * i];
  }

  /** Film pictures never show a field a recent picture showed: such a picture repeats one already shown. */
  private repeats(fields: readonly number[]): boolean {
    return fields.some((id) => this.recentFields.includes(id));
  }

  private remember(fields: readonly number[]): void {
    this.recentFields.push(...fields);
    if (this.recentFields.length > 8) this.recentFields.splice(0, this.recentFields.length - 8);
  }

  /** The next time on the film grid for a kept frame, re-anchored at the frame when the grid has drifted. */
  private gridTime(timestampUs: number, anchor: boolean): number {
    const g = this.grid;
    if (anchor || g === null) {
      this.grid = { anchorUs: timestampUs, k: 0 };
      return timestampUs;
    }
    g.k++;
    const t = g.anchorUs + g.k * FILM_FRAME_US;
    if (Math.abs(t - timestampUs) > FILM_FRAME_US / 2) {
      this.grid = { anchorUs: timestampUs, k: 0 };
      return timestampUs;
    }
    return t;
  }

  private decide(f: Frame, out: PlannedPicture[]): void {
    switch (f.seg.kind) {
      case 'video': {
        this.grid = null;
        const first = this.orderOf(f) === 'tff' ? 'top' : 'bottom';
        const second = first === 'top' ? 'bottom' : 'top';
        this.emit(out, f, { kind: 'interpolate', field: first }, f.timestampUs);
        this.emit(out, f, { kind: 'interpolate', field: second }, f.timestampUs + this.frameDurationUs / 2);
        this.remember([2 * f.index, 2 * f.index + 1]);
        return;
      }
      case 'progressive': {
        const soft = this.isSoft(f.index);
        if (!soft) this.grid = null;
        const t = soft ? this.gridTime(f.timestampUs, false) : f.timestampUs;
        this.emit(out, f, { kind: 'weave' }, t);
        this.remember(this.fieldsOf(f, 'weave'));
        return;
      }
      case 'locked':
        this.decideFilm(out, f, this.lockedOp(f, f.seg.phase), mod(f.index - f.seg.phase, CYCLE) === CYCLE_START);
        return;
      case 'search':
        this.decideFilm(out, f, f.cls === 'combed' ? 'first' : f.best, false);
        return;
    }
  }

  /** Plans a film frame: `op` null drops it, `first` interpolates its first field (combing no match removes). */
  private decideFilm(out: PlannedPicture[], f: Frame, op: BestOp | 'first' | null, cycleStart: boolean): void {
    if (op === null) return;
    const fields = this.fieldsOf(f, op);
    if (this.repeats(fields)) return;
    this.remember(fields);
    const pictureOp: PictureOp =
      op === 'weave'
        ? { kind: 'weave' }
        : op === 'first'
          ? { kind: 'interpolate', field: this.orderOf(f) === 'tff' ? 'top' : 'bottom' }
          : { kind: 'match', with: op };
    this.emit(out, f, pictureOp, this.gridTime(f.timestampUs, cycleStart && op === 'weave'));
  }

  /**
   * The cycle's plan for a locked frame: the pair's duplicate (the one of the two closer to the frame before it)
   * dropped and the other matched to its whole film frame, the rest woven; a pairing that combs gives way to the
   * frame's best, and a frame that combs whatever is paired shows its first field interpolated.
   */
  private lockedOp(f: Frame, phase: number): BestOp | 'first' | null {
    const pos = mod(f.index - phase, CYCLE);
    let op: BestOp | null;
    if (pos === 0) {
      const second = this.pending.find((p) => p.index === f.index + 1);
      if (second !== undefined && second.metrics.diffPrev < f.metrics.diffPrev) {
        this.dropIndex = second.index;
        op = 'next';
      } else op = null;
    } else if (pos === 1) {
      op = this.dropIndex === f.index ? null : 'prev';
    } else op = 'weave';
    if (op === null) return null;
    if (f.cls === 'combed') return 'first';
    return usable(f.metrics, op) ? op : f.best;
  }
}
