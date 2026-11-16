// SPDX-License-Identifier: LGPL-3.0-or-later
import type { EngineEvent } from '../protocol';
import { ElementRemux, type RemuxOutput } from './remux';
import type { ElementPictureSize } from '../render/compositor';

/** How long the page has to say whether its video element plays a codec before the session takes the canvas path. */
export const ELEMENT_QUERY_TIMEOUT_MS = 2000;
/** After an element stall (and at the end of reading), playback resumes once the element holds this much video ahead of the clock. */
export const ELEMENT_RESUME_LEAD_US = 500_000;
/** At the end of reading, a buffered end this close to the last segment's end (about a frame) counts as all of it. */
export const ELEMENT_END_SLACK_US = 42_000;

/** The buffer to transfer with `bytes` when the view covers all of it (the remuxer's output does), else none. */
function transferOf(bytes: Uint8Array): Transferable[] | undefined {
  const buffer = bytes.buffer;
  return buffer instanceof ArrayBuffer && bytes.byteOffset === 0 && bytes.byteLength === buffer.byteLength ? [buffer] : undefined;
}

/**
 * What an element session needs from the player.
 * @internal
 */
export interface ElementSessionDeps {
  /** Sends an event to the page, transferring `transfer`. */
  emit(event: EngineEvent, transfer?: Transferable[]): void;
  /** The next reset generation: it grows with every reset, across sessions. */
  nextGeneration(): number;
  /** Whether this session is still the player's current one: output after teardown goes nowhere. */
  isCurrent(): boolean;
  /** An init segment went out with the stream's display and coded sizes; `first` for the session's first, which turns the compositor transparent. */
  shown(size: ElementPictureSize, first: boolean): void;
}

/**
 * One playlist session's video on the element path: the remuxer whose output goes to the page's video element, the
 * generation of the element's last reset, and what the element has reported since (buffered end, stall).
 * @internal
 */
export class ElementSession {
  /** The remuxer turning the playlist's video units into fragmented MP4 for the page. */
  readonly remux: ElementRemux;
  /** The end of what the element has buffered (videoBuffered), in playlist time; -Infinity after a reset. */
  bufferedEndUs = -Infinity;
  /** The element ran dry while playing (videoStalled): the start-up waits for ELEMENT_RESUME_LEAD_US. */
  stalled = false;
  /** A videoBuffered of the current generation came since the last videoStalled (a stall resumes only on a fresh report). */
  freshBuffered = false;
  /** The generation of the session's last videoReset: reports the page made before it are ignored. */
  generation = 0;
  /** The generation of the session's first videoReset: a failure the page reports from before it is another session's. */
  firstGeneration = 0;
  /** The media segments sent to the page since the last reset (videoBuffered echoes those appended). */
  segmentsSent = 0;
  /** The compositor has gone transparent at the stream's size (the session's first init). */
  private shownOnce = false;

  constructor(
    coding: 'avc' | 'hevc',
    private readonly deps: ElementSessionDeps,
  ) {
    this.remux = new ElementRemux(coding, (out) => this.onRemuxOutput(out));
  }

  /** The end of the last segment sent to the page, in playlist time; `-Infinity` before the first. */
  get endUs(): number {
    return this.remux.endUs;
  }

  /** The session's first reset: the element starts at `startUs`, and failures reported from before it are another session's. */
  begin(startUs: number, paused: boolean): void {
    this.resetElement(startUs, paused);
    this.firstGeneration = this.generation;
  }

  /** Takes one video unit for the remuxer. */
  push(unit: { data: Uint8Array; ptsUs: number; dtsUs?: number; inRange: boolean }): void {
    this.remux.push(unit);
  }

  /** The element drops what it holds and starts again at `startUs` (a seek); a pending stall goes with it. */
  reset(startUs: number, paused: boolean): void {
    this.remux.reset();
    this.resetElement(startUs, paused);
  }

  /** The end of input: the segment being collected goes out. */
  flush(): void {
    this.remux.flush();
  }

  /**
   * Whether the session can start, or resume after a stall, at `nowUs`: the element holds video past the clock (after a
   * stall, ELEMENT_RESUME_LEAD_US of it, reported since the stall). Once reading is done (`eof`) the segments may still
   * be on their way to the page, so it also waits there: until the element holds the last segment's end, or that lead.
   */
  elementReady(nowUs: number, eof: boolean): boolean {
    if (this.stalled && !this.freshBuffered) return false;
    const buffered = this.bufferedEndUs;
    if (buffered >= nowUs + ELEMENT_RESUME_LEAD_US) return true;
    if (eof && buffered >= this.endUs - ELEMENT_END_SLACK_US) return true;
    return !this.stalled && !eof && buffered > nowUs;
  }

  /**
   * Whether reading waits: the lead the element holds over the clock (what it reported buffered) or what was sent but
   * not reported yet (the page's media source may still be opening, or its appends behind) reaches `leadUs`.
   */
  readerBlocked(nowUs: number, leadUs: number): boolean {
    return this.bufferedEndUs - nowUs >= leadUs || this.endUs - Math.max(nowUs, this.bufferedEndUs) >= leadUs;
  }

  /**
   * The element's videoBuffered report: `endUs` buffered, `segments` appended since the reset. Answers `stale` for a
   * report from before the latest reset (it describes what the element has since dropped), `evicted` when the element
   * dropped video at the playhead that was sent (reading must start again at the clock), else `ok`.
   */
  buffered(generation: number, endUs: number, segments: number, nowUs: number): 'stale' | 'evicted' | 'ok' {
    if (generation !== this.generation) return 'stale';
    this.bufferedEndUs = endUs;
    this.freshBuffered = true;
    return this.elementEvicted(segments, nowUs) ? 'evicted' : 'ok';
  }

  /** The element's videoStalled report: false for a report from before the latest reset, else the stall is noted. */
  stall(generation: number): boolean {
    if (generation !== this.generation) return false;
    this.stalled = true;
    this.freshBuffered = false;
    return true;
  }

  /**
   * Whether the element's report, after a stall, falls short of the resume lead although every segment sent since the
   * reset has been appended and they reached further than the reported end: the browser dropped video at or after the
   * playhead that the engine will not send again.
   */
  private elementEvicted(appended: number, nowUs: number): boolean {
    if (!this.stalled || appended < this.segmentsSent) return false;
    const buffered = this.bufferedEndUs;
    return buffered < nowUs + ELEMENT_RESUME_LEAD_US && this.endUs > buffered + ELEMENT_END_SLACK_US;
  }

  /** The page's element starts again at `startUs` under a new generation; what it reported before is forgotten, a stall with it. */
  private resetElement(startUs: number, paused: boolean): void {
    this.generation = this.deps.nextGeneration();
    this.bufferedEndUs = -Infinity;
    this.stalled = false;
    this.freshBuffered = false;
    this.segmentsSent = 0;
    this.deps.emit({ type: 'videoReset', startUs, paused, generation: this.generation });
  }

  /** The remuxer's output goes to the page, its bytes transferred; the first init turns the compositor transparent. */
  private onRemuxOutput(out: RemuxOutput): void {
    if (!this.deps.isCurrent()) return;
    const transfer = transferOf(out.bytes);
    if (out.kind === 'segment') {
      this.segmentsSent++;
      this.deps.emit({ type: 'videoSegment', bytes: out.bytes, startUs: out.startUs, endUs: out.endUs }, transfer);
      return;
    }
    this.deps.emit({ type: 'videoInit', bytes: out.bytes, codec: out.codec, width: out.width, height: out.height }, transfer);
    const first = !this.shownOnce;
    this.shownOnce = true;
    this.deps.shown({ width: out.width, height: out.height, codedWidth: out.codedWidth, codedHeight: out.codedHeight }, first);
  }
}

/**
 * The page's answers to whether its video element plays a codec, kept for the page's life, and the questions still
 * waiting for one. A question unanswered after ELEMENT_QUERY_TIMEOUT_MS answers false; a later answer is still kept.
 * @internal
 */
export class ElementCodecQueries {
  /** The page's answers to videoElementQuery, by codec string. */
  private readonly answers = new Map<string, boolean>();
  /** Questions sent to the page with no answer yet, by codec string; each settles at the answer or at its timeout. */
  private readonly queries = new Map<string, { readonly answer: Promise<boolean>; readonly settle: (playable: boolean) => void }>();

  constructor(
    private readonly emit: (event: EngineEvent) => void,
    private readonly setTimer: (ms: number, fn: () => void) => () => void,
  ) {}

  /** The page's earlier answer for `codec`, or undefined when it hasn't given one. */
  cached(codec: string): boolean | undefined {
    return this.answers.get(codec);
  }

  /** Asks the page about `codec` (once while a question is open); false when no answer comes in time. */
  askElement(codec: string): Promise<boolean> {
    const asked = this.queries.get(codec);
    if (asked) return asked.answer;
    let settle!: (playable: boolean) => void;
    const answer = new Promise<boolean>((resolve) => (settle = resolve));
    const cancel = this.setTimer(ELEMENT_QUERY_TIMEOUT_MS, () => {
      // no answer in time: this session takes the canvas path; a later answer is still kept for the next
      if (this.queries.get(codec)?.answer === answer) this.queries.delete(codec);
      settle(false);
    });
    this.queries.set(codec, {
      answer,
      settle: (playable) => {
        cancel();
        settle(playable);
      },
    });
    this.emit({ type: 'videoElementQuery', codec, hdr: null });
    return answer;
  }

  /** The page's videoElementAnswer: kept, and the open question about `codec` settles with it. */
  answer(codec: string, playable: boolean): void {
    this.answers.set(codec, playable);
    const asked = this.queries.get(codec);
    this.queries.delete(codec);
    asked?.settle(playable);
  }

  /** Sends the open questions again (questions asked before an element was attached went to no one). */
  askAgain(): void {
    for (const codec of this.queries.keys()) this.emit({ type: 'videoElementQuery', codec, hdr: null });
  }
}
