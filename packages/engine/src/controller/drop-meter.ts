export const DROP_WINDOW_MS = 5_000;
export const DROP_WARN_RATE = 0.05;
const MIN_SPAN_MS = 1_000;

interface Sample {
  readonly t: number;
  readonly presented: number;
  readonly dropped: number;
}

/** Frame-drop rate over a sliding window, from the presenter's cumulative counters. */
export class DropMeter {
  private samples: Sample[] = [];

  push(nowMs: number, presented: number, dropped: number): void {
    const last = this.samples[this.samples.length - 1];
    // a counter going down means a new presenter: the old window no longer applies
    if (last && (presented < last.presented || dropped < last.dropped)) this.samples = [];
    this.samples.push({ t: nowMs, presented, dropped });
    // keep one sample at or before the window start, so the window spans its full length
    while (this.samples.length > 1 && this.samples[1]!.t <= nowMs - DROP_WINDOW_MS) this.samples.shift();
  }

  /** Dropped ÷ (presented + dropped) over the window; null with under 1 s of samples. */
  rate(): number | null {
    const first = this.samples[0];
    const last = this.samples[this.samples.length - 1];
    if (!first || !last || last.t - first.t < MIN_SPAN_MS) return null;
    const dropped = last.dropped - first.dropped;
    const total = last.presented - first.presented + dropped;
    return total > 0 ? dropped / total : 0;
  }

  reset(): void {
    this.samples = [];
  }
}
