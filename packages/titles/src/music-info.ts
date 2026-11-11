/**
 * The pure decision for one music release: its artist (grouping id, headline name, native name), kind, date, title and
 * concert name, from the folder name, the disc's evidence, a source lookup and the owner's choices. Original code.
 */
import { normalizeTitle } from '@seikou/nas/title-text';
import type { MusicKind, TitleMusic } from '@seikou/nas/nas-api';
import type { DiscEvidence } from './disc-evidence';
import { hasConcertWord, parseMusicFolder } from './music-name';
import { VARIOUS_ARTISTS_MBID, type MusicArtist, type MusicRelease } from './music-sources';

/**
 * The grouping id of Various artists.
 * @internal
 */
export const VARIOUS_ID = 'various';
const VARIOUS_NAME = 'Various artists';

/**
 * Grouping key of an artist name: NFKC, case-folded, `・`, `·` and runs of spaces collapsed to one space, trimmed.
 * @internal
 */
export function artistKey(name: string): string {
  return name.normalize('NFKC').toLowerCase().replace(/[・·\s]+/g, ' ').trim();
}

const isVariousName = (name: string): boolean => {
  const k = artistKey(name);
  return k === VARIOUS_ID || k === artistKey(VARIOUS_NAME);
};

const NON_LATIN = /[^\p{Script=Latin}\p{N}\p{P}\p{S}\s]/u;
const isLatin = (s: string): boolean => s.length > 0 && !NON_LATIN.test(s);

type ArtistInfo = TitleMusic['artist'];

const various = (): ArtistInfo => ({ id: VARIOUS_ID, name: VARIOUS_NAME, otherName: null });
const named = (name: string): ArtistInfo => ({ id: 'name:' + artistKey(name), name, otherName: null });

function reorderSortName(sort: string | null): string | null {
  if (!sort) return null;
  const parts = sort.split(',');
  return parts.length === 2 ? `${parts[1]!.trim()} ${parts[0]!.trim()}` : sort.trim();
}

function fromMusicArtist(a: MusicArtist): ArtistInfo {
  const id = a.id ? a.id : 'name:' + artistKey(a.name);
  if (isLatin(a.name)) return { id, name: a.name, otherName: null };
  const latinAlias =
    a.aliases.find((x) => x.primary && (x.locale === 'en' || x.locale === 'ja-Latn') && isLatin(x.name)) ??
    a.aliases.find((x) => isLatin(x.name));
  const sort = reorderSortName(a.sortName);
  const headline = latinAlias?.name ?? (sort && isLatin(sort) ? sort : null);
  return headline ? { id, name: headline, otherName: a.name } : { id, name: a.name, otherName: null };
}

/** Decides a release's music info. `lookup` is ignored when `rejectMatch` is set. */
export function musicInfo(o: {
  releaseFolder: string;
  parentFolder: string | null;
  evidence: readonly DiscEvidence[];
  lookup: MusicRelease | null;
  ownerArtist: string | null;
  rejectMatch: boolean;
}): TitleMusic {
  const parsed = parseMusicFolder(o.releaseFolder);
  const lookup = o.rejectMatch ? null : o.lookup;
  const title = releaseTitle(lookup, parsed.title, o.releaseFolder, o.evidence);
  const discNames = o.evidence.flatMap((e) => e.discTitles.map((t) => t.name));

  let artist: ArtistInfo;
  const owner = o.ownerArtist?.trim();
  if (owner) {
    artist = isVariousName(owner) ? various() : named(owner);
  } else if (lookup) {
    const first = lookup.artists[0];
    if (first?.id === VARIOUS_ARTISTS_MBID || (first && isVariousName(first.name)) || lookup.secondaryTypes.some((t) => t === 'Soundtrack' || t === 'Compilation')) artist = various();
    else if (first) artist = fromMusicArtist(first);
    else artist = parsed.artist ? named(parsed.artist) : fromParent(o.parentFolder);
  } else {
    artist = parsed.artist ? named(parsed.artist) : fromParent(o.parentFolder);
  }

  let kind: MusicKind;
  if (lookup?.live || discNames.some(hasConcertWord) || hasConcertWord(o.releaseFolder)) kind = 'concert';
  else if (lookup?.primaryType === 'Single') kind = 'single';
  else if (lookup?.primaryType === 'Album' || lookup?.primaryType === 'EP') kind = 'album';
  else if (parsed.single) kind = 'single';
  else kind = 'other';

  const wanted = normalizeTitle(title);
  const concertName = discNames.find((n) => n.trim() !== '' && normalizeTitle(n) !== wanted)?.trim() ?? null;

  return { artist, kind, date: lookup?.date ?? parsed.date, concertName, title, matched: lookup !== null, rejected: o.rejectMatch };
}

/**
 * The lookup's title, else the parsed one; when both are empty (a folder named only by tags, such as `[ZQCL-2468]`),
 * the release folder's name, and failing that the first disc's folder name.
 */
function releaseTitle(lookup: MusicRelease | null, parsed: string, releaseFolder: string, evidence: readonly DiscEvidence[]): string {
  const disc = evidence[0]?.path?.split('/').pop()?.replace(/\.iso$/i, '') ?? '';
  for (const t of [lookup?.title, parsed, releaseFolder, disc]) {
    const s = t?.trim();
    if (s) return s;
  }
  return '';
}

function fromParent(parent: string | null): ArtistInfo {
  const p = parent?.trim();
  return p && p.toLowerCase() !== 'music' ? named(p) : various();
}
