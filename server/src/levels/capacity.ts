/** A viewing needs its film's output frame rate times this, as a margin so a lease isn't sized exactly to the encoder's best case. */
export const NEED_MARGIN = 1.3;
/** The NAS GPU's encoder output per codec when only that codec runs, frames per second: measured on the NAS's Intel Quick Sync GPU and rounded down. */
export const GPU_BUDGETS = { h264: 190, hevc: 100 } as const;
/** A lease no read has touched for this long, in milliseconds, is gone. */
export const LEASE_IDLE_MS = 120_000;

/** The codecs the GPU encodes, each with its own budget. */
export type EncoderCodec = 'h264' | 'hevc';

/** One viewing's hold on the GPU. */
export interface Lease {
  /** The viewing's key (see `viewingIdOf` in `level-service.ts`). */
  readonly viewingId: string;
  readonly codec: EncoderCodec;
  /** Encoder frames per second the viewing needs: its film's fps × 1.3. */
  readonly needFps: number;
}

/**
 * The GPU's encoder capacity, leased per viewing. The budgets are what the GPU encodes per second of one
 * codec alone (H.264 190 fps, HEVC 100 fps); both codecs run on the same GPU, so each lease takes its need's share of its
 * own codec's budget, and a lease is admitted while the shares add up to at most the whole GPU. First come, first served.
 * A lease is kept by `touch` and expires 2 min after the last one.
 */
export class Capacity {
  private readonly leases = new Map<string, Lease & { touchedAt: number }>();

  constructor(
    private readonly budgets: { readonly h264: number; readonly hevc: number },
    private readonly now: () => number = Date.now,
  ) {}

  /**
   * Leases capacity for a viewing whose film runs at `fps`; true when admitted. A viewing that holds a lease keeps it (and
   * it is touched). `replacing` names leases this one takes over (the same viewer's earlier level or audio): it is
   * admitted if it fits without them, and then they are released; if it doesn't fit, they stay.
   */
  lease(viewingId: string, codec: EncoderCodec, fps: number, replacing: readonly string[] = []): boolean {
    this.expire();
    const held = this.leases.get(viewingId);
    const needFps = fps * NEED_MARGIN;
    if (held && held.codec === codec && held.needFps === needFps) {
      held.touchedAt = this.now();
      return true;
    }
    const without = new Set([viewingId, ...replacing]);
    if (this.share(without) + needFps / this.budgets[codec] > 1 + 1e-9) return false;
    for (const id of without) this.leases.delete(id);
    this.leases.set(viewingId, { viewingId, codec, needFps, touchedAt: this.now() });
    return true;
  }

  /** Whether a new viewing of `codec` at `fps` would be admitted now, taking over `replacing` (as `lease`). */
  fits(codec: EncoderCodec, fps: number, replacing: readonly string[] = []): boolean {
    this.expire();
    return this.share(new Set(replacing)) + (fps * NEED_MARGIN) / this.budgets[codec] <= 1 + 1e-9;
  }

  /** Whether `viewingId` holds a live lease. */
  has(viewingId: string): boolean {
    this.expire();
    return this.leases.has(viewingId);
  }

  /** Restarts the idle clock of the lease, if there is one. */
  touch(viewingId: string): void {
    this.expire();
    const held = this.leases.get(viewingId);
    if (held) held.touchedAt = this.now();
  }

  /** Gives the lease up; no effect without one. */
  release(viewingId: string): void {
    this.leases.delete(viewingId);
  }

  /** What is leased: encoder fps per codec, and each viewing. */
  inUse(): { h264Fps: number; hevcFps: number; viewings: Lease[] } {
    this.expire();
    const viewings = [...this.leases.values()].map(({ viewingId, codec, needFps }) => ({ viewingId, codec, needFps }));
    const sum = (codec: EncoderCodec): number => viewings.reduce((n, v) => n + (v.codec === codec ? v.needFps : 0), 0);
    return { h264Fps: sum('h264'), hevcFps: sum('hevc'), viewings };
  }

  /** Every lease with the time since it was last touched, oldest first (the owner's "Encoding now"). */
  list(): readonly { viewingId: string; codec: EncoderCodec; needFps: number; idleMs: number }[] {
    this.expire();
    const now = this.now();
    return [...this.leases.values()].map(({ viewingId, codec, needFps, touchedAt }) => ({ viewingId, codec, needFps, idleMs: now - touchedAt }));
  }

  /** The GPU's encoder budget for `codec`, frames per second. */
  budgetOf(codec: EncoderCodec): number {
    return this.budgets[codec];
  }

  /** The GPU's share the leases take, leaving out `without`. */
  private share(without: ReadonlySet<string>): number {
    let share = 0;
    for (const l of this.leases.values()) if (!without.has(l.viewingId)) share += l.needFps / this.budgets[l.codec];
    return share;
  }

  private expire(): void {
    const now = this.now();
    for (const [id, l] of this.leases) if (now - l.touchedAt >= LEASE_IDLE_MS) this.leases.delete(id);
  }
}
