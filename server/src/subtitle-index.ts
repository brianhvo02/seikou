import type { StoredSubtitle } from '@seikou/nas/nas-api';

/**
 * The subtitle store's metas in memory, so a listing or a budget check never walks the disk: each upload by id,
 * the pooled fonts with how many fansubs use each, and running byte totals (owner uploads against their 2 GB,
 * fansubs' files, originals and pooled fonts against theirs). Loaded once from `meta.json`s; the store keeps
 * it current on every write.
 */
export class SubtitleIndex {
  private readonly byId = new Map<string, { s: StoredSubtitle; original: number }>();
  private readonly pool = new Map<string, { size: number; refs: number }>();
  private owner = 0;
  private fansubFiles = 0;
  private poolBytes = 0;

  get(id: string): StoredSubtitle | null {
    return this.byId.get(id)?.s ?? null;
  }

  values(): StoredSubtitle[] {
    return [...this.byId.values()].map((e) => e.s);
  }

  /** Puts `s` in (replacing the entry of the same id); `original` is a fansub's original file's size, kept when omitted. */
  set(s: StoredSubtitle, original?: number): void {
    const prev = this.byId.get(s.id);
    if (prev) this.account(prev.s, prev.original, -1);
    const size = s.source ? (original ?? prev?.original ?? 0) : 0;
    this.byId.set(s.id, { s, original: size });
    this.account(s, size, 1);
  }

  remove(id: string): StoredSubtitle | null {
    const prev = this.byId.get(id);
    if (!prev) return null;
    this.byId.delete(id);
    this.account(prev.s, prev.original, -1);
    return prev.s;
  }

  /** A fansub's original file's size (0 for an owner upload). */
  originalSize(id: string): number {
    return this.byId.get(id)?.original ?? 0;
  }

  /** Pooled font hashes in use, with their sizes. */
  pooled(): ReadonlyMap<string, { readonly size: number; readonly refs: number }> {
    return this.pool;
  }

  /** What owner uploads hold against the store's total. */
  ownerBytes(): number {
    return this.owner;
  }

  /** Bytes the fansubs hold: each one's file and original, and each pooled font once. */
  fansubBytes(): number {
    return this.fansubFiles + this.poolBytes;
  }

  private account(s: StoredSubtitle, original: number, sign: 1 | -1): void {
    if (!s.source) {
      this.owner += sign * (s.fileSize + s.fonts.reduce((n, f) => n + f.size, 0));
      return;
    }
    this.fansubFiles += sign * (s.fileSize + original);
    for (const f of s.fonts) {
      if (!f.hash) continue;
      const cur = this.pool.get(f.hash);
      if (sign > 0) {
        if (cur) cur.refs++;
        else {
          this.pool.set(f.hash, { size: f.size, refs: 1 });
          this.poolBytes += f.size;
        }
      } else if (cur && --cur.refs <= 0) {
        this.pool.delete(f.hash);
        this.poolBytes -= cur.size;
      }
    }
  }
}
