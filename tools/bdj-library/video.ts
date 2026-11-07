/**
 * Real menu video for the library check (Ruling R4; tools/bdj-library/README.md, Real menu video): which clips a disc's
 * menu needs, whether they fit the cap, and the record of which clips are real. No disc, file or process access.
 */
import type { Mpls } from '@seikou/bdmv/mpls-parser';
import type { RunRecord } from './classify';

/** A clip id as it names STREAM/<id>.m2ts: five digits, nothing that could make a path. */
export const isClipId = (c: string): boolean => /^\d{5}$/.test(c);

/** At most this much real video per disc. */
export const VIDEO_CAP_BYTES = 2 * 1024 ** 3;

const isSelect = (c: { call: string; args: readonly unknown[]; ret: unknown }): boolean => c.call === 'selectPlaylistN' && c.ret === 1 && Number(c.args[0]) >= 0;

/**
 * The playlists Java selected up to and including the menu, over both runs, in order: the distinct playlists selected
 * before the `wait menu` step held, and the first one selected after it (the menu's own, when it starts on the menu);
 * when the step never held, only the first playlist selected.
 */
export function menuPlaylists(runs: readonly (RunRecord | null)[]): number[] {
  const out: number[] = [];
  const add = (p: number): void => {
    if (!out.includes(p)) out.push(p);
  };
  for (const r of runs) {
    if (!r) continue;
    const held = r.steps[0];
    if (!held) {
      const first = r.calls.find(isSelect);
      if (first) add(Number(first.args[0]));
      continue;
    }
    r.calls.slice(0, held.calls).filter(isSelect).forEach((c) => add(Number(c.args[0])));
    const next = r.calls.slice(held.calls).find(isSelect);
    if (next) add(Number(next.args[0]));
  }
  return out;
}

/** A playlist's clips: the main path's (and its angles'), then the sub-paths' (IG, sounds, ...), each once. */
export function playlistClips(mpls: Mpls): string[] {
  const out = new Set<string>();
  for (const item of mpls.playItems) {
    out.add(item.clipId);
    for (const a of item.angleClipIds) out.add(a);
  }
  for (const sub of mpls.subPaths) for (const item of sub.items) out.add(item.clipId);
  return [...out].filter(isClipId);
}

export interface ClipSize {
  readonly clip: string;
  readonly size: number;
  readonly mtime: number;
}

/** The clips to copy for a disc (those not already real, unchanged), or why the disc is skipped. */
export function planVideo(clips: readonly ClipSize[], real: ReadonlyMap<string, ClipSize>, cap = VIDEO_CAP_BYTES): { copy: ClipSize[]; total: number; skip: string | null } {
  const total = clips.reduce((n, c) => n + c.size, 0);
  if (total > cap) return { copy: [], total, skip: `${(total / 1024 ** 3).toFixed(2)} GB over the ${(cap / 1024 ** 3).toFixed(0)} GB cap` };
  const copy = clips.filter((c) => {
    const r = real.get(c.clip);
    return !r || r.size !== c.size || r.mtime !== c.mtime;
  });
  return { copy, total, skip: null };
}

/** manifests/<id>.video.tsv: one `<clip>\t<size>\t<mtime>` line per clip that is real (copied from the NAS). */
export function parseVideoManifest(text: string): Map<string, ClipSize> {
  const out = new Map<string, ClipSize>();
  for (const line of text.split('\n')) {
    const [clip, size, mtime] = line.split('\t');
    if (clip && /^\d{5}$/.test(clip)) out.set(clip, { clip, size: Number(size), mtime: Number(mtime) });
  }
  return out;
}

/** The manifest with the given clips marked real (replacing older entries for them). */
export function markReal(text: string, clips: readonly ClipSize[]): string {
  const m = parseVideoManifest(text);
  for (const c of clips) m.set(c.clip, c);
  return [...m.values()].sort((a, b) => a.clip.localeCompare(b.clip)).map((c) => `${c.clip}\t${c.size}\t${c.mtime}`).join('\n') + '\n';
}
