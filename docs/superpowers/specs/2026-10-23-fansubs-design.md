# Fansubs from SeaDex and Anime Tosho: design

Status: done, 2026-10-23; merged (08d0cdd) and deployed to the NAS the same day.

## 1. Why

The owner watches anime from the NAS with "the best fansubs possible", as SeaDex (seadex.moe) ranks them. Today that
means finding the release, pulling the subtitle tracks and fonts out of its MKV and uploading them through the
subtitle store (piece 3 of `2026-10-20-permalinks-resume-design.md`) episode by episode. Anime Tosho
(animetosho.net) already extracts the subtitle tracks and fonts of public anime releases, so the NAS can do all of it:
SeaDex says which release, Anime Tosho supplies its subtitles and fonts, and the NAS lines each episode up with the
owner's own Blu-ray and attaches it for everyone.

The NAS library has 242 titles filed under AniList entries (877 discs). SeaDex is keyed by AniList id, and the
catalogue already gives each season its own AniList entry and each episode a disc and playlist.

Dropped from this work: local fonts (`queryLocalFonts()`, deferred from M4b). The owner gets fonts from Anime Tosho,
the API is Chrome and Edge only, and the owner has no case left for it.

## 2. Goals, non-goals, anti-goals

Goals:
- For an AniList title on the NAS, the NAS finds the SeaDex-ranked release, fetches its English subtitle tracks (all
  of them: full, signs & songs, honorifics…) and the release's fonts from Anime Tosho, lines every episode up with the
  owner's disc, and attaches them in the subtitle store. Everyone paired sees them under "From the NAS".
- It runs by itself (a nightly pass after the library scan, over titles not done yet) and on demand (a button on the
  title). Nightly results are attached at once; the owner reviews afterwards.
- The owner sees, per episode, what was attached and how well it lined up, and fixes a bad one by hand.
- A viewer whose episode has nothing attached can search Anime Tosho from the player's Subtitles menu, pick a release
  and track, and play it lined up with their disc. That pick is theirs only.

Non-goals:
- Local fonts.
- Private trackers (AB, BeyondHD…). SeaDex redacts their hashes and Anime Tosho doesn't mirror them.
- Titles not filed under an AniList entry (TMDB-matched anime, Unsorted) in the owner flow. The viewer search works on
  any NAS disc.
- Fetching video or whole torrents. Only Anime Tosho's extracted subtitle tracks and font packs are downloaded.

Anti-goals: the owner named none. The constraints in §3 stand.

## 3. Constraints

- **The NAS server keeps no native dependencies** (CLAUDE.md). xz (subtitle tracks) and 7z (font packs) are decoded in
  pure JS or WASM, or by a binary bundled in the image and spawned like ffmpeg. Never a Node addon.
- **Library mounts stay read-only.** Everything fetched or derived goes under `/data`.
- **The repo is public.** No real titles, groups or releases in tests, fixtures, docs or commits. Recorded API answers
  for tests are made up (as `METADATA_FIXTURE` and `MUSIC_FIXTURE` are), e.g. a made-up "Starfall Wanderer" with made-up
  groups.
- **Be a polite client.** Both services are volunteer-run with no published terms. Anime Tosho's operator says the API
  is public with no key and no limits; its `robots.txt` disallows `/download/` and `/storage`. The NAS paces requests
  (at most one every 2.5 s to each service, through the existing `Pacer`), sends the `lookupUserAgent` User-Agent
  (with `LOOKUP_CONTACT`), caches everything it fetched, and never fetches the same file twice.
- **Services can go away.** The original animetosho.org stopped in May 2026 and its storage is gone; animetosho.net is
  its successor. Base URLs are settings with today's values as defaults, and a dead service turns into "not found"
  with a reason, never a broken screen.
- **Supported browsers** as in CLAUDE.md, phone layouts included.

## 4. The services (as found on 2026-10-23)

SeaDex: `GET https://seadex.moe/api/collections/entries/records?filter=alID=<anilist id>&expand=trs` (PocketBase;
releases.moe redirects here). An entry has `notes`, `incomplete`, and `expand.trs[]`, each with `tracker`, `url`,
`infoHash` (`<redacted>` on private trackers), `isBest`, `dualAudio`, `releaseGroup`, `tags` and `files[]`
(`{name, length}`). `isBest` is not always set on any release.

Anime Tosho: `GET https://feed.animetosho.net/json?show=torrent&btih=<infohash>` (also `nyaa_id=`, and `?q=` to search)
gives a release with `status`, `files[]`, and per file `attachments[]`: subtitle tracks (`type: "subtitle"`,
`info.format`, `info.language_code`, `info.name`, `default`, `forced`) with a `url` to an `.ass.xz` on
storage.animetosho.net. Fonts are not listed per file; the per-file pack
`https://animetosho.net/download/file/<fileId>/attachments` (a path its `robots.txt` asks crawlers to avoid; the
owner approved fetching each pack once, only when an episode is being attached or picked, paced and cached for good)
redirects to a `.7z` holding every attachment (fonts, the
subtitle tracks, chapters). The pack is missing on some releases. Anime Tosho skips most torrents over 25 GB, so many
SeaDex-best Blu-ray batches have no files there. Neither service gives an episode number per file in a batch.

`feed.animetosho.net` answers with `Access-Control-Allow-Origin: *`; storage and download links don't, so the browser
can't fetch the files. All fetching goes through the NAS.

## 5. Choosing the release

For one AniList entry (a season, or a movie), the NAS takes SeaDex's public releases (Nyaa and other public trackers
with a real hash) and looks each up on Anime Tosho by hash, in this order, stopping at the first that has subtitle
tracks for the season's episodes:

1. the release SeaDex marks best;
2. the WEB release SeaDex lists for the entry (the owner: "SeaDex's best picks usually pair up with a WEB release");
   these are per-episode and small enough for Anime Tosho;
3. the other releases SeaDex lists, best first.

This happens per episode, not per title: when the chosen release lacks an episode, that episode falls through the list
on its own. Fonts come from the font pack of the file the subtitles came from; when that pack is missing, from the pack
of the same group's other release of that episode if SeaDex lists one, else the episode is attached without fonts and
says so.

Files are matched to episodes by name (`S01E05`, `- 05`, `E05`, `第05話`…, version suffixes like `v2`), leaving out
`NCOP`, `NCED`, `PV`, `Extras/` and similar. A file name that gives no episode number is skipped. Episode numbers are
the season's own numbers in the catalogue (`EpisodeRef.number`); a release numbered absolutely across seasons (13–24
for season 2) is mapped by subtracting the earlier seasons' episode counts when the numbers run past the season's
count. A movie is one episode: the release's single main file.

## 6. Lining up

A track from a release other than the owner's disc can be offset from it (a different encode, a WEB timing, a recap or
eyecatch added or cut). The NAS lines every fetched track up with the episode on the owner's disc, from the audio, the
way ffsubsync and alass do:

- ffmpeg (already in the image) decodes the episode's audio from the disc (the episode's playlist, its clips in order,
  read through the same disc readers as the quality levels, so ISOs work) to mono at a low rate, and the NAS finds
  where speech is.
- **Sampled, not whole (owner's choice).** Audio on a Blu-ray is interleaved with the video, so the whole episode is
  5–8 GB of reads. The NAS reads only a handful of short stretches spread across the episode (through the EP map, under
  1 GB in all) and reads the whole episode only when the stretches disagree on the offset (what a cut looks like). A
  cut that falls between sampled stretches can be missed; the owner accepts that trade.
- The track's dialogue events (not signs, which have no speech) give where speech should be.
- The NAS finds the best single offset, then whether splitting the episode at one or more cuts fits clearly better
  (alass-style), and how confident each answer is.
- The aligned track is a rewritten copy of the ASS with every event's times shifted (per part, when split). The
  original track is kept beside it so the owner can go back or line up again.
- The result per track is one of: lined up (with its offset when it isn't 0), split at the given times (marked for a
  check), or couldn't line up (attached unshifted, marked for the owner to set by hand).

Tracks of one file share the offset or split found for that file's main dialogue track (a signs-only track has too
little speech to line up on its own).

The confidence thresholds, the speech detector and the search are the builder's, tested against tracks whose true
offset is known (a made-up subtitle shifted by known amounts over a synthetic disc's audio, and the owner's real
episodes checked locally, never committed).

## 7. On the NAS

- **When it runs.** At night only, after the library scan, pausing while anyone is playing a disc or a quality level
  is encoding, and resuming after: a pass over AniList titles not done yet, one title at a time, at
  the pacing of §3. A title is done once a fetch for it has run to the end, whatever it found. Titles where nothing at
  all was found are tried again monthly (Anime Tosho processes releases late, and fansubs appear later). The owner's
  button runs a title at once, ahead of the nightly queue, done or not.
- **What it attaches.** Each English track becomes one stored subtitle (`StoredSubtitle`) attached to its episode
  (as owner uploads are, so it follows the episode), carrying the disc key and playlist it was lined up on. When the
  episode later resolves to another disc or playlist (a rematch, a replaced disc, a second copy), the track is marked
  "lined up on another disc" for the owner and the next run lines it up again; it is not hidden. Named
  as the release names the track (e.g. "GroupB · Full"), language from the track, offset 0 (the alignment is in the
  file). Tracks in other languages are attached too when the owner has ticked them in a NAS setting (languages to
  fetch, English by default). Subtitles the owner uploaded stay; fansub tracks are attached alongside them.
- **Running again.** A new run replaces fansub subtitles per episode, only on episodes where it found tracks; an
  episode where it found nothing keeps what it had. "The same track" is the same Anime Tosho file and track number;
  when it comes back, the owner's edits to it (name, language, manual offset) are kept. A fansub track the owner deleted
  is remembered (by file and track) and not attached again, until the owner presses "Find fansubs again", which asks
  whether to bring deleted tracks back.
- **What the store learns.** A stored subtitle gains where it came from: the source (`upload` or `fansub`), and for a
  fansub the release (group, tracker, SeaDex rank: best, WEB, other), the Anime Tosho file and track, and the
  alignment result (offset or split times, confidence, or couldn't). Per title, the NAS keeps when it last ran and the
  release used per season, for the owner's line on the screen.
- **Room.** Fonts are shared: a font is kept once per content hash, whatever number of tracks and episodes use it
  (fansub packs repeat the same fonts on every episode). Fansub files and fonts count against their own budget
  (`FANSUB_STORE_BYTES`, default 20 GB), not the 2 GB of owner uploads. The 5 MB per-file limit doesn't apply to fetched
  tracks (one real track was 33 MB uncompressed); a fetched track over 50 MB is skipped with a reason.
- **Cache.** Downloads (the `.ass.xz` tracks and `.7z` packs) are cached under `/data` with their decoded contents, so
  a second run, a second track of the same file or a viewer's pick never fetches again. The cache has a byte budget
  and drops the least recently used.
- **Routes** (owner only, behind the device token): run a title now; a title's fansub state (per season: release line,
  last run, per episode the tracks and their marks). The existing subtitle routes keep working on fansub subtitles
  (edit the offset, delete).

## 8. Owner screens

On the season screen (and the movie screen), layout A of the mockups:

- Above the episode list, a line naming the release and where the subtitles came from, e.g. "Fansubs: GroupA (SeaDex
  best) · subtitles from GroupB WEB · checked last night", and a button: "Find fansubs" on a title never run, "Find
  fansubs again" after. While it runs, the line says so and the rows fill in as episodes finish.
- Each episode row shows its fansub tracks as chips (Full, Signs, Honorifics…) and one mark: "lined up", "lined up ·
  +1.2 s", "split at 11:40 · check" (amber), "couldn't line up · set by hand" (red), "no fonts", or "not found".
- Tapping a row opens its tracks with the offset editor the subtitle store already has, plus two actions per
  episode: "Line up again" (runs §6 on that episode now) and "Use original timing" (drops the alignment, back to the
  release's own timing). A manual offset applies on top of whatever timing the track has (aligned or original), shifting
  every part of a split track equally. Split points are not edited by hand.
- Only owners see the line, the button and the marks. Everyone else finds the tracks under "From the NAS".

## 9. Viewer search in the player

Layout A of the mockups, inside the existing Subtitles menu, one step per screen so it fits a phone:

- Below "From the NAS", "Search Anime Tosho…" (only on a NAS disc). It opens a search box filled with the title's name
  (or the disc's name when the disc isn't filed, or when `TITLE_LIBRARY` hides catalogue names from this person), and lists Anime Tosho releases, with a SeaDex badge on releases SeaDex
  lists ("SeaDex best" on the best).
- Picking a release goes to the tracks of the file for the episode playing (matched as in §5; when no file matches,
  the release's files to pick from), every language listed, English first.
- Picking a track: the NAS fetches it and its fonts, lines it up with this episode (§6), and the player loads it as a
  user pick while the menu says "Lining up…". A failure says why and leaves the subtitles as they were.
- The pick is the viewer's only: nothing goes into the subtitle store. It is kept in their place (a new kind of
  `PlaceTextFile` entry naming the Anime Tosho file and track), so resuming the episode brings it back from the NAS's
  cache, or from Anime Tosho again when the cache has dropped it (counted against the person's limit). Up next carries
  it to the next episode when that episode has a file in the same release with a track of the same name; otherwise Up
  next behaves as today.
- Every paired person can search (the gate of `TITLE_LIBRARY` doesn't apply; it's their own viewing). The NAS limits
  how many fetches one person starts in an hour.

## 10. What's left to the builder

- The alignment algorithm, its thresholds and its tests (§6).
- The xz and 7z decoders, within §3.
- Data layout under `/data` for the cache, the shared fonts and the per-title state, and the store's new fields.
- The nightly pass's place relative to the title matching, and its pacing in practice.
- The per-person search limit, cache budget and default sizes, unless the numbers here turn out wrong.
- Copy on the screens, within the wording above.

## 11. Decisions log

| Decision | Who |
|---|---|
| SeaDex picks the release, Anime Tosho (animetosho.net) supplies tracks and fonts | Owner |
| The owner flow is the main one; viewer search in the player is the fallback | Owner |
| Nightly pass over titles not done yet, plus a button per title; done titles are skipped | Owner |
| Nightly results attach at once; the owner reviews afterwards | Owner |
| All English tracks of a release are attached | Owner |
| Other languages through an owner setting | Owner ("English, with options for the rest"); a setting of languages is my reading |
| Fallback when SeaDex's best isn't on Anime Tosho: the paired WEB release, then other SeaDex releases | Owner (the WEB pairing); the order is mine |
| Line each episode up automatically, by hand as backup | Owner |
| Fansubs attach alongside the owner's own uploads | Owner |
| A viewer's search pick is only theirs | Owner |
| Owner review as marks on the episode list (mockup A); viewer search inside the Subtitles menu (mockup A) | Owner |
| Local fonts dropped | Owner |
| Line up from sampled stretches, whole episode only when they disagree; nightly pass at night, pausing for playback and encodes | Owner (the trade); the details are mine |
| Fetch each font pack once through `/download/`, paced and cached for good | Owner |
| Everything is fetched and decoded on the NAS; viewer picks resume from the NAS's cache | Mine |
| Per-episode fallback, absolute-number mapping, signs tracks share the dialogue track's alignment | Mine |
| Titles with nothing found retried monthly | Mine |
| Shared fonts by content hash, a separate 20 GB fansub budget, a 50 MB cap per fetched track | Mine |
| A new run replaces the fansubs it attached before and keeps manual offsets on the same track | Mine |
| The search is open to every paired person regardless of `TITLE_LIBRARY`, with a per-person hourly limit | Mine |
| Fansubs follow the episode, carry the disc they were lined up on, and are re-lined when that changes | Mine |
| Reruns replace per episode; edits kept; deleted tracks remembered until "Find fansubs again" asks | Mine |
| Per-episode "Line up again" and "Use original timing"; manual offset on top; no hand-edited splits | Mine |
| Viewer picks resume from cache or a re-fetch, and carry to Up next by release and track name | Mine |
