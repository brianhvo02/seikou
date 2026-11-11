/** What the presenter needs of a frame (a WebCodecs VideoFrame, or a fake). */
export interface PresentableFrame {
  /** Presentation time in microseconds, on the playlist clock. */
  readonly timestamp: number;
  /** Releases the frame's memory; the presenter calls it exactly once per frame it owns. */
  close(): void;
}

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
   * The frame to draw at `clockUs`: the newest queued frame whose timestamp is due, with older ones dropped. Returns
   * null when nothing is due and one has been shown since the last clear(); before the first frame after a clear() the
   * oldest queued frame is returned even if early, so a paused seek shows a picture. A returned frame stays valid until
   * the next select() or clear().
   */
  select(clockUs: number): F | null {
    this.dropStale();
    let idx = this.lastDueIndex(clockUs);
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

  /** Closes due frames except the newest one, without presenting (used when rendering is throttled). */
  dropLate(clockUs: number): void {
    this.dropStale();
    const idx = this.lastDueIndex(clockUs);
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

  private lastDueIndex(clockUs: number): number {
    let idx = -1;
    for (let i = 0; i < this.queue.length && this.queue[i].timestamp <= clockUs; i++) idx = i;
    return idx;
  }
}
