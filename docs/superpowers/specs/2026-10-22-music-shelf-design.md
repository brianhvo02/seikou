# Music shelf by artist: design

Status: done; on main and deployed (site and NAS, 5948459) 2026-10-22. The optional Discogs token was not yet set at deploy, so lookups started with MusicBrainz alone.

## 1. Why

The NAS title library's Music shelf (`src/ui/nas/MusicScreen.tsx`) lists one card per music release with the raw
release folder name as its headline (release date in brackets, artist, title, edition notes, `[CD]`, the rip's file
list, catalogue numbers), a second line repeating the drive and the whole folder path, and the owner's "File
differently…" as a separate row under every card. On a phone each card is four to seven lines of tags, the list has no
pictures, and the shelf chips run off the right edge. The owner looks for music by **artist** or by **concert**, so the
shelf should be organized by artist and show real names, dates and covers.

Most music discs in the library are the Blu-ray bundled with a CD release (the folder holds the CD rip and a `BDMV`).
Of the 67 music discs on the NAS today, 63 have a catalogue number in their folder name, MusicBrainz knows 43 of
those by catalogue number (39 with a Blu-ray medium and 39 with Cover Art Archive art), and most release folders hold
their own cover images (`cover.jpg`, or scans such as `Front.png`).

## 2. Goals, non-goals, anti-goals

Goals:
- The Music shelf is a grid of artists; an artist opens a page of their releases as covers; a release opens the usual
  pre-flight.
- Every release shows a clean title, its artist and year, and a cover when one can be found.
- Concerts are told apart from albums and singles on the artist page.
- Works on a phone without horizontal overflow, and on desktop as a wider grid.

Non-goals:
- A per-release page listing what is on the Blu-ray (concert, music videos). Rejected in favour of straight to the
  pre-flight; the disc's own menu picks.
- Setlists, track lists, playing the CD rip's audio files.
- Music outside the Music shelf (a series' soundtrack disc filed under its series stays there).

Anti-goals (it fails even if it works):
- Raw folder names or bracket tags as the headline anywhere a lookup or the parser found a name.
- Lookups that hammer MusicBrainz (over its one request per second) or make the library slow to open.
- A wrong lookup the owner can't correct.
- Real artist names, titles or catalogue numbers from the library in the repo (public): fixtures use made-up names.

## 3. Decided

**Layout (owner's choice A, "artists first").**
- Music shelf: a grid of artist tiles. A tile is a round collage of up to four of the artist's release covers (one
  cover fills the circle; none gives a ♪ tile), the artist's name and "N releases". Artists sort A–Z by their display
  name, with the same reading rules the series shelf uses (`title-index.ts`), and the alphabet bars (English left,
  Japanese right) index them. Search on the Music shelf matches artist names in every form known and release titles.
- **Various artists** is one tile, sorted last: compilations, soundtracks and releases with no single artist go there.
- Artist page: back to Music, the artist's name with their other-script name under it when known (for example the
  Japanese name under a romaji one), the release count, then the releases as cover cards in sections: **Concerts**,
  then **Albums & singles**, then **Other** for releases whose kind is unknown; newest first within each, undated last.
  A card shows the cover, the concert name or release title (two lines at most, ellipsis), and the year.
- Tapping a release opens the existing pre-flight for its disc (owner's choice 2). A release with more than one disc
  opens the existing title page (`TitleDetail`), which lists its discs, as today.
- The shelf chips (Series, Movies, Music, Unsorted…) scroll sideways inside their row instead of overflowing the page.
- On desktop the same grids, wider (the library's existing desktop widths).

**Sources (MusicBrainz first, Discogs optional; owner's choice).**
- MusicBrainz: looked up by catalogue number (the disc evidence's `catalogueNumbers`, already normalized), accepting a
  release only when one of its label-info catalogue numbers equals ours exactly (ignoring spaces and case). When
  several releases match exactly (re-pressings, a CD-only edition sharing the number), prefer those with a Blu-ray
  medium, then country `JP`, then the earliest date; if the ones left name different first artists, it is a miss. From it:
  release title, date, artist credit (MusicBrainz artist ids, names and aliases for the other-script name),
  release-group primary type and secondary types, media formats, and whether the Cover Art Archive has a front image.
  No key. Paced at no more than one request per 1.1 s, with a `User-Agent` naming the app and the repo URL, as
  MusicBrainz requires.
- Discogs (built now; the owner plans to add a token): only when the owner puts a `DISCOGS_TOKEN` in the NAS's `~/bluray-server/.env` (kept like the TMDB key:
  never in the repo, logs or errors). Looked up by catalogue number when MusicBrainz has no exact match. Paced within
  Discogs' limit for authenticated calls.
- Lookups run in the NAS's title service after matching, in the background, like AniList and TMDB, and are cached in
  `metadata.json` with the same refresh schedule (misses weekly, hits monthly). The library never waits for them.

**Names.** A release's title: the lookup's title, else the title parsed from its folder name. Its artist: the lookup's
artist credit, else the artist parsed from its folder name. The folder-name parser for music handles the forms in
this library: a leading date (`[YYYY.MM.DD]`, `(YYYY)`), `Artist - Title` with `-`, `–` or `—`, and bracketed tags
(`[CD]`, the rip's format list, catalogue numbers, resolution and source tags) stripped; edition notes in brackets such
as 初回生産限定盤 are dropped from the title. The concert name: the disc's own title metadata (`bdmt` names in the
evidence) when it names something other than the release title, else none, and the card shows the release title.

**Kind (Concerts vs Albums & singles).** A release is a concert when its MusicBrainz release group has the `Live`
secondary type, when Discogs' format descriptions say live, or when the disc's `bdmt` name or the folder name contains
a concert word (`live`, `tour`, `concert`, ライブ, ツアー, 公演, コンサート; whole words, case-insensitive). Otherwise an album
or single by the MusicBrainz primary type (`Album`, `Single`, `EP`) or a folder hint (`(Single)`); otherwise Other.

**Which artist name shows.** The headline is the artist's Latin-script name: the MusicBrainz name when it is in Latin
script, else its primary alias in locale `en` or `ja-Latn` (or any Latin-script alias), else the sort-name with a
`Family, Given` comma reordered to `Given Family`. `otherName` is the MusicBrainz name when that is not Latin script
(the Japanese name), else null. Sorting and the alphabet bars use the headline as the romaji name and `otherName` as
the native name, as `title-index.ts` does for series, so a kanji artist still lands under its reading. Without a lookup,
the parsed folder artist is the headline and `otherName` is null.

**A release with several discs.** The first disc of the release (path order) with a lookup match speaks for the
release; owner actions on a release write to every disc of it.

**Artist grouping.** Releases group by MusicBrainz artist id when the lookup found one (the first artist of the
credit). Releases without one group by their artist name, normalized (Unicode NFKC, case-folded, spaces and the
separators `・`, `·` collapsed), and join a MusicBrainz artist whose name or alias normalizes the same. Various artists:
the MusicBrainz "Various Artists" artist, a release group with the `Soundtrack` or `Compilation` secondary type, or no
artist found at all.

**Covers.** In order: an image in the release folder; the Cover Art Archive front image (its 500 px thumbnail); the
Discogs primary image (only with a token); else no cover (the client draws the ♪ tile). A folder image is chosen by
name, first match wins: `cover`, `front`, `folder`, `jacket`, `jk` (any case, then any extension of jpg, jpeg, png,
webp), then the first such image at the top of the release folder. Folder images are read from the read-only mount
and served by the NAS without resizing (the server has no native dependencies), so a file over the art cache's 5 MB
body limit is skipped for the next source. The art allowlist (`ART_HOSTS` in `server/src/titles/art.ts`) gains the
Cover Art Archive's hosts (`coverartarchive.org` and the `archive.org` hosts it redirects to) and, with a token,
`i.discogs.com`. Covers are served through the existing `GET art/<id>` route as art ids, never source URLs or paths.

**Owner corrections.** Owner actions on a release move into a "⋯" menu on its card: Rename (as today), **Set artist**
(pick an existing artist or type a name; also "Various artists"), **Not this release** (the lookup matched the wrong
release: the match is dropped for good, so no refresh brings it back, and the release falls back to its parsed folder
name and folder cover; offered only when a lookup matched; an owner can undo it from the same menu), and File
differently… (as today). The set artist and the rejected match are stored in the music choice of every disc of the
release in `owner.json` (`{ kind: 'music', name, artist, rejectMatch }`; `artist` null to clear; `rejectMatch` true),
so they follow the discs when their folder moves, like the name does today, and win over any lookup. Rename, Set artist
and Not this release are the only corrections (owner's choice); there are no per-field overrides for date, kind or
cover.

**API.** Music titles stay one title per release (as today). `TitleSummary` gains, for music titles only, a `music`
field: the artist (`id`: the MusicBrainz id or a stable id derived from the normalized name, or `various`; `name`;
`otherName` or null), the kind (`concert`, `album`, `single`, `other`), the date (`YYYY`, `YYYY-MM` or `YYYY-MM-DD`,
or null) and the concert name (or null). The poster is the release cover's art id. The client builds the artist grid
and pages from the Music shelf's titles; no new list route. The route for an artist page lives under `/nas/…`
(`nas-route.ts`), so Back and links work as on the other screens.

## 4. Constraints

- The NAS server keeps no native dependencies and writes only under `/data`; library mounts are read-only.
- MusicBrainz's rate limit and `User-Agent` rule; Discogs' token stays in `.env`.
- The public repo rule: fixtures, tests and recorded API answers use made-up artists, titles and catalogue numbers.
- Supported browsers and touch as for the rest of the library; no user-agent sniffing.
- The `TITLE_LIBRARY` gate applies to music as to every title route.

## 5. Left to the builder

- Module layout on the server (for example `server/src/titles/musicbrainz.ts`, `discogs.ts`, a music name parser next
  to `parse-name.ts`) and on the client (an artist grid component and an artist page, replacing `MusicScreen`'s list).
- The stable id derived for an artist without a MusicBrainz id, and the art id scheme for folder images.
- How the "Set artist" picker looks, within the owner screens' existing form style.
- Collage drawing (CSS grid of up to four covers is enough).
- Test shape, following the existing title-matching tests and the NAS E2E stand-in's recorded-answer pattern.

## 6. Calls made without the owner (check these)

- C1. Various artists also holds soundtracks and compilations (the owner said "various artists" for releases that
  aren't by one artist).
- C2. The alphabet bars and search cover the artist grid.
- C3. The concert name comes from the disc's own title metadata; the databases don't reliably name the Blu-ray's
  concert.
- C4. Folder images over 5 MB are skipped rather than resized, because the server can't resize.
- C5. A release with more than one disc opens its title page instead of the pre-flight.
- C6. Owners can set a release's artist, and that wins over the lookup.
- C7. Several exact catalogue matches: Blu-ray first, then Japan, then earliest; disagreeing artists make it a miss.
- C8. The first disc with a match speaks for a multi-disc release; owner actions write to all its discs.
- C9. The headline artist name is the Latin-script one, with the Japanese name under it, as series show.
