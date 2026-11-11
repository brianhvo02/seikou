# @seikou/titles

Naming a disc library. The package turns folder names and disc evidence into titles, seasons, episodes and music releases, looks them up on public metadata sources, and builds the catalogue a player shows. It is used by Seikou's NAS server. Most of it is pure functions; the parts that keep files on disk (`ArtCache`, `OwnerStore`, the atomic-write helpers) use Node's `node:` modules.

## Modules

All sources are in `src/`. The package root exports the names listed in `public-api.txt`; every module can also be imported by path (`@seikou/titles/<module>`), and what the root leaves out is internal and can change without notice.

- Name parsing: `parse-name` (`parseName`) reads titles, seasons, volumes and discs from a folder name or disc title, and gives an empty candidate or a null number when it is unsure. `music-name` (`parseMusicFolder`) reads a music release folder (date, artist, title, catalogue number, concert hint). `corpus` (internal) is the made-up set of names that pins the parser's behaviour.
- Metadata sources: `anilist` (`createAniList`), `tmdb` (`createTmdb`), `discogs` (`createDiscogs`) and `musicbrainz` (`createMusicBrainz`) are the clients. `sources` holds the shared `Entry` and `MetadataSource` types, `music-sources` the rule that chooses one release among candidates, and `pacer` (`Pacer`) the rate limiting each client uses.
- TheDiscDB: `discdb` (`loadDiscDb`, `indexDisc`) matches a disc's content hash against the bundled index of titles and episodes.
- Matching: `disc-evidence` is what a disc's files and path say about it. `match` (`matchDiscs`) groups discs by parent folder, looks them up, and files a disc only when the acceptance rules hold; everything else goes to Unsorted with a reason. `episodes` (`guessEpisodes`) guesses an episode list from playlist lengths, and answers null when unsure.
- Catalogue: `catalogue` (`buildCatalogue`) builds titles, seasons, disc slots, episodes, extras, Music, Unsorted and Hidden from matches, metadata and the owner's choices, with no network access. `music-info` decides a release's artist, kind and names. `owner-store` (`OwnerStore`) keeps the owner's choices, own titles and gate in `owner.json`.
- Encodes: `encode-catalogue` groups the NAS's encoded episodes into shows, and `encode-next` (`nextInShow`) is the one rule for the episode after another.
- Resume: `up-next` (`continueWatching`, `titleProgress`) works out Continue watching and per-title progress from a person's places and the catalogue.
- Storage: `art` (`ArtCache`) caches posters and banners within a byte budget at the sources' own sizes. `atomic-json` has the lock and atomic-replace helpers the stores use; the root exports `replaceAtomically`.

## What a consumer provides

- A `fetch` for each metadata client.
- The key or token a source needs: TMDB's API key (`createTmdb`), and Discogs's token (`createDiscogs`, used only when you have one).
- A contact string for the MusicBrainz and Discogs `User-Agent` (`lookupUserAgent`).
- Pacing: wrap calls in a `Pacer` at each service's limit (AniList `new Pacer(30, 60_000)`, TMDB `new Pacer(20, 1_000)`, Discogs `new Pacer(50, 60_000)`, MusicBrainz `new Pacer(1, 1_100)`).
- A directory for `ArtCache` and `OwnerStore`.

The key goes only in the request parameter that TMDB expects, and the clients' errors never carry the URL, the response or a cause.

## Usage

```ts
import { createAniList, Pacer, parseName } from '@seikou/titles';
```

`parseName` and `parseMusicFolder` need nothing else. The catalogue pipeline runs in this order: `matchDiscs` over the discs and their evidence, then `buildCatalogue` over the matches, the metadata entries and the owner's choices.

## Documentation and references

Links to repository files are relative to the Seikou repository.

- Using the packages in your own page or tool: the integration guide, [`docs/integrating.md`](../../docs/integrating.md).
- Library titles, matching and the catalogue: [`docs/superpowers/specs/2026-10-17-nas-library-titles-design.md`](../../docs/superpowers/specs/2026-10-17-nas-library-titles-design.md).
- Music: [`docs/superpowers/specs/2026-10-22-music-shelf-design.md`](../../docs/superpowers/specs/2026-10-22-music-shelf-design.md).
- Continue watching and Up next: [`docs/superpowers/specs/2026-10-20-permalinks-resume-design.md`](../../docs/superpowers/specs/2026-10-20-permalinks-resume-design.md).
- Encodes catalogue: [`docs/superpowers/specs/2026-11-08-encodes-library-design.md`](../../docs/superpowers/specs/2026-11-08-encodes-library-design.md).
- The wire types it builds on: [`packages/nas`](../nas/README.md). For the NAS title library as a user sees it, see [`docs/nas.md`](../../docs/nas.md).
- AniList API: https://docs.anilist.co
- TMDB API: https://developer.themoviedb.org
- MusicBrainz API: https://musicbrainz.org/doc/MusicBrainz_API
- Discogs API: https://www.discogs.com/developers
- TheDiscDB data: https://github.com/TheDiscDb/data
