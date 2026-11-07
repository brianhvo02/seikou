/** Disc keys and playlist lengths from the library's evidence, for the fansub runs, picks and routes. Original code. */
import { parseDiscKey } from '@seikou/nas/disc-key';
import type { Library } from '../library';
import type { DiscEvidence } from '../titles/evidence';

export interface FansubDiscs {
  /** The key a disc's links carry (`f.<fingerprint>`, else `d.<disc id>`); null for a disc the library doesn't list. */
  discKey(discId: string): string | null;
  /** The listed discs a key stands for: every copy with that fingerprint. */
  discIds(discKey: string): string[];
  durationMs(discId: string, playlistId: string): number | null;
}

interface Index {
  readonly from: readonly DiscEvidence[];
  readonly byId: ReadonlyMap<string, DiscEvidence>;
  readonly byFingerprint: ReadonlyMap<string, readonly string[]>;
}

/** Looks discs up through maps built once per evidence list: the library hands out the same list until a scan changes it. */
export function libraryFansubDiscs(library: Pick<Library, 'evidence'>): FansubDiscs {
  let index: Index | null = null;
  const current = (): Index => {
    const from = library.evidence();
    if (index?.from === from) return index;
    const byFingerprint = new Map<string, string[]>();
    for (const e of from) {
      if (!e.fingerprint) continue;
      const ids = byFingerprint.get(e.fingerprint) ?? [];
      ids.push(e.discId);
      byFingerprint.set(e.fingerprint, ids);
    }
    index = { from, byId: new Map(from.map((e) => [e.discId, e])), byFingerprint };
    return index;
  };
  return {
    discKey: (discId) => {
      const ev = current().byId.get(discId);
      return ev ? (ev.fingerprint ? `f.${ev.fingerprint}` : `d.${ev.discId}`) : null;
    },
    discIds: (discKey) => {
      const parsed = parseDiscKey(discKey);
      if (!parsed) return [];
      const { byId, byFingerprint } = current();
      if (parsed.kind === 'disc') return byId.has(parsed.discId) ? [parsed.discId] : [];
      return [...(byFingerprint.get(parsed.fingerprint) ?? [])];
    },
    durationMs: (discId, playlistId) => {
      const p = current().byId.get(discId)?.playlists.find((x) => x.id === playlistId);
      return p ? Math.round(p.durationS * 1000) : null;
    },
  };
}
