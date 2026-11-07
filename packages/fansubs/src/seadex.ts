/** SeaDex client (https://seadex.moe, a PocketBase API). Pace it with a few calls a second. Original code. */
import { RateLimited } from '@seikou/titles/pacer';
import type { PacedOptions, Pacer } from '@seikou/titles/pacer';
import { retryAfterMs, SourceUnavailable } from '@seikou/titles/sources';

export interface SeaDexRelease {
  readonly tracker: string;
  /** Null when SeaDex redacts it (private trackers). */
  readonly infoHash: string | null;
  readonly isBest: boolean;
  readonly dualAudio: boolean;
  readonly group: string;
  readonly tags: readonly string[];
  readonly files: readonly { readonly name: string; readonly length: number }[];
}

export interface SeaDexEntry {
  readonly alId: number;
  readonly incomplete: boolean;
  readonly releases: readonly SeaDexRelease[];
}

export interface SeaDex {
  /** The entry for an AniList id, or null when SeaDex has none. */
  entry(alId: number, opts?: PacedOptions): Promise<SeaDexEntry | null>;
}

interface RawTorrent {
  readonly tracker?: string | null;
  readonly releaseGroup?: string | null;
  readonly isBest?: boolean | null;
  readonly dualAudio?: boolean | null;
  readonly tags?: readonly string[] | null;
  readonly infoHash?: string | null;
  readonly files?: readonly { readonly name?: string | null; readonly length?: number | null }[] | null;
}
interface RawEntry {
  readonly alID: number;
  readonly incomplete?: boolean | null;
  readonly expand?: { readonly trs?: readonly RawTorrent[] | null } | null;
}

const HASH = /^[0-9a-f]{40}$/i;

function toRelease(t: RawTorrent): SeaDexRelease {
  return {
    tracker: t.tracker ?? '',
    infoHash: typeof t.infoHash === 'string' && HASH.test(t.infoHash) ? t.infoHash.toLowerCase() : null,
    isBest: t.isBest === true,
    dualAudio: t.dualAudio === true,
    group: t.releaseGroup ?? '',
    tags: t.tags ?? [],
    files: (t.files ?? []).map((f) => ({ name: f.name ?? '', length: f.length ?? 0 })),
  };
}

export function createSeaDex(fetch: typeof globalThis.fetch, pacer: Pacer, userAgent: string, base: string): SeaDex {
  return {
    entry: (alId, opts) =>
      pacer.run(async () => {
        let res: Response;
        try {
          res = await fetch(`${base}/api/collections/entries/records?filter=alID=${alId}&expand=trs`, {
            headers: { 'User-Agent': userAgent, Accept: 'application/json' },
          });
        } catch {
          throw new SourceUnavailable('seadex: network error');
        }
        if (!res.ok) {
          await res.body?.cancel().catch(() => {});
          if (res.status === 429) throw new RateLimited(retryAfterMs(res.headers.get('Retry-After')));
          throw new SourceUnavailable(`seadex: HTTP ${res.status}`);
        }
        let body: { items?: readonly RawEntry[] };
        try {
          body = (await res.json()) as { items?: readonly RawEntry[] };
        } catch {
          throw new SourceUnavailable('seadex: unreadable response');
        }
        if (!Array.isArray(body?.items)) throw new SourceUnavailable('seadex: unexpected response');
        const item = body.items[0];
        if (!item) return null;
        return { alId: item.alID, incomplete: item.incomplete === true, releases: (item.expand?.trs ?? []).map(toRelease) };
      }, opts),
  };
}
