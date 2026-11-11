// SPDX-License-Identifier: LGPL-3.0-or-later
// @seikou/titles: library naming and metadata. Everything else is internal, reached through ./*.

// Reading titles, seasons and discs from a folder name or disc title.
export { parseName, type ParsedName } from './parse-name';
// Reading a music release folder's name.
export { parseMusicFolder, type ParsedMusicName } from './music-name';
// The AniList client.
export { createAniList } from './anilist';
// The TMDB client.
export { createTmdb } from './tmdb';
// The Discogs client.
export { createDiscogs } from './discogs';
// The MusicBrainz client.
export { createMusicBrainz } from './musicbrainz';
// What the metadata clients share: entries, the source interface, errors and the User-Agent.
export {
  type Entry,
  type EntryNames,
  type SourceName,
  type MetadataSource,
  SourceUnavailable,
  lookupUserAgent,
} from './sources';
// Choosing one release among candidates.
export {
  chooseRelease,
  type ReleaseCandidate,
  type MusicRelease,
  type MusicArtist,
  type MusicSource,
} from './music-sources';
// Rate limiting.
export { Pacer, type PacedOptions, RateLimited } from './pacer';
// TheDiscDB's bundled index.
export { loadDiscDb, indexDisc, type DiscDbHit } from './discdb';
// What a disc's files and path say about it.
export type { DiscEvidence } from './disc-evidence';
// Filing discs under titles.
export { matchDiscs, type MatchContext, type MatchResult, type DiscMatch } from './match';
// Guessing an episode list from playlist lengths.
export { guessEpisodes } from './episodes';
// Building the catalogue from matches, metadata and the owner's choices.
export { buildCatalogue, type Catalogue, type CatalogueInput, type FolderCover } from './catalogue';
// A release's artist, kind and names.
export { musicInfo } from './music-info';
// The owner's choices, own titles and gate.
export { OwnerStore, type OwnerSnapshot, type ChoiceOrigin } from './owner-store';
// Grouping encoded episodes into shows.
export { buildEncodeCatalogue, type EncodeCatalogue, type EncodeEntryLike, type EncodeNames } from './encode-catalogue';
// The episode after another.
export { nextInShow } from './encode-next';
// Continue watching and per-title progress.
export { continueWatching, titleProgress, type DiscsOf } from './up-next';
// The poster and banner cache.
export { ArtCache, type ArtCacheOptions } from './art';
// Replacing a file atomically.
export { replaceAtomically } from './atomic-json';
