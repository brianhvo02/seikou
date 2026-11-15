// SPDX-License-Identifier: LGPL-3.0-or-later
import type { EngineCommand, EngineEvent } from '../protocol';
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
  play(): Promise<void>;
  pause(): void;
  requestVideoFrameCallback(cb: (now: number, meta: { mediaTime: number; expectedDisplayTime: number }) => void): number;
  cancelVideoFrameCallback(id: number): void;
  getVideoPlaybackQuality(): { totalVideoFrames: number; droppedVideoFrames: number };
  addEventListener(type: 'waiting' | 'playing' | 'error', fn: () => void): void;
  removeAttribute(name: string): void;
  load(): void;
}

/**
 * The parts of a `MediaSource` (or Safari's `ManagedMediaSource`) the element output uses.
 * @internal
 */
export interface MediaSourceLike {
  readonly readyState: string;
  addSourceBuffer(type: string): SourceBufferLike;
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
  addEventListener(type: 'updateend' | 'error', fn: () => void): void;
}

/**
 * What {@link ElementVideoOutput} needs from the page. `createMediaSource` makes a media source with its object URL
 * (null when the browser has none); `epochMs` is now in epoch milliseconds (`performance.timeOrigin +
 * performance.now()`), used for a frame whose display time is unknown; `timeOrigin` is `performance.timeOrigin`,
 * which turns a frame's `expectedDisplayTime` into epoch milliseconds; `post` sends a command to the engine; `setTimer`
 * runs `fn` once after `ms` and returns its cancel.
 * @internal
 */
export interface ElementOutputDeps {
  video: VideoElementLike;
  createMediaSource(): { source: MediaSourceLike; url: string; revoke(): void } | null;
  isTypeSupported(type: string): boolean;
  epochMs(): number;
  timeOrigin: number;
  post(cmd: EngineCommand): void;
  setTimer(fn: () => void, ms: number): () => void;
}

type Op =
  | { readonly k: 'append'; readonly bytes: Uint8Array; readonly segment: boolean; readonly retried: boolean }
  | { readonly k: 'remove'; readonly start: number; readonly end: number }
  | { readonly k: 'change'; readonly type: string }
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
/** The smallest playbackRate change written to the element, so it isn't touched every frame. */
const MIN_RATE_CHANGE = 0.0002;

function mimeType(codec: string): string {
  return `video/mp4; codecs="${codec}"`;
}

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
  /** Whether a videoStalled was posted that no videoResumed has answered yet. */
  private stalled = false;
  /** The last videoReset's generation, echoed in videoBuffered and videoStalled so the engine can drop reports from before it. */
  private generation = 0;
  private offsets: number[] = [];

  /** Mutes the element, plays it inline, and listens to its stalls and errors. */
  constructor(private readonly deps: ElementOutputDeps) {
    this.clock = createClockBlock();
    this.reader = new ClockBlockReader(this.clock);
    const video = deps.video;
    video.muted = true;
    video.playsInline = true;
    // `waiting` also fires around every seek (the playhead placement and the sync's own seeks): only a wait while
    // playing, not seeking, after the first segment is placed is a stall; `playing` answers only a posted stall.
    video.addEventListener('waiting', () => {
      if (!this.attached || !this.playing || this.pendingStart || video.seeking || this.stalled) return;
      this.stalled = true;
      deps.post({ type: 'videoStalled', generation: this.generation });
      // the engine resumes only on a buffered report made after the stall, and no append may follow (the playlist read
      // to its end, or the reader held at its lead): report what is held now
      const buffer = this.attached.buffer;
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
  }

  /** Acts on an engine event; true when it was one of the element path's events. */
  handle(e: EngineEvent): boolean {
    switch (e.type) {
      case 'videoElementQuery':
        if (!this.disposed) {
          this.deps.post({ type: 'videoElementAnswer', codec: e.codec, playable: this.deps.isTypeSupported(mimeType(e.codec)) });
        }
        return true;
      case 'videoReset':
        if (!this.disposed) {
          this.generation = e.generation;
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
        this.detach();
        return true;
      default:
        return false;
    }
  }

  /** Whether the engine's clock runs: the element plays (once its first segment is placed) or pauses to match. */
  setPlaying(playing: boolean): void {
    this.playing = playing;
    if (this.disposed || !this.attached || this.pendingStart) return;
    this.applyPlaying();
  }

  /** Releases the element and stops every callback; the output is unusable after. */
  dispose(): void {
    this.detach();
    this.disposed = true;
  }

  private reset(startUs: number, paused: boolean): void {
    this.failed = false;
    this.pendingStart = { startUs };
    this.playing = !paused;
    this.stalled = false;
    this.sync.reset();
    this.offsets = [];
    this.queue = [];
    const a = this.attached;
    if (!a) return;
    if (!this.deps.video.paused) this.deps.video.pause();
    const b = a.buffer;
    if (!b) return;
    if (a.source.readyState === 'open') {
      try {
        b.abort();
      } catch {
        // abort() throws while a range removal runs; the removal finishes and its updateend is ignored.
      }
    }
    this.inFlight = null;
    if (b.buffered.length > 0) this.queue.push({ k: 'remove', start: 0, end: Infinity });
    this.pump();
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
    } else if (codec !== this.bufferCodec) {
      this.queue.push({ k: 'change', type: mimeType(codec) });
      this.bufferCodec = codec;
    }
    this.queue.push({ k: 'append', bytes, segment: false, retried: false });
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
    a.buffer = b;
    b.addEventListener('updateend', () => this.onUpdateEnd(a, b));
    b.addEventListener('error', () => {
      if (a === this.attached && a.buffer === b) this.fail('an append failed');
    });
    this.pump();
  }

  private onUpdateEnd(a: Attached, b: SourceBufferLike): void {
    if (a !== this.attached || a.buffer !== b || b.updating || this.failed) return;
    const op = this.inFlight;
    this.inFlight = null;
    if (op?.k === 'append') {
      if (op.segment && this.pendingStart) {
        const { startUs } = this.pendingStart;
        this.pendingStart = null;
        this.deps.video.currentTime = (startUs + ELEMENT_TIME_OFFSET_US) / 1e6;
        this.applyPlaying();
      }
      const behind = this.behindRemoval();
      if (behind) this.queue.unshift(behind);
      this.reportBuffered(b);
    }
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

  /** Posts videoBuffered with the end of the range holding max(currentTime, the first range's start), so a session started late reports its data before the playhead moves. */
  private reportBuffered(b: SourceBufferLike): void {
    const r = b.buffered;
    if (r.length === 0) return;
    const t = Math.max(this.deps.video.currentTime, r.start(0));
    for (let i = 0; i < r.length; i++) {
      if (r.start(i) <= t && t <= r.end(i)) {
        this.deps.post({ type: 'videoBuffered', endUs: Math.round(r.end(i) * 1e6) - ELEMENT_TIME_OFFSET_US, generation: this.generation });
        return;
      }
    }
  }

  private applyPlaying(): void {
    const video = this.deps.video;
    if (this.playing) {
      if (video.paused) void video.play().catch(() => undefined);
    } else if (!video.paused) {
      video.pause();
    }
  }

  private startFrames(): void {
    if (this.frameId !== null) return;
    this.frameId = this.deps.video.requestVideoFrameCallback((_now, meta) => {
      this.frameId = null;
      if (!this.attached) return;
      this.onFrame(meta.mediaTime, meta.expectedDisplayTime);
      this.startFrames();
    });
  }

  private onFrame(mediaTimeS: number, expectedDisplayTime: number): void {
    if (this.pendingStart) return;
    const video = this.deps.video;
    const epoch = Number.isFinite(expectedDisplayTime) ? this.deps.timeOrigin + expectedDisplayTime : this.deps.epochMs();
    const clockUs = this.reader.clockAt(epoch);
    const action = this.sync.onFrame(mediaTimeS * 1e6 - ELEMENT_TIME_OFFSET_US, clockUs, this.playing);
    // videoSync carries clock minus frame time, as the canvas path measures it.
    if (action.offsetUs !== null) this.offsets.push(-action.offsetUs);
    if (action.seekToUs !== null) {
      video.currentTime = (action.seekToUs + ELEMENT_TIME_OFFSET_US) / 1e6;
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
    });
  }

  private fail(message: string): void {
    if (this.failed) return;
    this.failed = true;
    this.deps.post({ type: 'videoElementFailed', message });
    this.detach();
  }

  /** Cancels callbacks, drops the queue, detaches the source from the element and revokes its URL. */
  private detach(): void {
    if (this.frameId !== null) {
      this.deps.video.cancelVideoFrameCallback(this.frameId);
      this.frameId = null;
    }
    this.cancelSyncTimer?.();
    this.cancelSyncTimer = null;
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
    if (!video.paused) video.pause();
    video.removeAttribute('src');
    video.load();
    a.revoke();
  }
}
