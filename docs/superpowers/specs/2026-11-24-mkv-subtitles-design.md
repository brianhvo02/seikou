# Subtitles from picked MKV files

Status: design, 2026-11-24. Roadmap row "Subtitles from picked `.mkv` files"; `docs/known-issues.md` ("Not loaded yet:
subtitles and fonts inside an `.mkv` file picked or dropped on the player").

## Why

The owner keeps the best fansub releases SeaDex lists for a show as their full episode MKVs, on the NAS. The NAS's own
Find fansubs already goes after the same releases, but through Anime Tosho's extracted tracks, so it misses a release
Anime Tosho hasn't extracted. The owner wants the subtitles in those MKVs on the disc for everyone paired, lined up
with the disc's audio as the NAS's own SeaDex finds are. Getting an MKV's subtitles into the player for one viewing is
the smaller half and comes with it.

## Goals

1. **Into the NAS's subtitle store (the priority).** On a season or movie screen, an owner picks one or more release
   MKVs (through the NAS's network share, from the computer they watch on). The browser reads each MKV where it lies,
   finds its subtitle tracks and attached fonts, guesses each file's episode from its name, shows what it found for
   the owner to confirm, and uploads only the chosen tracks and their fonts as subtitles attached to those episodes.
   The NAS keeps each upload's original and lines it up with the disc's audio, as it does a fansub: the same
   alignment, and the same Line up again and Use original timing controls (`FansubEpisodePanel`) afterwards.
2. **Into the player for one viewing.** Any viewer can pick or drop an `.mkv` on the player as they can an `.ass` or
   `.srt` today; its text tracks and fonts load into the episode subtitle set, placed as picked files are, with the
   offset they set. Nothing is uploaded.

Both read the MKV with one reader in the browser.

## Non-goals

- PGS (or any bitmap) tracks from a picked MKV. The store holds text subtitles only.
- The NAS finding MKVs in a folder of its own (considered, below). The owner picks the files.
- Uploading whole MKVs to the NAS.
- Store uploads by anyone but owners (the store's rule today).
- Phones as the place to do goal 1. It must work there, but reading release files is a desktop task.

## Anti-goals

- **A confident wrong timing.** Where the aligner answers `none`, the subtitle keeps the release's own timing and the
  owner is told it wasn't lined up, as a fansub is today.
- **Reading gigabytes when megabytes would do.** The files are read over the LAN through a network share: the reader
  reads the subtitle blocks through the file's Cues wherever the Cues cover the subtitle tracks, and walks the
  clusters only for a file whose Cues don't. It reports progress either way, and the UI stays responsive.
- Fonts uploaded twice: the same font across a season's files is stored once.

## Approaches considered

1. **The browser extracts, the NAS lines up (chosen).** The browser reads each MKV through `@seikou/matroska`
   (`blobRangeReader` over the picked `File`), rebuilds each text track as a whole `.ass` (or `.srt`), takes the font
   attachments, and uploads those through the existing subtitle upload routes; the NAS lines the uploads up. Uploads
   are a few MB, so WebRTC is fine. The cost is reading the file in the browser: cheap through Cues, about 10 to 20 s
   an episode on a gigabit LAN when the clusters have to be walked.
2. **The NAS reads the MKVs from a folder of its own.** An owner setting names a read-only folder; the NAS scans it,
   recognises SeaDex release files by name against the releases it already knows per title, and attaches their
   tracks with no picking. Hands-free, but a new folder setting and scan, and matching that fails quietly when a name
   doesn't match. Not chosen: the owner prefers to pick.
3. **Upload whole MKVs and extract on the NAS.** Gigabytes over HTTPS or WebRTC for megabytes of text. Ruled out.

## Design

### The reader (shared)

A function in the engine (it needs `@seikou/ass`'s ASS parsing, which `@seikou/matroska` must not depend on) takes a
`RangeReader` and answers the file's text subtitle tracks and its font attachments:

- Text tracks: `S_TEXT/ASS`, `S_TEXT/SSA` (and the old `S_ASS`, `S_SSA`), rebuilt as a whole script: the CodecPrivate
  header, then one `Dialogue:` line per block in ReadOrder, its Start and End from the block's time and duration, its
  fields from the block (the reverse of what `@seikou/matroska`'s writer does for `S_TEXT/ASS`). `S_TEXT/UTF8` as SRT,
  one cue per block. Each with its track number, name, language, default and forced flags, and its count of dialogue
  lines.
- Fonts: the attachments `fontAttachments` (`packages/engine/src/encode/mkv-subtitles.ts`) already picks, with their
  names.
- The blocks of the text tracks are found through the Cues when the Cues have a point for every block of those tracks
  (mkvmerge's default; the builder checks what real release files hold), each read by its cluster position and
  relative position; otherwise every cluster is walked: the file is read in order in large windows (a share serves one sequential read far faster than a small read per block), keeping only the wanted tracks' blocks.
  Progress is reported in bytes.
- It runs off the main thread (a worker), since a walk can take seconds.

### Into the store (goal 1)

- **Where:** the owner's subtitle upload on the season and movie screens (`SubtitleUpload`) takes `.mkv` files beside
  `.srt`, `.ass`, `.ssa` and fonts. One or more MKVs switch it to a release form.
- **What the owner sees:** one row per file: its name, the episode guessed from it (`episodeOfFile` in
  `@seikou/fansubs`, mapped onto the season as Find fansubs maps it, and changeable), and its text tracks (name,
  language, ASS or SRT, dialogue lines), with the tracks in the NAS's fansub languages (`FansubLanguages`: English and
  the owner's additions) ticked. Reading progress shows per file while it is read; a file with no text tracks says so.
  A file whose episode can't be guessed waits for the owner to pick one.
- **What is uploaded:** each ticked track as its own subtitle, named from the release group (the bracketed group in
  the file name) and the track's name, in the track's language, attached to the episode. Its fonts go with it.
- **On the NAS:** the subtitle is marked as coming from a release (a new source kind beside `fansub` in
  `@seikou/nas`'s `FansubSource`, carrying the release file's name and size, the track number and name, and once
  lined up the alignment and the disc and playlist it was lined up on). The NAS keeps the upload as the original and
  lines it up as `FansubService.realign` does, ASS tracks of one release file sharing the offset of the one with the
  most dialogue (siblings found by release file, not by Anime Tosho file id). Line up again and Use original timing
  then work as they do for fansubs.
- **Find fansubs leaves an episode with a release upload alone** (the owner's answer): neither the button nor the
  nightly pass attaches, replaces or deletes anything on an episode that holds a subtitle from a release upload. Today
  `FansubService` deletes every earlier subtitle with a `source` on an episode it attaches to, so that step must skip
  release uploads and the episode must be passed over. A release upload counts as attached in Find fansubs' episode
  marks. *(Owner's decision.)*
- **When it is lined up:** through `FansubService`'s one-title-at-a-time work (which pauses while a disc is read or a
  level encodes), not inside the upload request. Until it is lined up, viewers don't see the track; if the aligner
  answers `none`, it shows at the release's own timing and the owner is told. *(My call: no confident wrong timing,
  and no ffmpeg work inside a request.)*
- **Fonts:** pooled on the NAS by content (`subtitles/.fonts/<sha256>`, as `createFansub` pools them), so a season's
  shared fonts are stored once; the 50 MB an upload counts only fonts the pool doesn't already hold. Past it the track
  is stored with the fonts that fit and marked as missing fonts, as a fansub is. *(My call.)*
- **No SeaDex lookup:** a release upload carries the group from its file name and no tracker or rank, so the new
  source kind has those optional where the UI shows them. *(My call.)*
- **SRT tracks** are uploaded as they are, at the release's own timing with the offset the owner sets; the aligner
  reads ASS dialogue only.

### Into the player (goal 2)

- `.mkv` joins the extensions a pick or drop takes (`SUBTITLE_EXTENSIONS` in `drop-files.ts`).
- The reader runs on the picked file; its default text track (else the first in the person's subtitle language from
  disc preferences, else the first) loads as the picked subtitle, its fonts with it, and the Subtitles menu lists the
  file's other text tracks to switch to.
- Placement, offset and the encoding prompt are as for a picked `.ass` or `.srt`. A resume can't keep the MKV, so the
  device keeps the extracted script and its fonts in `PlaceStore` under today's limits (5 MB a file, 50 MB a disc);
  fonts past them are dropped, and the usual fallback to installed fonts and the missing-font notice apply. *(My call.)*

### Fixtures and tests

- Made-up names only. The encoder's MKVs in `fixtures/encodes/990001/` hold ASS with an attached font and Cues; a
  test helper writes variants through `@seikou/matroska`'s writer (no Cues for subtitles, two ASS tracks, an SRT
  track, no text tracks).
- Unit tests for the reader (Cues and walk give the same script), for the release form's model (episode guesses,
  ticked tracks, names), and for the NAS's line-up of a release upload, siblings included.
- E2E: an owner on the NAS stand-in uploads tracks from an MKV and a viewer gets them lined up; a viewer drops an MKV
  on the player and the subtitle shows.

## Constraints

- Packages don't import React or `src/`; `@seikou/matroska` stays free of `node:` and of `@seikou/ass`.
- The store's limits stand (2 GB in all, 5 MB a file, 50 MB of fonts an upload); a release upload and its original
  count toward the 2 GB.
- Owner writes only; the reads are open to every paired person under the `TITLE_LIBRARY` gate, as now.
- The public-repo rule: no real release, group or file names in fixtures, tests or docs.

## Left to the builder

- Where the reader lives in the engine and the worker it runs on.
- How the release form is laid out beyond what it shows (above).
- The route or field that tells the NAS an upload is a release track to line up, and how its sibling grouping is
  stored.
- Whether goal 2's track switching is a submenu or a list in the Subtitles menu.
