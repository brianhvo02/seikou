/**
 * Runs loads a few at a time, the most urgent first: a waiting load's priority can change (a poster scrolled into
 * view), and a load that is no longer wanted is dropped, or frees its slot if it already started. Original code.
 */

/** 0: on screen; 1: within scroll range; 2: elsewhere. */
export type LoadPriority = 0 | 1 | 2;

/** The handle `LoadQueue.add` gives back for one load. */
export interface LoadTicket {
  setPriority(priority: LoadPriority): void;
  /** Drops a waiting load; a started one keeps running, but its slot goes to the next. */
  cancel(): void;
}

interface Job {
  readonly start: () => Promise<void>;
  priority: LoadPriority;
  readonly order: number;
  state: 'waiting' | 'running' | 'done';
}

/** A queue that runs at most `limit` loads at once. Loads start in priority order (lower first), oldest first within a priority, and those above the ceiling wait. */
export class LoadQueue {
  private readonly waiting = new Set<Job>();
  private running = 0;
  private order = 0;
  /** Loads above this priority wait, however free the queue is, until their priority comes down or this goes up. */
  private ceiling: LoadPriority = 2;

  constructor(private readonly limit: number) {}

  add(start: () => Promise<void>, priority: LoadPriority): LoadTicket {
    const job: Job = { start, priority, order: this.order++, state: 'waiting' };
    this.waiting.add(job);
    this.pump();
    return {
      setPriority: (p) => {
        const freed = job.priority > this.ceiling && p <= this.ceiling;
        job.priority = p;
        // a load held back by the ceiling can start now that it is wanted
        if (freed) this.pump();
      },
      cancel: () => {
        if (job.state === 'waiting') {
          job.state = 'done';
          this.waiting.delete(job);
        } else if (job.state === 'running') this.finish(job);
      },
    };
  }

  /** Lets loads up to `priority` start: 2 for every load, 1 to leave those out of scroll range waiting. */
  setCeiling(priority: LoadPriority): void {
    this.ceiling = priority;
    this.pump();
  }

  /** Loads started and not yet finished or cancelled. */
  get active(): number {
    return this.running;
  }

  private next(): Job | null {
    let best: Job | null = null;
    for (const job of this.waiting) {
      if (job.priority > this.ceiling) continue;
      if (best === null || job.priority < best.priority || (job.priority === best.priority && job.order < best.order)) best = job;
    }
    return best;
  }

  private pump(): void {
    while (this.running < this.limit) {
      const job = this.next();
      if (job === null) return;
      this.waiting.delete(job);
      job.state = 'running';
      this.running++;
      // a load's own failure is its business: the queue only needs to know it ended
      job.start().then(
        () => this.finish(job),
        () => this.finish(job),
      );
    }
  }

  private finish(job: Job): void {
    if (job.state !== 'running') return;
    job.state = 'done';
    this.running--;
    // a priority change while waiting is seen here, when the next load is picked
    queueMicrotask(() => this.pump());
  }
}
