// SPDX-License-Identifier: LGPL-3.0-or-later
/**
 * How a playlist's chapters become episodes: a split toggle between two chapters and a skip toggle per chapter,
 * written as the comma-separated `--episodes` text the encoder takes. The page cannot import the encoder's parser,
 * so `fromSpec` repeats its rules.
 */

/**
 * The page's state for one playlist. Any combination of numbers is allowed; `normalize` drops what has no effect, and
 * `episodesOf` reads a grouping as if it were normalized.
 */
export interface Grouping {
  /** Chapter numbers (1-based) after which a new episode starts. */
  readonly splits: ReadonlySet<number>;
  /** Chapter numbers (1-based) that belong to no episode. */
  readonly skipped: ReadonlySet<number>;
}

/** One episode: a run of chapters, 1-based and inclusive at both ends. */
export interface EpisodeRange {
  readonly from: number;
  readonly to: number;
}

/**
 * The grouping with everything that has no effect removed: out-of-range numbers in either set, splits at or after
 * the last chapter and splits next to a skipped chapter. It is what `fromSpec` gives for the grouping's episodes, so
 * two groupings make the same episodes exactly when their normal forms are equal.
 */
export function normalize(grouping: Grouping, chapterCount: number): Grouping {
  const skipped = new Set([...grouping.skipped].filter((c) => c >= 1 && c <= chapterCount));
  const splits = new Set(
    [...grouping.splits].filter((c) => c >= 1 && c < chapterCount && !skipped.has(c) && !skipped.has(c + 1)),
  );
  return { splits, skipped };
}

/**
 * The episodes a grouping makes: runs of kept chapters, cut at every split and at every skipped chapter. Numbers
 * outside 1 to `chapterCount` in either set are ignored, as are splits at or beyond the last chapter.
 */
export function episodesOf(grouping: Grouping, chapterCount: number): EpisodeRange[] {
  const { splits, skipped } = normalize(grouping, chapterCount);
  const episodes: EpisodeRange[] = [];
  let from = 0;
  for (let c = 1; c <= chapterCount; c++) {
    if (skipped.has(c)) {
      if (from > 0) episodes.push({ from, to: c - 1 });
      from = 0;
      continue;
    }
    if (from === 0) from = c;
    if (splits.has(c) || c === chapterCount) {
      episodes.push({ from, to: c });
      from = 0;
    }
  }
  return episodes;
}

/**
 * The `--episodes` text for a list of episodes: `a-b`, a lone chapter `a`, and `a-` for a run that reaches the last
 * chapter. An empty list gives an empty string.
 */
export function toSpec(episodes: readonly EpisodeRange[], chapterCount: number): string {
  return episodes
    .map((e) => (e.to >= chapterCount ? `${e.from}-` : e.from === e.to ? `${e.from}` : `${e.from}-${e.to}`))
    .join(',');
}

/**
 * Reads `--episodes` text into a canonical grouping, or null when the encoder would refuse it: empty text, a token
 * that is not `a`, `a-b` or `a-`, an open end that is not last, a chapter below 1 or above `chapterCount`, a range
 * that does not ascend, or ranges that overlap or come out of order. Gaps between ranges become skipped chapters and
 * ranges that touch become splits.
 */
export function fromSpec(spec: string, chapterCount: number): Grouping | null {
  if (spec.trim() === '') return null;
  const tokens = spec.split(',').map((t) => t.trim());
  const splits = new Set<number>();
  const skipped = new Set<number>();
  let previousEnd = 0;
  for (let i = 0; i < tokens.length; i++) {
    const m = /^(\d+)(?:(-)(\d*))?$/.exec(tokens[i]);
    if (!m) return null;
    const from = Number(m[1]);
    let to: number;
    if (m[2] === undefined) to = from;
    else if (m[3] === '') {
      if (i !== tokens.length - 1) return null;
      to = chapterCount;
    } else to = Number(m[3]);
    if (from < 1 || to < 1 || from > chapterCount || to > chapterCount) return null;
    if (to < from || from <= previousEnd) return null;
    for (let c = previousEnd + 1; c < from; c++) skipped.add(c);
    if (previousEnd > 0 && from === previousEnd + 1) splits.add(previousEnd);
    previousEnd = to;
  }
  for (let c = previousEnd + 1; c <= chapterCount; c++) skipped.add(c);
  return { splits, skipped };
}

/**
 * Each episode's length in milliseconds: the sum of its chapters' lengths. `chapterMs[0]` is chapter 1; a chapter
 * outside the list counts as zero.
 */
export function episodeLengths(episodes: readonly EpisodeRange[], chapterMs: readonly number[]): number[] {
  return episodes.map((e) => {
    let sum = 0;
    for (let c = e.from; c <= e.to; c++) sum += chapterMs[c - 1] ?? 0;
    return sum;
  });
}
