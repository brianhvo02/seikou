// SPDX-License-Identifier: LGPL-2.1-or-later
export type { DiscEvidence } from './disc-evidence';

export { createAniList } from './anilist';
export { createTmdb } from './tmdb';
export { createDiscogs } from './discogs';
export { createMusicBrainz } from './musicbrainz';

export { SourceUnavailable, retryAfterMs, sharperPoster, withSharperPoster, lookupUserAgent } from './sources';
export type { SourceName, EntryNames, Entry, MetadataSource } from './sources';
export { Pacer, RateLimited } from './pacer';
export type { PacedOptions } from './pacer';

export { loadDiscDb, discDbKind, indexDisc, mergeIndex } from './discdb';
export type { DiscDbHit, DiscDbIndex } from './discdb';

export { buildCatalogue, artIdOf, byDiscPath, musicGroupOf, releaseLookup, folderCoverArtId } from './catalogue';
export type { Catalogue, CatalogueInput, FolderCover } from './catalogue';

export { MATCH_RULES_VERSION, CIRCUIT_BREAKER, groupKey, matchDiscs, musicRelease } from './match';
export type { DiscMatch, MatchContext, MatchResult } from './match';
export { guessEpisodes } from './episodes';
export { continueWatching, titleProgress, CONTINUE_LIMIT } from './up-next';
export type { ContinueItem, PlaylistProgress, DiscsOf } from './up-next';
export { parseName, isTagWord } from './parse-name';
export type { ParsedName } from './parse-name';
export { parseMusicFolder, hasConcertWord } from './music-name';
export type { ParsedMusicName } from './music-name';
export { VARIOUS_ARTISTS_MBID, normalizeCatalogue, chooseRelease, fixtureMusicSource } from './music-sources';
export type { MusicArtist, MusicRelease, MusicSource, ReleaseCandidate } from './music-sources';
export { VARIOUS_ID, artistKey, musicInfo } from './music-info';
export { NAME_CORPUS } from './corpus';

export { ArtCache } from './art';
export type { ArtCacheOptions } from './art';
export { OwnerStore } from './owner-store';
export type { OwnerSnapshot, ChoiceOrigin } from './owner-store';

export { lockFile, replaceAtomically, syncDir, writeSynced, isCode, LockHeldError } from './atomic-json';
