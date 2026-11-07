import { SourceUnavailable } from './sources';

/** Thrown by a paced call that got a 429; `retryAfterMs` is from its Retry-After header. */
export class RateLimited extends Error {
  override name = 'RateLimited';
  constructor(readonly retryAfterMs: number | null) {
    super('rate limited');
  }
}

export interface PacedOptions {
  /** An interactive call: it starts ahead of the calls already waiting that aren't urgent (ruling T9h). */
  readonly urgent?: boolean;
  /** Aborting it drops the call while it waits for its turn, rejecting with the signal's reason. */
  readonly signal?: AbortSignal;
}

interface Waiting {
  readonly urgent: boolean;
  /** Arrival order, for urgent calls past their share. */
  readonly seq: number;
  readonly go: () => void;
}

/** Sleeps `ms`, or until `signal` aborts, clearing its timer then. */
function defaultSleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const done = (): void => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    signal?.addEventListener('abort', done, { once: true });
  });
}

/**
 * Starts at most `perWindow` calls in any `windowMs` (a sliding window), in the order they were made, urgent ones first
 * while they have started fewer than 2/3 of `perWindow` in the window; past that share they take their turn in arrival
 * order, so background calls keep progressing (ruling T9j).
 * A call that throws `RateLimited` holds every call back for its Retry-After (one window without one),
 * is retried once, and a second `RateLimited` becomes `SourceUnavailable`.
 */
export class Pacer {
  private readonly starts: { readonly at: number; readonly urgent: boolean }[] = [];
  private readonly waiting: Waiting[] = [];
  private readonly urgentShare: number;
  private seq = 0;
  private pumping = false;
  /** Cuts the pump's sleep short when nothing is left waiting. */
  private napping: AbortController | null = null;
  private blockedUntil = 0;

  constructor(
    private readonly perWindow: number,
    private readonly windowMs: number,
    private readonly now: () => number = Date.now,
    private readonly sleep: (ms: number, signal?: AbortSignal) => Promise<void> = defaultSleep,
  ) {
    this.urgentShare = Math.max(1, Math.floor((perWindow * 2) / 3));
  }

  async run<T>(fn: () => Promise<T>, opts: PacedOptions = {}): Promise<T> {
    for (let attempt = 0; ; attempt++) {
      await this.slot(opts);
      try {
        return await fn();
      } catch (e) {
        if (!(e instanceof RateLimited)) throw e;
        if (attempt > 0) throw new SourceUnavailable('rate limited after a retry');
        this.blockedUntil = Math.max(this.blockedUntil, this.now() + (e.retryAfterMs ?? this.windowMs));
      }
    }
  }

  /** Waits for this call's turn, then records its start. */
  private slot({ urgent = false, signal }: PacedOptions): Promise<void> {
    return new Promise((resolve, reject) => {
      if (signal?.aborted) {
        reject(signal.reason);
        return;
      }
      const onAbort = (): void => {
        const at = this.waiting.indexOf(item);
        if (at >= 0) this.waiting.splice(at, 1);
        if (this.waiting.length === 0) this.napping?.abort();
        reject(signal!.reason);
      };
      const item: Waiting = {
        urgent,
        seq: this.seq++,
        go: () => {
          signal?.removeEventListener('abort', onAbort);
          resolve();
        },
      };
      signal?.addEventListener('abort', onAbort, { once: true });
      const before = urgent ? this.waiting.findIndex((w) => !w.urgent) : -1;
      if (before < 0) this.waiting.push(item);
      else this.waiting.splice(before, 0, item);
      void this.pump();
    });
  }

  /** Starts waiting calls one by one as the window allows; the next call is picked only when it can start. */
  private async pump(): Promise<void> {
    if (this.pumping) return;
    this.pumping = true;
    try {
      while (this.waiting.length > 0) {
        const t = this.now();
        while (this.starts.length > 0 && this.starts[0]!.at <= t - this.windowMs) this.starts.shift();
        const wait = Math.max(this.blockedUntil - t, this.starts.length >= this.perWindow ? this.starts[0]!.at + this.windowMs - t : 0);
        if (wait > 0) {
          this.napping = new AbortController();
          try {
            await this.sleep(wait, this.napping.signal);
          } finally {
            this.napping = null;
          }
          continue;
        }
        // urgent calls go first within their share; past it, the earliest arrival goes
        const urgentStarted = this.starts.filter((s) => s.urgent).length;
        const at = urgentStarted < this.urgentShare ? 0 : this.waiting.reduce((best, w, i) => (w.seq < this.waiting[best]!.seq ? i : best), 0);
        const [next] = this.waiting.splice(at, 1);
        this.starts.push({ at: this.now(), urgent: next!.urgent });
        next!.go();
      }
    } finally {
      this.pumping = false;
    }
  }
}
