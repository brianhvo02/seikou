/** What the presenter needs of a frame (a WebCodecs VideoFrame, or a fake). */
export interface PresentableFrame {
  /** Presentation time in microseconds, on the playlist clock. */
  readonly timestamp: number;
  /** Releases the frame's memory; the presenter calls it exactly once per frame it owns. */
  close(): void;
}

/**
 * How long (us) a frame may have been due without the frame before it, due and not yet shown, being dropped for it:
 * the older one is shown at this tick and the newer at the next. The time frames are picked by wavers by a few
 * milliseconds against the display's ticks (the smoothed audio clock re-anchors on its steps), and at 59.94 or 50
 * frames a second, a tick lands within a few milliseconds of a frame's time for seconds at a time; without this, a
 * waver of a millisecond there passes two frames in one tick and drops one.
 */
const JUST_DUE_US = 5_000;

/** Holds decoded frames and picks the one to display for a clock time. Owns (and closes) every frame. */
export class VideoPresenter<F extends PresentableFrame> {
  /** Frames shown so far (select() returned them). */
  presented = 0;
  /** Frames closed without being shown: late ones passed over, stale ones, and those dropLate() closed. */
  dropped = 0;
  private queue: F[] = [];
  private shown: F | null = null;
  private presentedSinceClear = false;

  /** Frames queued, not counting the one on screen. */
  get size(): number {
    return this.queue.length;
  }

  /** Frames queued that `which` picks, not counting the one on screen. */
  count(which: (frame: F) => boolean): number {
    let n = 0;
    for (const f of this.queue) if (which(f)) n++;
    return n;
  }

  /** The frame last selected (still owned by the presenter), or null. */
  get current(): F | null {
    return this.shown;
  }

  /** Queues a decoded frame in timestamp order; the presenter owns it from now on. */
  push(frame: F): void {
    let i = this.queue.length;
    while (i > 0 && this.queue[i - 1].timestamp > frame.timestamp) i--;
    this.queue.splice(i, 0, frame);
  }

  /**
   * The frame to draw at `clockUs`: the newest queued frame whose timestamp is due, with older ones dropped, except
   * that a frame due for less than 5 ms doesn't drop the one before it (that one is shown first, see JUST_DUE_US). Returns
   * null when nothing is due and one has been shown since the last clear(); before the first frame after a clear() the
   * oldest queued frame is returned even if early, so a paused seek shows a picture. A returned frame stays valid until
   * the next select() or clear().
   */
  select(clockUs: number): F | null {
    this.dropStale();
    let idx = this.showIndex(clockUs);
    if (idx < 0) {
      if (this.presentedSinceClear || this.queue.length === 0) return null;
      idx = 0;
    }
    for (let i = 0; i < idx; i++) {
      this.queue[i].close();
      this.dropped++;
    }
    const next = this.queue[idx];
    this.queue = this.queue.slice(idx + 1);
    this.shown?.close();
    this.shown = next;
    this.presentedSinceClear = true;
    this.presented++;
    return next;
  }

  /** Closes the due frames select() would drop at `clockUs`, without presenting (used when rendering is throttled). */
  dropLate(clockUs: number): void {
    this.dropStale();
    const idx = this.showIndex(clockUs);
    if (idx <= 0) return;
    for (let i = 0; i < idx; i++) {
      this.queue[i].close();
      this.dropped++;
    }
    this.queue = this.queue.slice(idx);
  }

  /** Closes every frame, the one on screen included (a seek or a stop). */
  clear(): void {
    for (const f of this.queue) f.close();
    this.queue = [];
    this.shown?.close();
    this.shown = null;
    this.presentedSinceClear = false;
  }

  /** Closes queued frames not newer than the one on screen; showing them would step the picture backwards. */
  private dropStale(): void {
    const shownAt = this.shown?.timestamp;
    if (shownAt === undefined) return;
    let n = 0;
    while (n < this.queue.length && this.queue[n].timestamp <= shownAt) {
      this.queue[n].close();
      this.dropped++;
      n++;
    }
    if (n > 0) this.queue = this.queue.slice(n);
  }

  /** The queued frame to show at `clockUs`: the newest due for at least JUST_DUE_US, else the oldest due; -1 for none. */
  private showIndex(clockUs: number): number {
    const settled = this.lastDueIndex(clockUs - JUST_DUE_US);
    if (settled >= 0) return settled;
    return this.lastDueIndex(clockUs) >= 0 ? 0 : -1;
  }

  private lastDueIndex(clockUs: number): number {
    let idx = -1;
    for (let i = 0; i < this.queue.length && this.queue[i].timestamp <= clockUs; i++) idx = i;
    return idx;
  }
}
