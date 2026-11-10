# Encoder Library by show: Design

Date: 2026-11-10
Status: Approved by the user 2026-11-10 (brainstorm, builder check and the user's answers done)
Parents: `2026-11-08-encoder-nas-design.md` (NAS discs in the Library, the NAS destination, chapter names and AniList choices per disc and playlist), Seikou's NAS title library (`docs/superpowers/specs/2026-10-17-nas-library-titles-design.md`) and Encodes library (`docs/superpowers/specs/2026-11-08-encodes-library-design.md`).

## 1. Intent

The encoder app's Library lists NAS discs by folder path. The NAS has already sorted the same discs into shows, seasons, films and episodes, matched to AniList, and its Encodes library knows which episodes are already encoded. The user opens the Library to find "all the above": a particular show, a season not yet encoded, "and shows I might not have sorted yet". Asked what should happen once a season is picked: "I just want to encode them." Asked whether to trust the NAS's episode list: "I need to check first."

So the Library should be organised the way the NAS organises the discs, show what is left to encode, and get from a season to a queued NAS encode with one required step: checking each disc.

## 2. Goals, non-goals, anti-goals

Goals (the user approved the mockup and each playback; *designer's call* marks what Claude proposed and the user accepted without discussing it separately):
- **Library by show.** The Library opens on the NAS's shows: poster, name, seasons and films, disc count, and how many of its episodes are already in the Encodes library. A switch keeps the by-folder view of the NAS and the discs on this Mac.
- **Unsorted discs.** Discs the NAS has not filed under a show are listed in their own group under the shows, and open as discs open today.
- **A season, disc by disc.** Opening a season lists its discs. Each disc shows its playlist and its episodes (number, name), each marked **Encoded** (already in the NAS's Encodes library, matched by title and episode number; designer's call) or **To encode**. A show or season the NAS filed under TMDB or an own title is listed like any other; its Encoded marks come from encodes tagged with that title.
- **Check before queueing (the user's requirement).** Each disc with episodes to encode has **Check episodes**, which opens the existing Episodes page for that disc and playlist with the NAS's episode grouping and AniList entry and numbers filled in, for the user to confirm or fix. **Queue** for the season stays disabled until every disc with episodes to encode is checked.
- **Queue.** Queues only the episodes not yet encoded, to the NAS (Encodes library) destination, one job per disc and playlist (designer's call). A disc that gives each episode its own playlist is checked once as a disc and queued as one job per playlist (designer's call). Queue opens the existing queue dialog set to the NAS destination, so the settings profile is picked there (designer's call).
- **Saved subtitles go with it** (the user: "Saved subtitles will be injected into workflow, no?"). A disc's subtitles chosen in the helper are used for the episodes queued. The queue today refuses a job whose episode list differs from the saved record's (409 `record-mismatch`); queueing only the not-yet-encoded episodes must keep using the record for those episodes (for instance by queueing the record's full episode list and encoding only the ones still to do).
- **Shows not on AniList** (the user: "I want mixed search like bluray, TMDB included. Otherwise, manual entry (required)."). Checking a disc offers one title search over AniList and TMDB, as the player's "file differently" search does on the NAS. When neither has the show, the user enters it by hand (name, season, episode numbers), and an entry is required before the disc counts as checked. This means encodes are no longer AniList-only: the Encodes library (Seikou's NAS, `docs/superpowers/specs/2026-11-08-encodes-library-design.md`) must file, list and group encodes tagged with a TMDB id or with a hand-entered title as well as an AniList id, and the encoder writes those tags. That is a change to the Encodes library as well as to the encoder.
- **Films and OVAs** work like a season: check the disc (usually one playlist), then queue (the user: "works for me").
- **Fixing the NAS's match (the user: "both").** When the user changes a disc's title (AniList, TMDB or hand-entered) while checking it, the change is used for the encode **and** saved on the NAS as the owner's choice for that disc, as the player's "file differently" does, so the NAS re-files it and the player's Discs tab shows it under the right show. It is written when the disc is marked checked, and only when all its episodes are under one title that differs from the NAS's match; a disc whose episodes span two titles writes nothing, and the page says so (designer's call). A choice the encoder saved for the disc before this feature wins over the NAS's match when the page opens (designer's call).
- **Checked stays checked** (designer's call): saved with the disc's chapter names and AniList choices (`<data>/chapters/<disc key>/<playlist>.json`), until the episode grouping or the AniList entry changes, which clears it.
- **No episode list on the NAS** (designer's call): when the NAS knows the show but not which episodes a disc holds, checking it means grouping its chapters on the Episodes page as today, with the AniList entry filled in.
- **Chapter names and subtitles stay optional**, as now.

Non-goals:
- Sorting discs on this Mac into shows: only the NAS sorts; "This Mac" stays by folder (designer's call).
- Editing the NAS's library beyond the one disc choice above (titles, names, hiding discs stay in the player's owner screens).
- Queueing without checking.

Anti-goals:
- An episode queued that is already in the Encodes library.
- A disc queued that the user never checked.
- The encoder silently changing the NAS's library: the NAS is written only when the user changes a disc's AniList entry, and the change is visible in the Episodes page as it is made.

## 3. The user's flow

1. Library → By show (the default for a paired NAS) → a show.
2. The show: its seasons and films, each with Encoded/To encode counts.
3. A season: disc by disc, episodes marked; Check episodes on each disc still to encode.
4. The Episodes page, prefilled from the NAS: confirm (or regroup, rename chapters, change the AniList entry) → back to the season, the disc now checked.
5. Queue N episodes to the NAS → the Queue page as today.

## 4. Constraints

- Everything in the parent designs holds (local-only app on 127.0.0.1 with its token, the NAS API the only way in, no token in the page, logs or job `cli`; LGPL-3.0-or-later; made-up names in tests).
- The NAS's existing routes are used where they fit (`GET titles`, `GET titles/<id>` with seasons, disc slots and `episodes` as `{ number, name, discId, playlistId }`; `GET encodes/shows` and show detail for what is encoded; the owner's `GET admin/unsorted` and `PUT admin/discs/<id>/choice` for unsorted discs and the "file differently" choice). The encoder is an owner device, so the owner routes are open to it. A new NAS route is added only if one of these can't answer what is needed.
- The Library page keeps the app's look (dark only, `encoder/web/src/styles.css`), and any UI work loads the `frontend-design` skill first. The accepted mockup is `.superpowers/brainstorm/25830-1794293197/content/library-by-show.html` (local, not committed).

## 5. What is left to the builder

- How the encoder reads the NAS's catalogue (the routes above, cached the way `NasLibrary` caches manifests) and how a title's disc slots map to the encoder's mirror keys (disc id → key, as `NasLibrary` already does).
- How the NAS's episode-to-playlist list becomes the Episodes page's prefilled grouping and AniList numbers when one playlist holds several episodes (the NAS gives episodes per playlist, the encoder groups chapters): split by the NAS's episode count over the playlist's chapters where the counts divide evenly, else leave the grouping to the user.
- How a changed AniList entry maps to the NAS's choice shape (`{ kind: 'title', titleId, season, disc }`).
- The show and season pages' layouts within the accepted mockup; where "checked" shows.

## 6. Deferred

- Sorting discs on this Mac into shows.
- Queueing a whole show (all seasons) at once.
