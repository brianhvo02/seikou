/** Which times of a real-world script the local ASS gate compares, and the local fixtures themselves. */
import { existsSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type { AssTrack } from '@seikou/ass/types';

const FRAME_MS = 41;
const BUSIEST = 10;
const ANIMATED = /\{[^}]*\\(t\(|move|fade?\(|k|K)/;

/**
 * The given times, else every event's start, middle and last shown millisecond, plus every frame (41 ms) of the
 * ten animated events with the most override tags. Sorted, unique.
 */
export function sampleTimes(track: AssTrack, explicit: readonly number[] | null): number[] {
  const out = new Set<number>();
  if (explicit && explicit.length) for (const t of explicit) out.add(t);
  else {
    for (const e of track.events) {
      out.add(e.start);
      if (e.duration > 0) {
        out.add(e.start + Math.floor(e.duration / 2));
        out.add(e.start + e.duration - 1);
      }
    }
    const busiest = track.events
      .filter((e) => e.duration > 0 && ANIMATED.test(e.text))
      .map((e) => ({ e, tags: (e.text.match(/\\/g) ?? []).length }))
      .sort((a, b) => b.tags - a.tags)
      .slice(0, BUSIEST);
    for (const { e } of busiest) for (let t = e.start; t < e.start + e.duration; t += FRAME_MS) out.add(t);
  }
  return [...out].sort((a, b) => a - b);
}

export interface LocalAssFixture {
  readonly name: string;
  readonly dir: string;
  /** The script (the first .ass/.ssa in the folder by name). */
  readonly script: string;
  /** Font files in the folder and its subfolders (two levels). */
  readonly fonts: readonly string[];
  readonly timesFile: string | null;
}

const FONT = /\.(ttf|otf|ttc|woff)$/i;

function fontsUnder(dir: string, depth: number): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry);
    if (statSync(p).isDirectory()) {
      if (depth > 0) out.push(...fontsUnder(p, depth - 1));
    } else if (FONT.test(entry)) out.push(p);
  }
  return out.sort();
}

/** fixtures/local/ass/<name>/: a script, its fonts, an optional times.txt. */
export function localFixtures(root = 'fixtures/local/ass'): LocalAssFixture[] {
  if (!existsSync(root)) return [];
  return readdirSync(root)
    .map((name) => join(root, name))
    .filter((dir) => statSync(dir).isDirectory())
    .flatMap((dir) => {
      const script = readdirSync(dir).filter((f) => /\.(ass|ssa)$/i.test(f)).sort()[0];
      if (!script) return [];
      return [{ name: dir.split('/').pop()!, dir, script: join(dir, script), fonts: fontsUnder(dir, 2), timesFile: existsSync(join(dir, 'times.txt')) ? join(dir, 'times.txt') : null }];
    });
}
