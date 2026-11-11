/** The spans of an ASS script that are spoken dialogue, not signs, songs or typesetting. Pure; original code. */
import { parseAss } from '@seikou/ass/parse';

const NON_DIALOGUE_TOKEN = /^(signs?|songs?|op|ed|opening|ending|kara(oke)?|titles?|inserts?|notes?|tl|lyrics?|romaji|kanji)\d*$/i;
const POSITIONED = /\\(?:pos|move)\s*\(/;
const KARAOKE = /\\[kK][fFoO]?\d/;
const DRAWING = /\\p[1-9]/;

/** A style is not dialogue when any word of its name (split at non-alphanumerics and camelCase humps) names signs, songs or notes. */
function isNonDialogueStyle(name: string): boolean {
  return name.replace(/([a-z])([A-Z])/g, '$1 $2').split(/[^A-Za-z0-9]+/).some((t) => NON_DIALOGUE_TOKEN.test(t));
}
const MIN_MS = 300;
const MAX_MS = 10_000;

/**
 * Dialogue events' spans, sorted and merged where they overlap. Commented lines are not events.
 * @example ../examples/dialogue-intervals.ts
 */
export function dialogueIntervals(ass: string): { fromMs: number; toMs: number }[] {
  const track = parseAss(ass);
  const spans: { fromMs: number; toMs: number }[] = [];
  for (const e of track.events) {
    if (e.duration < MIN_MS || e.duration > MAX_MS) continue;
    if (isNonDialogueStyle(track.styles[e.style]?.name ?? '')) continue;
    if (POSITIONED.test(e.text) || KARAOKE.test(e.text) || DRAWING.test(e.text)) continue;
    spans.push({ fromMs: e.start, toMs: e.start + e.duration });
  }
  spans.sort((a, b) => a.fromMs - b.fromMs);
  const merged: { fromMs: number; toMs: number }[] = [];
  for (const s of spans) {
    const last = merged[merged.length - 1];
    if (last && s.fromMs <= last.toMs) last.toMs = Math.max(last.toMs, s.toMs);
    else merged.push({ ...s });
  }
  return merged;
}
