/** Ranks a SeaDex entry's releases and picks, per episode, the first with ASS/SSA subtitles in the wanted languages. Pure; original code. */
import type { SeaDexRank } from '@seikou/nas/nas-api';
import { episodeOfFile, fileVersion, mainFile, seasonEpisode } from './episode-files';
import type { SeaDexEntry, SeaDexRelease } from './seadex';
import type { ToshoFile, ToshoRelease, ToshoTrack } from './tosho';

/** A SeaDex release found on Anime Tosho. */
export interface Candidate {
  /** The release as Anime Tosho lists it, with its files. */
  readonly release: ToshoRelease;
  /** The same release as SeaDex lists it. */
  readonly seadex: SeaDexRelease;
  readonly rank: SeaDexRank;
}

/** ISO 639-1 and 639-2/T codes to 639-2/B. */
const LANGUAGES: Readonly<Record<string, string>> = {
  fra: 'fre', deu: 'ger', zho: 'chi', ces: 'cze', nld: 'dut', fas: 'per', ron: 'rum', slk: 'slo', sqi: 'alb',
  hye: 'arm', eus: 'baq', kat: 'geo', isl: 'ice', mkd: 'mac', msa: 'may', mya: 'bur', bod: 'tib', cym: 'wel',
  ell: 'gre',
  en: 'eng', ja: 'jpn', es: 'spa', pt: 'por', fr: 'fre', de: 'ger', it: 'ita', ar: 'ara', ru: 'rus', id: 'ind',
  zh: 'chi', ko: 'kor', nl: 'dut', pl: 'pol', tr: 'tur', vi: 'vie', th: 'tha', sv: 'swe', no: 'nor', da: 'dan',
  fi: 'fin', cs: 'cze', hu: 'hun', ro: 'rum', el: 'gre', he: 'heb', uk: 'ukr', hi: 'hin', ms: 'may', fa: 'per',
  bg: 'bul', hr: 'hrv', sk: 'slo', sl: 'slv', sr: 'srp', ca: 'cat', fil: 'fil', tl: 'tgl', my: 'bur', ta: 'tam',
};

/**
 * A language code (ISO 639-1, 639-2/T or 639-2/B, with any region after `-` or `_`) as 639-2/B, lower case; a code not in the table is returned lower-cased as it is.
 * @internal
 */
export function normalizeLanguage(code: string): string {
  const c = (code.trim().toLowerCase().split(/[-_]/)[0]) ?? '';
  return LANGUAGES[c] ?? c;
}

/** 639-2/B to the two-letter code, for every code above that has one. */
const TWO_LETTER: Readonly<Record<string, string>> = Object.fromEntries(
  Object.entries(LANGUAGES).filter(([k]) => k.length === 2).map(([k, v]) => [v, k]),
);

/**
 * The tag a fansub is stored with, as owner uploads are (BCP 47): the two-letter code when there is one, else 639-2/B; `und` when empty.
 * @internal
 */
export function languageTag(code: string): string {
  const c = normalizeLanguage(code);
  if (c === '') return 'und';
  return TWO_LETTER[c] ?? c;
}

const WEB_TAG = /web/i;
const WEB_NAME = /\bWEB[- ]?(DL|Rip)?\b/i;

/**
 * Public releases only: best first, then WEB, then the rest in SeaDex's order.
 * @example ../examples/rank-releases.ts
 */
export function rankReleases(entry: SeaDexEntry): { release: SeaDexRelease; rank: SeaDexRank }[] {
  const out: { release: SeaDexRelease; rank: SeaDexRank }[] = [];
  const pub = entry.releases.filter((r) => r.infoHash !== null);
  const isWeb = (r: SeaDexRelease): boolean => r.tags.some((t) => WEB_TAG.test(t)) || r.files.some((f) => WEB_NAME.test(f.name));
  for (const r of pub) if (r.isBest) out.push({ release: r, rank: 'best' });
  for (const r of pub) if (!r.isBest && isWeb(r)) out.push({ release: r, rank: 'web' });
  for (const r of pub) if (!r.isBest && !isWeb(r)) out.push({ release: r, rank: 'other' });
  return out;
}

/** The release, file and tracks chosen for one episode. */
export interface EpisodeChoice {
  readonly candidate: Candidate;
  /** The release's file for the episode. */
  readonly file: ToshoFile;
  /** The file's ASS/SSA tracks in the wanted languages. */
  readonly tracks: readonly ToshoTrack[];
}

/**
 * Picks for each episode the first candidate (in the order given) whose file for it has ASS/SSA tracks in one of
 * `languages`. `season: null` means a movie (`episodes` is `[1]`).
 * @example ../examples/choose-per-episode.ts
 */
export function choosePerEpisode(
  candidates: readonly Candidate[],
  episodes: readonly number[],
  season: { count: number; before: number } | null,
  languages: readonly string[],
): Map<number, EpisodeChoice> {
  const wanted = new Set(languages.map(normalizeLanguage));
  const wantedTracks = (f: ToshoFile): ToshoTrack[] =>
    f.tracks.filter((t) => /^(ASS|SSA)$/i.test(t.format) && wanted.has(normalizeLanguage(t.language)));
  const out = new Map<number, EpisodeChoice>();
  for (const episode of episodes) {
    for (const candidate of candidates) {
      const files = season === null
        ? [mainFile(candidate.release.files)]
        : candidate.release.files
            .filter((f) => {
              const n = episodeOfFile(f.name);
              return n !== null && seasonEpisode(n, season) === episode;
            })
            // The highest vN, then the larger file.
            .sort((a, b) => fileVersion(b.name) - fileVersion(a.name) || b.size - a.size);
      let found: EpisodeChoice | null = null;
      for (const file of files) {
        if (file === null) continue;
        const tracks = wantedTracks(file);
        if (tracks.length > 0) { found = { candidate, file, tracks }; break; }
      }
      if (found) { out.set(episode, found); break; }
    }
  }
  return out;
}
