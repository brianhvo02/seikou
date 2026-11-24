// SPDX-License-Identifier: LGPL-3.0-or-later
import type { ElementCheck, ElementQuery, EngineCommand, EngineEvent } from '../protocol';
import { elementQueryKey } from '../element/query-key';
import { ClockBlockReader, createClockBlock } from '../element/clock-block';
import { ELEMENT_TIME_OFFSET_US } from '../element/fmp4';
import { ElementSync } from './element-sync';

/**
 * The parts of an `HTMLVideoElement` the element output uses, so tests can fake it.
 * @internal
 */
export interface VideoElementLike {
  muted: boolean;
  playsInline: boolean;
  disableRemotePlayback: boolean;
  currentTime: number;
  playbackRate: number;
  src: string;
  readonly paused: boolean;
  readonly seeking: boolean;
  /** The element played to the end of its stream (after endOfStream): it pauses there by itself. */
  readonly ended: boolean;
  play(): Promise<void>;
  pause(): void;
  requestVideoFrameCallback(cb: (now: number, meta: { mediaTime: number; expectedDisplayTime: number }) => void): number;
  cancelVideoFrameCallback(id: number): void;
  getVideoPlaybackQuality(): { totalVideoFrames: number; droppedVideoFrames: number };
  addEventListener(type: VideoElementEvent, fn: () => void): void;
  /** Adds a text track (absent in tests that don't need one): it carries the subtitles while the element is presented. */
  addTextTrack?(kind: 'subtitles', label: string, language: string): TextTrackLike;
  removeAttribute(name: string): void;
  load(): void;
}

/**
 * The element events the output listens to: its own stalls and errors, play, pause and seeks (the system's controls),
 * and the presentation changes of Picture in Picture and WebKit's video fullscreen.
 * @internal
 */
export type VideoElementEvent =
  | 'waiting'
  | 'playing'
  | 'error'
  | 'play'
  | 'pause'
  | 'seeking'
  | 'enterpictureinpicture'
  | 'leavepictureinpicture'
  | 'webkitpresentationmodechanged'
  | 'webkitbeginfullscreen'
  | 'webkitendfullscreen';

/**
 * The parts of a `TextTrack` the element output uses.
 * @internal
 */
export interface TextTrackLike {
  mode: 'disabled' | 'hidden' | 'showing';
  addCue(cue: unknown): void;
  removeCue(cue: unknown): void;
}

/**
 * The parts of a `MediaSource` (or Safari's `ManagedMediaSource`) the element output uses.
 * @internal
 */
export interface MediaSourceLike {
  readonly readyState: string;
  /** Seconds; set to the playlist's end in media time so a system player's scrubber spans the playlist. */
  duration: number;
  addSourceBuffer(type: string): SourceBufferLike;
  /** Removes a source buffer (absent in tests that never replace one). */
  removeSourceBuffer?(buffer: SourceBufferLike): void;
  endOfStream(): void;
  addEventListener(type: 'sourceopen', fn: () => void): void;
}

/**
 * The parts of a `SourceBuffer` the element output uses; `changeType` is missing on older browsers.
 * @internal
 */
export interface SourceBufferLike {
  readonly updating: boolean;
  readonly buffered: { length: number; start(i: number): number; end(i: number): number };
  appendBuffer(b: Uint8Array): void;
  remove(start: number, end: number): void;
  abort(): void;
  changeType?(type: string): void;
  /** `bufferedchange` fires only on a ManagedMediaSource's buffers, when the browser evicts what they hold. */
  addEventListener(type: 'updateend' | 'error' | 'bufferedchange', fn: () => void): void;
}

/**
 * What {@link ElementVideoOutput} needs from the page. `createMediaSource` makes a media source with its object URL
 * (null when the browser has none); `playable` answers whether the element plays a stream, with what the browser said
 * (`elementCheck`); `epochMs` is now in epoch milliseconds (`performance.timeOrigin +
 * performance.now()`), used for a frame whose display time is unknown; `timeOrigin` is `performance.timeOrigin`,
 * which turns a frame's `expectedDisplayTime` into epoch milliseconds; `post` sends a command to the engine; `setTimer`
 * runs `fn` once after `ms` and returns its cancel; `animationFrame` (`requestAnimationFrame`, optional) runs `fn`
 * at the next display refresh with its time and returns its cancel, which measures the refresh interval when a frame's
 * display time has to be estimated.
 * @internal
 */
export interface ElementOutputDeps {
  video: VideoElementLike;
  createMediaSource(): { source: MediaSourceLike; url: string; revoke(): void } | null;
  playable(query: ElementQuery): Promise<{ readonly playable: boolean; readonly check: ElementCheck }>;
  epochMs(): number;
  timeOrigin: number;
  post(cmd: EngineCommand): void;
  setTimer(fn: () => void, ms: number): () => void;
  animationFrame?(fn: (now: number) => void): () => void;
  /**
   * Where answers to the capability check are kept, by elementQueryKey. The controller passes one map to every output it
   * makes, so a new element doesn't ask the browser again; without it the output keeps its own.
   */
  answers?: Map<string, Promise<ElementAnswer>>;
  /**
   * Whether the system shows the element now (Picture in Picture, or the video's own fullscreen), where its own controls
   * act on it: a play, pause or seek the output didn't make is then the user's. Never presented without it.
   */
  presented?(): boolean;
  /** The user played, paused or sought the element through the system's controls while it was presented. */
  onTransport?(t: ElementTransport): void;
  /** Makes a text cue (`new VTTCue(start, end, text)`) for the element's text track; without it no subtitles are carried. */
  makeCue?(startS: number, endS: number, text: string): unknown;
  /** Test-only: every append fails with an error that is not a `QuotaExceededError`, so the element fails at once. */
  failAppends?: boolean;
}

/**
 * What the user did to a presented element through the system's controls: play, pause, or a seek to a playlist time.
 * @internal
 */
export type ElementTransport = { readonly kind: 'play' } | { readonly kind: 'pause' } | { readonly kind: 'seek'; readonly timeUs: number };

/**
 * `text` as a WebVTT cue's text: `&`, `<` and `>` escaped, since a cue's text is parsed for tags and entities (an ASS
 * line's `<` would otherwise start a tag and vanish).
 * @internal
 */
export function vttCueText(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/** How long (ms) a presentation must stay ended before the playlist goes back to the setting's path. */
const PRESENTATION_END_SETTLE_MS = 500;

/** The end of the one cue the text track shows (seconds of media time): later than any playlist. */
const CUE_END_S = 1e7;
/** How close (seconds) a `seeking` element's time must lie to a time the output set to count as the output's own. */
const OWN_SEEK_SLACK_S = 0.05;
/** The most times the output set whose `seeking` it still waits for. */
const OWN_SEEKS_KEPT = 8;

type Op =
  | { readonly k: 'append'; readonly bytes: Uint8Array; readonly segment: boolean; readonly retried: boolean }
  | { readonly k: 'remove'; readonly start: number; readonly end: number }
  | { readonly k: 'change'; readonly type: string }
  /**
   * Replaces the source buffer with a new one of `type` (a session that follows one held while presented): Safari on
   * iPhone keeps a buffer's highest end through a removal and stretches the duration back to it on every append, so a
   * shorter next playlist would show the last one's length.
   */
  | { readonly k: 'rebuffer'; readonly type: string }
  /** Sets the media source's duration: queued after a reset's removal, since a duration under what is buffered is refused. */
  | { readonly k: 'duration'; readonly s: number }
  | { readonly k: 'end' };

interface Attached {
  readonly source: MediaSourceLike;
  readonly revoke: () => void;
  /** The first init's type, which the source buffer is made with; a codec change queued since runs as an operation. */
  readonly firstType: string;
  buffer: SourceBufferLike | null;
}

/** Seconds of video kept behind the playhead. */
const KEEP_BEHIND_S = 10;
const SYNC_REPORT_MS = 250;
/** How long a new media source may take to open before the element path fails. */
const SOURCE_OPEN_TIMEOUT_MS = 5000;
/** The most video (seconds) ahead of the playhead at which a `waiting` element counts as run dry. */
const DRY_AHEAD_S = 0.25;
/** play()'s expected start-up, from a paused element to its first frame shown, measured in Chrome on macOS (9–39 ms). */
const PLAY_START_LATENCY_US = 15_000;
/** How often a waiting element looks whether the clock has started moving. */
const START_POLL_MS = 4;
/** The smallest playbackRate change written to the element, so it isn't touched every frame. */
const MIN_RATE_CHANGE = 0.0002;

/** How far a frame's expected display time may lie from the callback's own time and still be believed. */
const DISPLAY_TIME_SLACK_MS = 1000;
/** The display refresh interval assumed until one is measured (60 Hz), and the range a measured one is kept within. */
const DEFAULT_REFRESH_MS = 1000 / 60;
const MIN_REFRESH_MS = 4;
const MAX_REFRESH_MS = 50;
/** How many successive animation-frame intervals the refresh estimate is the median of. */
const REFRESH_SAMPLES = 31;

/** The refresh interval measured from successive animation frames: the last intervals, the last frame's time, the estimate. */
interface RefreshEstimate {
  samples: number[];
  last: number | null;
  estimateMs: number;
  cancel: (() => void) | null;
}

/** The median of `xs` (not empty). */
function median(xs: readonly number[]): number {
  const sorted = [...xs].sort((a, b) => a - b);
  return sorted[sorted.length >> 1]!;
}

function mimeType(codec: string): string {
  return `video/mp4; codecs="${codec}"`;
}

/**
 * What the capability check answered for one question: playable, with what the browser said (none when the check failed).
 * @internal
 */
export type ElementAnswer = { readonly playable: boolean; readonly check?: ElementCheck };

function errorMessage(e: unknown): string {
  return e instanceof Error ? `${e.name}: ${e.message}` : String(e);
}

/**
 * The page's side of the element path: plays the engine's fragmented MP4 in a muted video element through Media
 * Source Extensions, one append at a time, and keeps the element on the engine's clock (read from {@link clock}, which
 * the engine writes) with {@link ElementSync}. Every time it reports or receives is playlist time; the element plays
 * at media time = playlist time + ELEMENT_TIME_OFFSET_US. Engine events go through {@link handle}.
 * @internal
 */
export class ElementVideoOutput {
  /** The clock block the engine publishes its clock through (sent with attachVideoElement). */
  readonly clock: SharedArrayBuffer;
  private readonly reader: ClockBlockReader;
  private readonly sync = new ElementSync();
  private attached: Attached | null = null;
  /** The codec the source buffer has once the queued operations have run. */
  private bufferCodec: string | null = null;
  /** The page's answers to the engine's questions, by codec and HDR facts. */
  private readonly playableCache: Map<string, Promise<ElementAnswer>>;
  private queue: Op[] = [];
  private inFlight: Op | null = null;
  /** Where the next appended segment puts the playhead (playlist µs), and whether it plays then. */
  private pendingStart: { readonly startUs: number } | null = null;
  private playing = false;
  private failed = false;
  private disposed = false;
  private frameId: number | null = null;
  private cancelSyncTimer: (() => void) | null = null;
  private cancelOpenTimer: (() => void) | null = null;
  /** While the element waits to start for the clock to move: the cancel of the next look at the clock. */
  private cancelStartTimer: (() => void) | null = null;
  /** Whether a videoStalled was posted that no videoResumed has answered yet. */
  private stalled = false;
  /** Media segments appended since the last reset (videoBuffered reports them, so the engine can tell eviction from data in transit). */
  private appended = 0;
  /** The last videoReset's generation, echoed in videoBuffered and videoStalled so the engine can drop reports from before it. */
  private generation = 0;
  private offsets: number[] = [];
  /** The generation whose first placed frame was reported (videoFrameShown), so each reset reports one. */
  private shownGeneration: number | null = null;
  /** Catch-ups run since the media source opened (videoSync reports the total). */
  private catchUps = 0;
  /**
   * The display's refresh interval (ms) as measured from successive animation frames, used only when a frame's
   * expectedDisplayTime is off the page's clock; null until the first such frame starts the measuring.
   */
  private refresh: RefreshEstimate | null = null;
  /** play() and pause() calls whose `play` and `pause` events are still to come: those events are the output's own. */
  private ownPlays = 0;
  private ownPauses = 0;
  /** Times (media seconds) the output set whose `seeking` is still to come. */
  private ownSeeks: number[] = [];
  /**
   * The element reached the end of its stream since the last reset: its own `pause` there is not the user's, and the
   * seek to the start a play from the system's controls makes on an ended element is not a seek of the player.
   */
  private endedSeen = false;
  /** Whether the engine sends textCue events: while the element is presented. */
  private cuesOn = false;
  /** The session stopped while the element was presented: its media source is kept for the next session (holdForNext). */
  private held = false;
  /** The session after a held one: its init replaces the source buffer (the rebuffer operation) instead of reusing it. */
  private afterHold = false;
  /** Whether the system showed the element, as last settled (a presentation's end counts once it has held). */
  private wasPresented = false;
  /** Cancels the look, a moment after a presentation seemed to end, whether it really did. */
  private cancelEndedCheck: (() => void) | null = null;
  /** The element's text track (made the first time it is presented) and the cue it shows. */
  private textTrack: TextTrackLike | null = null;
  private cue: unknown = null;
  /** The playlist's end in media time (seconds), from the last videoReset: the media source's duration, once set. */
  private durationS: number | null = null;

  /** Mutes the element, plays it inline, and listens to its stalls and errors. */
  constructor(private readonly deps: ElementOutputDeps) {
    this.clock = createClockBlock();
    this.reader = new ClockBlockReader(this.clock);
    this.playableCache = deps.answers ?? new Map();
    const video = deps.video;
    video.muted = true;
    video.playsInline = true;
    // `waiting` also fires around every seek (the playhead placement and the sync's own seeks): only a wait while
    // playing, not seeking, after the first segment is placed is a stall; `playing` answers only a posted stall.
    video.addEventListener('waiting', () => {
      if (!this.attached || !this.playing || this.pendingStart || video.seeking || this.stalled) return;
      // Chrome also fires `waiting` for a moment when its decoder falls a frame behind, with seconds buffered ahead: only
      // an element with almost nothing ahead of the playhead has run dry
      const buffer = this.attached.buffer;
      if (buffer && this.aheadS(buffer) > DRY_AHEAD_S) return;
      this.stalled = true;
      deps.post({ type: 'videoStalled', generation: this.generation });
      // the engine resumes only on a buffered report made after the stall, and no append may follow (the playlist read
      // to its end, or the reader held at its lead): report what is held now
      if (buffer) this.reportBuffered(buffer);
    });
    video.addEventListener('playing', () => {
      if (!this.attached || !this.stalled) return;
      this.stalled = false;
      deps.post({ type: 'videoResumed' });
    });
    video.addEventListener('error', () => {
      if (this.attached) this.fail('the video element failed');
    });
    video.addEventListener('pause', () => this.onPauseEvent());
    video.addEventListener('play', () => this.onPlayEvent());
    video.addEventListener('seeking', () => this.onSeekingEvent());
    for (const type of ['enterpictureinpicture', 'leavepictureinpicture', 'webkitpresentationmodechanged', 'webkitbeginfullscreen', 'webkitendfullscreen'] as const) {
      video.addEventListener(type, () => this.onPresentationChange());
    }
  }

  /**
   * The system started or stopped showing the element: while it does, the engine sends the showing text subtitles as
   * plain text (setTextCues) and the element's own text track shows them, since the canvas can't be seen there.
   */
  private onPresentationChange(): void {
    const presented = this.presented();
    // a source kept for a next playlist that never came to the element is released once nothing shows it
    if (!presented && this.held) this.detach();
    // the presentation ended: the playlist goes back to the path the video output setting picks (preferElement off),
    // once it has stayed ended a moment (WebKit reports the mode in steps while it enters and leaves)
    if (this.wasPresented && !presented) {
      this.cancelEndedCheck?.();
      this.cancelEndedCheck = this.deps.setTimer(() => {
        this.cancelEndedCheck = null;
        if (!this.presented()) {
          this.wasPresented = false;
          this.deps.post({ type: 'preferElement', on: false });
        }
      }, PRESENTATION_END_SETTLE_MS);
    } else if (presented) {
      this.cancelEndedCheck?.();
      this.cancelEndedCheck = null;
      this.wasPresented = true;
    }
    const on = presented && this.deps.makeCue !== undefined && this.deps.video.addTextTrack !== undefined;
    if (on === this.cuesOn) return;
    this.cuesOn = on;
    if (on && !this.textTrack) this.textTrack = this.deps.video.addTextTrack!('subtitles', 'Subtitles', '');
    this.showCue(null);
    if (this.textTrack) this.textTrack.mode = on ? 'showing' : 'disabled';
    this.deps.post({ type: 'setTextCues', on });
  }

  /** Shows `text` as the text track's one cue, spanning every media time, or none. */
  private showCue(text: string | null): void {
    const track = this.textTrack;
    if (!track) return;
    if (this.cue !== null) {
      try {
        track.removeCue(this.cue);
      } catch {
        // already gone
      }
      this.cue = null;
    }
    if (text === null || !this.cuesOn || !this.deps.makeCue) return;
    this.cue = this.deps.makeCue(0, CUE_END_S, text);
    track.addCue(this.cue);
  }

  /** Whether the system shows the element now (deps.presented), where play, pause and seeks the output didn't make are the user's. */
  private presented(): boolean {
    return this.deps.presented?.() === true;
  }

  private pauseVideo(): void {
    this.ownPauses++;
    this.deps.video.pause();
  }

  private playVideo(): Promise<void> {
    this.ownPlays++;
    return this.deps.video.play();
  }

  private seekVideo(mediaS: number): void {
    this.ownSeeks.push(mediaS);
    if (this.ownSeeks.length > OWN_SEEKS_KEPT) this.ownSeeks.shift();
    this.deps.video.currentTime = mediaS;
  }

  /**
   * A `pause`: the output's own, or the user's from the system's controls while the element is presented and the
   * engine plays, which pauses the player (the sound is the engine's, not the muted element's).
   */
  private onPauseEvent(): void {
    if (this.ownPauses > 0) {
      this.ownPauses--;
      return;
    }
    // an element at the end of its stream pauses by itself: the engine ends the playlist on its clock
    if (this.deps.video.ended) {
      this.endedSeen = true;
      return;
    }
    if (!this.attached || !this.presented() || !this.playing) return;
    this.deps.onTransport?.({ kind: 'pause' });
  }

  /**
   * A `play`: the output's own, or one it didn't make while the engine is paused, which it pauses again at once, since
   * the element starts only on the engine's clock; while presented that play is the user's and plays the player.
   */
  private onPlayEvent(): void {
    if (this.ownPlays > 0) {
      this.ownPlays--;
      return;
    }
    if (!this.attached || this.playing) return;
    this.pauseVideo();
    if (this.presented()) this.deps.onTransport?.({ kind: 'play' });
  }

  /** A `seeking` to a time the output didn't set, while presented: the user's seek, in playlist time. */
  private onSeekingEvent(): void {
    const t = this.deps.video.currentTime;
    const own = this.ownSeeks.findIndex((s) => Math.abs(s - t) <= OWN_SEEK_SLACK_S);
    if (own >= 0) {
      // one event per time set: two sets before the first event both read the later time, so each event answers the
      // oldest set still waiting, not the one it matched
      this.ownSeeks.shift();
      return;
    }
    if (!this.attached || this.pendingStart || !this.presented() || this.endedSeen) return;
    this.deps.onTransport?.({ kind: 'seek', timeUs: Math.max(0, Math.round(t * 1e6) - ELEMENT_TIME_OFFSET_US) });
  }

  /** Acts on an engine event; true when it was one of the element path's events. */
  handle(e: EngineEvent): boolean {
    switch (e.type) {
      case 'videoElementQuery':
        if (!this.disposed) {
          const { type: _type, ...query } = e;
          void this.answerQuery(query);
        }
        return true;
      case 'videoReset':
        if (!this.disposed) {
          this.generation = e.generation;
          this.durationS = e.durationUs !== undefined ? (e.durationUs + ELEMENT_TIME_OFFSET_US) / 1e6 : null;
          this.reset(e.startUs, e.paused);
        }
        return true;
      case 'videoInit':
        if (!this.disposed && !this.failed) this.init(e.bytes, e.codec);
        return true;
      case 'videoSegment':
        if (this.attached && !this.failed) {
          this.queue.push({ k: 'append', bytes: e.bytes, segment: true, retried: false });
          this.pump();
        }
        return true;
      case 'videoEnded':
        if (this.attached && !this.failed) {
          this.queue.push({ k: 'end' });
          this.pump();
        }
        return true;
      case 'videoElementStop':
        // the system shows the element (Picture in Picture): emptying it would close that, so its media source stays
        // for the next playlist's session, which resets and refills it; otherwise the element is released
        if (this.attached && this.presented()) this.holdForNext();
        else this.detach();
        return true;
      case 'textCue':
        this.showCue(e.text);
        return true;
      default:
        return false;
    }
  }

  /** Answers a query from the page's capability check (echoing it), asked once per elementQueryKey for the page's life. */
  private async answerQuery(query: ElementQuery): Promise<void> {
    const key = elementQueryKey(query);
    let answer = this.playableCache.get(key);
    if (!answer) {
      answer = this.deps.playable(query).catch(() => ({ playable: false }));
      this.playableCache.set(key, answer);
    }
    const { playable, check } = await answer;
    if (!this.disposed) this.deps.post({ type: 'videoElementAnswer', ...query, playable, ...(check ? { check } : {}) });
  }

  /** Whether the engine's clock runs: the element plays (once its first segment is placed) or pauses to match. */
  setPlaying(playing: boolean): void {
    this.playing = playing;
    if (this.disposed || !this.attached || this.pendingStart) return;
    this.applyPlaying();
  }

  /** Releases the element and stops every callback; the output is unusable after. */
  dispose(): void {
    this.cancelEndedCheck?.();
    this.cancelEndedCheck = null;
    this.detach();
    this.disposed = true;
  }

  /**
   * The session stopped while the system shows the element: the element pauses on its last frame and keeps its media
   * source, which the next session's reset empties and its init refills (changing the codec if it must).
   */
  private holdForNext(): void {
    this.held = true;
    this.cancelStart();
    this.queue = [];
    this.pendingStart = null;
    this.playing = false;
    this.stalled = false;
    if (!this.deps.video.paused) this.pauseVideo();
  }

  private reset(startUs: number, paused: boolean): void {
    this.afterHold = this.held;
    this.held = false;
    this.failed = false;
    this.endedSeen = false;
    this.appended = 0;
    this.pendingStart = { startUs };
    this.playing = !paused;
    this.stalled = false;
    this.cancelStart();
    this.sync.reset();
    this.offsets = [];
    this.queue = [];
    const a = this.attached;
    if (!a) return;
    if (!this.deps.video.paused) this.pauseVideo();
    const b = a.buffer;
    if (!b) {
      this.queueDuration();
      return;
    }
    if (a.source.readyState === 'open') {
      try {
        b.abort();
      } catch {
        // abort() throws while a range removal runs; the removal finishes and its updateend is ignored.
      }
    }
    this.inFlight = null;
    // after a held session the removal also reopens a source its end of stream closed, so a buffer can be added
    if (b.buffered.length > 0 || this.afterHold) this.queue.push({ k: 'remove', start: 0, end: Infinity });
    this.queueDuration();
    this.pump();
  }

  /** Queues the playlist's end as the media source's duration, so a system player's scrubber spans the playlist. */
  private queueDuration(): void {
    if (this.durationS !== null) this.queue.push({ k: 'duration', s: this.durationS });
  }

  private init(bytes: Uint8Array, codec: string): void {
    if (!this.attached) {
      const made = this.deps.createMediaSource();
      if (!made) {
        this.fail('this browser has no MediaSource');
        return;
      }
      const a: Attached = { source: made.source, revoke: made.revoke, firstType: mimeType(codec), buffer: null };
      this.attached = a;
      this.bufferCodec = codec;
      // WebKit's ManagedMediaSource opens only when remote playback is off (or an AirPlay source is given).
      this.deps.video.disableRemotePlayback = true;
      this.deps.video.src = made.url;
      made.source.addEventListener('sourceopen', () => this.onSourceOpen(a));
      this.cancelOpenTimer = this.deps.setTimer(() => {
        this.cancelOpenTimer = null;
        if (a === this.attached && !a.buffer) this.fail('the media source did not open within 5 s');
      }, SOURCE_OPEN_TIMEOUT_MS);
      this.startFrames();
      this.armSyncTimer();
      this.queueDuration();
    } else if (this.afterHold && this.attached.source.removeSourceBuffer) {
      this.afterHold = false;
      this.queue.push({ k: 'rebuffer', type: mimeType(codec) });
      this.bufferCodec = codec;
    } else if (codec !== this.bufferCodec) {
      this.queue.push({ k: 'change', type: mimeType(codec) });
      this.bufferCodec = codec;
    }
    this.queue.push({ k: 'append', bytes, segment: false, retried: false });
    // and once more after it: Safari on iPhone (ManagedMediaSource) stretches the duration to the last session's end when
    // the next init segment goes into the same buffer, which a scrubber would show until the end of stream
    this.queueDuration();
    if (this.attached?.source.readyState === 'open') this.onSourceOpen(this.attached);
    this.pump();
  }

  private onSourceOpen(a: Attached): void {
    if (a !== this.attached || a.buffer) return;
    this.cancelOpenTimer?.();
    this.cancelOpenTimer = null;
    let b: SourceBufferLike;
    try {
      b = a.source.addSourceBuffer(a.firstType);
    } catch (e) {
      this.fail(`the source buffer could not be made (${errorMessage(e)})`);
      return;
    }
    this.useBuffer(a, b);
    this.pump();
  }

  /** Makes `b` the source's buffer and listens to it. */
  private useBuffer(a: Attached, b: SourceBufferLike): void {
    a.buffer = b;
    b.addEventListener('updateend', () => this.onUpdateEnd(a, b));
    b.addEventListener('error', () => {
      if (a === this.attached && a.buffer === b) this.fail('an append failed');
    });
    // a ManagedMediaSource evicts buffered video under memory pressure: the engine hears what is left at once
    b.addEventListener('bufferedchange', () => {
      if (a === this.attached && a.buffer === b && !this.failed) this.reportBuffered(b);
    });
  }

  private onUpdateEnd(a: Attached, b: SourceBufferLike): void {
    if (a !== this.attached || a.buffer !== b || b.updating || this.failed) return;
    const op = this.inFlight;
    this.inFlight = null;
    if (op?.k === 'append') {
      if (op.segment) this.appended++;
      if (op.segment && this.pendingStart) {
        const { startUs } = this.pendingStart;
        this.pendingStart = null;
        this.seekVideo((startUs + ELEMENT_TIME_OFFSET_US) / 1e6);
        this.applyPlaying();
      }
      const behind = this.behindRemoval();
      if (behind) this.queue.unshift(behind);
    }
    // after a removal too: what the element holds at the playhead may have changed
    if (op) this.reportBuffered(b);
    this.pump();
  }

  /** Runs queued operations until one is in flight. */
  private pump(): void {
    const a = this.attached;
    const b = a?.buffer;
    if (!a || !b || this.failed) return;
    while (!this.inFlight && !b.updating && this.queue.length > 0) {
      const op = this.queue.shift()!;
      switch (op.k) {
        case 'change':
          if (!b.changeType) {
            this.fail('this browser cannot change a source buffer’s codec');
            return;
          }
          try {
            b.changeType(op.type);
          } catch (e) {
            this.fail(`the codec could not be changed (${errorMessage(e)})`);
            return;
          }
          break;
        case 'rebuffer': {
          let fresh: SourceBufferLike;
          try {
            a.source.removeSourceBuffer?.(b);
            fresh = a.source.addSourceBuffer(op.type);
          } catch (e) {
            this.fail(`the source buffer could not be replaced (${errorMessage(e)})`);
            return;
          }
          this.useBuffer(a, fresh);
          this.pump(); // the rest of the queue goes into the new buffer
          return;
        }
        case 'duration':
          if (a.source.readyState === 'open' && !(Math.abs(a.source.duration - op.s) <= 1e-3)) {
            try {
              a.source.duration = op.s;
            } catch {
              // refused (something past it is still buffered): kept as the browser has it
            }
          }
          break;
        case 'end':
          if (a.source.readyState === 'open') {
            try {
              a.source.endOfStream();
            } catch (e) {
              this.fail(`the stream could not be ended (${errorMessage(e)})`);
              return;
            }
          }
          break;
        case 'remove':
          try {
            b.remove(op.start, op.end);
          } catch (e) {
            this.fail(`a removal failed (${errorMessage(e)})`);
            return;
          }
          this.inFlight = op;
          break;
        case 'append':
          try {
            if (this.deps.failAppends) throw new Error('appends are made to fail');
            b.appendBuffer(op.bytes);
            this.inFlight = op;
          } catch (e) {
            if (e instanceof Error && e.name === 'QuotaExceededError' && !op.retried) {
              this.queue.unshift({ ...op, retried: true });
              const behind = this.behindRemoval();
              if (behind) this.queue.unshift(behind);
            } else {
              this.fail(`an append failed (${errorMessage(e)})`);
              return;
            }
          }
          break;
      }
    }
  }

  /** The removal of what lies more than 10 s behind the playhead, or null when nothing does. */
  private behindRemoval(): Op | null {
    const b = this.attached?.buffer;
    if (!b || b.buffered.length === 0) return null;
    const start = b.buffered.start(0);
    const end = this.deps.video.currentTime - KEEP_BEHIND_S;
    return start < end ? { k: 'remove', start, end } : null;
  }

  /** Seconds buffered ahead of the playhead in the range holding it; 0 when no range holds it. */
  private aheadS(b: SourceBufferLike): number {
    const r = b.buffered;
    const t = this.deps.video.currentTime;
    for (let i = 0; i < r.length; i++) if (r.start(i) <= t && t <= r.end(i)) return r.end(i) - t;
    return 0;
  }

  /**
   * Posts videoBuffered with the end of the range holding max(currentTime, the first range's start), so a session
   * started late reports its data before the playhead moves. When no range holds it (the browser evicted the video at
   * the playhead), the playhead itself: nothing ahead, which the engine reads as a cue to send that video again. Nothing
   * while the first segment after a reset is still to be placed (the playhead is the previous generation's).
   */
  private reportBuffered(b: SourceBufferLike): void {
    if (this.pendingStart) return;
    const r = b.buffered;
    const playhead = this.deps.video.currentTime;
    const t = r.length > 0 ? Math.max(playhead, r.start(0)) : playhead;
    let end = t;
    for (let i = 0; i < r.length; i++) {
      if (r.start(i) <= t && t <= r.end(i)) {
        end = r.end(i);
        break;
      }
    }
    this.deps.post({ type: 'videoBuffered', endUs: Math.round(end * 1e6) - ELEMENT_TIME_OFFSET_US, segments: this.appended, generation: this.generation });
  }

  private applyPlaying(): void {
    const video = this.deps.video;
    if (!this.playing) {
      this.cancelStart();
      if (!video.paused) {
        // WebKit keeps the position it reports in a cache refreshed when currentTime is read, and a pause fixes the
        // element at that cached position (measured 13 to 110 ms behind where it played to): reading it first pauses the
        // element where it is, as other browsers do, so the picture stops where the sound did
        void video.currentTime;
        this.pauseVideo();
      }
      return;
    }
    if (!video.paused) return;
    // The engine plays before its clock moves (the audio output's latency): the element waits for the clock to move, so
    // it does not start ahead of the sound.
    if (this.reader.read()?.running === true) {
      this.cancelStart();
      // a start or resume: the element is behind by how far the clock already is past it, and play() takes a display
      // frame or so more to start; it starts at the rate that catches that up, re-planned at its first measured frame
      const clockUs = this.reader.clockAt(this.deps.epochMs());
      const lagUs = clockUs === null ? 0 : clockUs - (video.currentTime * 1e6 - ELEMENT_TIME_OFFSET_US) + PLAY_START_LATENCY_US;
      const start = this.sync.restart(lagUs);
      if (start.catchUp) this.catchUps++;
      video.playbackRate = start.rate;
      const a = this.attached;
      this.playVideo().catch((e: unknown) => {
        // a pause (ours, or a reset's) while play() was pending rejects with AbortError: no failure. Anything else is a
        // refusal (NotAllowedError: iOS Low Power Mode refuses a muted play started outside a gesture) or an error, and
        // the element would sit on its placed frame under running sound
        if ((e as { name?: unknown } | null)?.name === 'AbortError') return;
        if (a === this.attached) this.fail(`the browser refused to play the video element (${errorMessage(e)})`);
      });
    } else if (!this.cancelStartTimer) {
      this.cancelStartTimer = this.deps.setTimer(() => {
        this.cancelStartTimer = null;
        if (this.attached && !this.pendingStart) this.applyPlaying();
      }, START_POLL_MS);
    }
  }

  /** Stops looking whether the clock has started moving. */
  private cancelStart(): void {
    this.cancelStartTimer?.();
    this.cancelStartTimer = null;
  }

  private startFrames(): void {
    if (this.frameId !== null) return;
    this.frameId = this.deps.video.requestVideoFrameCallback((now, meta) => {
      this.frameId = null;
      if (!this.attached) return;
      // a frame shown before the first segment after a reset is placed is the previous generation's
      if (!this.pendingStart && this.shownGeneration !== this.generation) {
        this.shownGeneration = this.generation;
        this.deps.post({ type: 'videoFrameShown', generation: this.generation });
      }
      this.onFrame(meta.mediaTime, this.displayTime(now, meta.expectedDisplayTime));
      this.startFrames();
    });
  }

  /**
   * When a frame shows, on the page's clock (milliseconds since its time origin): its `expectedDisplayTime`, or, when
   * that is missing or off the page's clock (WebKit gives a time from another origin, about -1.4e9 ms), the callback's
   * time plus one display refresh, since the callback runs about a refresh before the frame is seen; null with neither.
   * The refresh is the median of measured animation-frame intervals (60 Hz until measured, or without animation
   * frames); a frame shown later than one refresh after its callback still reads early by the difference.
   */
  private displayTime(now: number, expectedDisplayTime: number): number | null {
    if (Number.isFinite(expectedDisplayTime) && Number.isFinite(now) && Math.abs(expectedDisplayTime - now) <= DISPLAY_TIME_SLACK_MS) {
      return expectedDisplayTime;
    }
    if (!Number.isFinite(now)) return null;
    return now + this.refreshMs();
  }

  /** The display refresh interval: measured from animation frames (started on first use), else 60 Hz. */
  private refreshMs(): number {
    if (!this.refresh) {
      const r: RefreshEstimate = { samples: [], last: null, estimateMs: DEFAULT_REFRESH_MS, cancel: null };
      this.refresh = r;
      const frame = this.deps.animationFrame;
      if (frame) {
        const tick = (t: number): void => {
          r.cancel = null;
          if (r.last !== null) {
            const d = t - r.last;
            if (d > 0) {
              r.samples.push(d);
              if (r.samples.length > REFRESH_SAMPLES) r.samples.shift();
              r.estimateMs = Math.min(MAX_REFRESH_MS, Math.max(MIN_REFRESH_MS, median(r.samples)));
            }
          }
          r.last = t;
          if (this.refresh === r && this.attached) r.cancel = frame(tick);
        };
        r.cancel = frame(tick);
      }
    }
    return this.refresh.estimateMs;
  }

  private onFrame(mediaTimeS: number, displayMs: number | null): void {
    // the placed frame shown while the element waits for the clock to move measures nothing: the element has not started
    if (this.pendingStart || this.deps.video.paused) return;
    const video = this.deps.video;
    const published = this.reader.read();
    if (this.playing && published && !published.running) {
      // the engine plays but its clock holds (a still at a play item's end): the element stops on the held clock's
      // frame instead of playing on and being pulled back, and starts again, as at a start, once the clock moves
      void video.currentTime;
      this.pauseVideo();
      this.seekVideo((published.clockUs + ELEMENT_TIME_OFFSET_US) / 1e6);
      this.applyPlaying();
      return;
    }
    const epoch = displayMs !== null ? this.deps.timeOrigin + displayMs : this.deps.epochMs();
    const clockUs = this.reader.clockAt(epoch);
    const action = this.sync.onFrame(mediaTimeS * 1e6 - ELEMENT_TIME_OFFSET_US, clockUs, this.playing);
    if (action.catchUp) this.catchUps++;
    // videoSync carries clock minus frame time, as the canvas path measures it.
    if (action.offsetUs !== null) this.offsets.push(-action.offsetUs);
    if (action.seekToUs !== null) {
      this.seekVideo((action.seekToUs + ELEMENT_TIME_OFFSET_US) / 1e6);
      video.playbackRate = action.rate;
    } else if (Math.abs(action.rate - video.playbackRate) >= MIN_RATE_CHANGE) {
      video.playbackRate = action.rate;
    }
  }

  private armSyncTimer(): void {
    this.cancelSyncTimer = this.deps.setTimer(() => {
      this.cancelSyncTimer = null;
      if (!this.attached) return;
      this.reportSync();
      this.armSyncTimer();
    }, SYNC_REPORT_MS);
  }

  private reportSync(): void {
    if (this.offsets.length === 0) return;
    const q = this.deps.video.getVideoPlaybackQuality();
    const offsetsUs = this.offsets;
    this.offsets = [];
    this.deps.post({
      type: 'videoSync',
      offsetsUs,
      presented: q.totalVideoFrames - q.droppedVideoFrames,
      dropped: q.droppedVideoFrames,
      catchUps: this.catchUps,
    });
  }

  private fail(message: string): void {
    if (this.failed) return;
    this.failed = true;
    this.deps.post({ type: 'videoElementFailed', message, generation: this.generation });
    this.detach();
  }

  /** Cancels callbacks, drops the queue, detaches the source from the element and revokes its URL. */
  private detach(): void {
    this.afterHold = false;
    this.held = false;
    if (this.frameId !== null) {
      this.deps.video.cancelVideoFrameCallback(this.frameId);
      this.frameId = null;
    }
    this.cancelSyncTimer?.();
    this.cancelSyncTimer = null;
    this.cancelStart();
    this.refresh?.cancel?.();
    this.refresh = null;
    this.catchUps = 0;
    this.queue = [];
    this.inFlight = null;
    this.offsets = [];
    this.pendingStart = null;
    this.stalled = false;
    this.cancelOpenTimer?.();
    this.cancelOpenTimer = null;
    this.bufferCodec = null;
    const a = this.attached;
    this.attached = null;
    if (!a) return;
    const video = this.deps.video;
    if (!video.paused) this.pauseVideo();
    video.removeAttribute('src');
    video.load();
    a.revoke();
  }
}
