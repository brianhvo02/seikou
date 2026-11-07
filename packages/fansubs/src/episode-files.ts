/** Which episode a release's file name holds, and a movie's main file. Pure; original code. */
import type { ToshoFile } from './tosho';

const EXTRA_WORD = /\b(NC(OP|ED)\d*(v\d+)?|OP\d*(v\d+)?|ED\d*(v\d+)?|PV|CM|Preview|Menu|Extras?|SP\d*|OVA|Creditless|Clean[ .-]*(Opening|Ending|OP|ED))\b/i;
const EXTRA_DIRS = new Set(['extras', 'bonus', 'nc', 'specials']);

/** Patterns in order of confidence; each captures the episode number. */
const PATTERNS: readonly RegExp[] = [
  /S\d{1,2}E(\d{1,3})(?!\d)/i,
  / - (\d{1,3})(?:v\d+)?(?=[\s.[(]|$)/,
  /\bEP(?:isode)?\s*(\d{1,3})(?!\d)/i,
  /(?:^|[^A-Za-z0-9])E(\d{2,3})(?!\d)/,
  /第\s*(\d{1,3})\s*話/,
  /(?:^|[\s.])(\d{2,3})v\d+(?=[\s.[(]|$)/,
  / (\d{1,3})(?:v\d+)? (?=[[(])/,
];

/** A release's CRC32 in brackets would read as an episode ("[5E12FA90]"). */
const CRC = /[[(][0-9A-F]{8}[\])]/gi;

/** The name's last segment with underscores as spaces, so word boundaries work. */
function baseOf(name: string): string {
  return (name.split(/[\\/]/).pop() ?? '').replace(/_/g, ' ');
}

function dirsOf(name: string): string[] {
  return name.split(/[\\/]/).slice(0, -1);
}

/** True for creditless openings and endings, previews, menus and anything under an extras folder. */
export function isExtraFile(name: string): boolean {
  return dirsOf(name).some((d) => EXTRA_DIRS.has(d.trim().toLowerCase())) || EXTRA_WORD.test(baseOf(name));
}

export function episodeOfFile(name: string): number | null {
  if (isExtraFile(name)) return null;
  const base = baseOf(name).replace(/\.[A-Za-z0-9]{2,4}$/, '').replace(CRC, '');
  for (const p of PATTERNS) {
    const m = p.exec(base);
    if (m) {
      const n = Number(m[1]);
      if (n > 0) return n;
    }
  }
  return null;
}

/** The file's number as this season's number (`before` = episodes in the earlier seasons), or null. */
export function seasonEpisode(fileEpisode: number, season: { readonly count: number; readonly before: number }): number | null {
  if (fileEpisode >= 1 && fileEpisode <= season.count) return fileEpisode;
  const n = fileEpisode - season.before;
  return n >= 1 && n <= season.count ? n : null;
}

/** A movie's file: the largest that is not an extra. */
export function mainFile(files: readonly ToshoFile[]): ToshoFile | null {
  let best: ToshoFile | null = null;
  for (const f of files) if (!isExtraFile(f.name) && (best === null || f.size > best.size)) best = f;
  return best;
}

/** The `vN` of a file name (`05v2` is 2), 1 when it has none. */
export function fileVersion(name: string): number {
  const m = /\dv(\d+)(?=[\s.[(_]|$)/.exec(baseOf(name).replace(CRC, ''));
  return m ? Number(m[1]) : 1;
}
