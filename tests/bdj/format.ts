import type { TraceEntry } from '../../src/bdj/host';

export type { TraceEntry };

export const CONTROL_CALLS: ReadonlySet<string> = new Set([
  'selectTitleN', 'selectPlaylistN', 'seekN', 'selectAngleN', 'selectRateN',
  'writeRegN', 'setUOMaskN', 'setKeyInterestN', 'soundEffectN', 'setVirtualPackageN',
]);

/** Reads harness output, skipping every line that is not a JSON object with a `call` field (JVM and libbluray logging). */
export function parseBdjTrace(text: string): TraceEntry[] {
  const out: TraceEntry[] = [];
  for (const line of text.split('\n')) {
    const s = line.trim();
    if (!s.startsWith('{')) continue;
    let v: unknown;
    try {
      v = JSON.parse(s);
    } catch {
      continue;
    }
    if (typeof v === 'object' && v !== null && typeof (v as { call?: unknown }).call === 'string') out.push(v as TraceEntry);
  }
  return out;
}

/** The entries of `trace` up to and including the `occurrence`-th `call` (all of them if it has fewer). */
export function traceThrough(trace: readonly TraceEntry[], call: string, occurrence = 1): TraceEntry[] {
  let seen = 0;
  const i = trace.findIndex((e) => e.call === call && ++seen === occurrence);
  return trace.slice(0, i < 0 ? trace.length : i + 1);
}
