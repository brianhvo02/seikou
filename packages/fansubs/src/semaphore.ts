/** At most `limit` jobs at once; the rest wait in order, and a waiter whose signal aborts leaves the line. Original code. */
export class Semaphore {
  private running = 0;
  private readonly waiting: (() => void)[] = [];

  constructor(private readonly limit: number) {}

  get active(): number {
    return this.running;
  }

  get queued(): number {
    return this.waiting.length;
  }

  async run<T>(job: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    await this.acquire(signal);
    try {
      return await job();
    } finally {
      this.running--;
      this.waiting.shift()?.();
    }
  }

  private acquire(signal?: AbortSignal): Promise<void> {
    signal?.throwIfAborted();
    if (this.running < this.limit) {
      this.running++;
      return Promise.resolve();
    }
    return new Promise((resolve, reject) => {
      const go = (): void => {
        signal?.removeEventListener('abort', abort);
        this.running++;
        resolve();
      };
      const abort = (): void => {
        const at = this.waiting.indexOf(go);
        if (at >= 0) this.waiting.splice(at, 1);
        reject(signal!.reason);
      };
      this.waiting.push(go);
      signal?.addEventListener('abort', abort, { once: true });
    });
  }
}
