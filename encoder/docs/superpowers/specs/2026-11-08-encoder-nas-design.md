# Encoder and the NAS: Design

Date: 2026-11-08
Status: Draft for the user's review
Parents: `2026-11-06-encoding-tools-design.md` (its milestone 5, "Player", is replaced by this design and Seikou's `docs/superpowers/specs/2026-11-08-encodes-library-design.md`), `2026-11-08-jobs-ui-design.md` (the app, its library, Episodes page, queue and runner).

## 1. Intent

The user watches encodes in Seikou's new Encodes library on the NAS. The encoder runs on the user's Mac (an 18-core M5 Max: SVT-AV1 at preset 4 is a CPU job, and the NAS's Intel GPU encoder would trade away the quality the settings are chosen for). So the encoder has to get discs from the NAS, put finished episodes back on it, and write into each MKV what the Encodes library needs: the AniList entry and episode, and named chapters for skipping openings and endings. All of it over HTTP(S) through the NAS's own API, with no file share mounted on the Mac.

## 2. Goals, non-goals, anti-goals

Goals:
- **Pairing.** The app pairs with the NAS as an owner device, with an owner pairing code (as `scripts/verify-level.ts` does), and keeps the device token in its data directory. Settings show the NAS it is paired with and can unpair.
- **NAS discs in the Library.** The Library page lists the NAS's discs (from its disc library API) beside the local roots, marked as on the NAS. Disc, Episodes and the helper work on them: the preview plays the disc from the NAS through `@seikou/engine`'s `RemoteSource`, as Seikou does.
- **Fetch what the job needs.** An encode of a NAS disc first fetches the BDMV metadata (index, playlist, clip info) and the clips the queued episodes cover, over the NAS's range-read API, resumably, into a temporary folder in the app's data directory. The next episode's clips download while the current episode encodes. A clip is deleted as soon as no remaining episode of the job needs it. A retry fetches only its episodes' clips. The subtitle line-up (which decodes the disc's audio with BestSource) fetches the clips of the episode it lines up, the same way, and keeps them for that session.
- **Upload.** With the NAS as the job's destination, each finished episode is uploaded to the NAS's encode upload API (resumable chunks, SHA-256 checked) as a job step with its own progress ("uploading episode n of m"). Once the NAS confirms an episode, the Mac's copy is deleted. A failed upload keeps the file, and Retry resends it without re-encoding.
- **Chapter names.** On the Episodes page each chapter has a name picker: Avant, Opening, Part A, Part B, Ending, Part C, Preview, or Custom (free text). The names are saved per disc and playlist in the data directory, loaded when the page opens again, and written into each episode's MKV as its chapter titles. Unnamed chapters keep the encoder's current naming.
- **AniList episode per episode** (the user's decision, 2026-11-08). The Episodes page shows, for every episode of the grouping, its AniList entry and episode number. They are prefilled: the entry from the subtitle helper's record when there is one (else the user searches AniList there, as in the helper), and the numbers in order from a first number the user can edit. The record's `episodeOffset` is the fansub release's numbering, not AniList's, so it is never used as the episode number. A disc that ends one AniList entry and starts the next is one job: from any episode the user can switch to another entry (the next season is offered first, from the entry's relations), and the numbering restarts from a number they set. The choices are saved with the chapter names, per disc and playlist.
- **Tags.** Every MKV gets Matroska tags for its episode's AniList id and episode number (above), the episode title when AniList has one, the source disc key and playlist, the episode's start time within the playlist (so stored subtitles line up), and the encoder version.
- **Destination in the queue.** The queue dialog and the profiles offer "The NAS (Encodes library)" as the destination, beside a local folder. A NAS destination needs a paired NAS and an AniList entry and number for every episode; without them the dialog says what is missing.

Non-goals:
- Streaming a disc to BestSource over HTTP with no local copy (deferred experiment: BestSource through FFmpeg's HTTP protocol with range requests).
- Encoding on the NAS.
- Uploading over WebRTC (uploads go over HTTPS; away from home, encodes queue locally and upload when the NAS is reachable — designer's call: the job waits with "waiting for the NAS" and retries every minute).
- Managing the Encodes library from the encoder (deleting, re-tagging): that is Seikou's.

Anti-goals:
- A fetched disc copy that stays on the Mac after its job, or that fills the drive: the fetch checks free space first and keeps at most the clips of the episode being encoded and the next one.
- An upload that the NAS lists before it is whole (the NAS's job; the encoder never marks an episode uploaded before the NAS's confirmation).
- A token in logs, the job's `cli` string, or the page.

## 3. The user's flow

1. Settings → "Pair with your NAS": type an owner pairing code (from Seikou's admin screen or `deploy.sh --owner-code`) and the NAS address, or open a pairing link. The app shows the NAS's name when paired.
2. Library: local discs and NAS discs in one list (NAS ones marked); open a NAS disc as any other.
3. Episodes: group chapters as today, name chapters with the picker, pick or confirm the AniList show (prefilled from the helper's record when there is one).
4. Subtitles in the helper as today (its line-up fetches what it needs from the NAS).
5. Queue with the NAS as destination: the job shows fetching, encoding and uploading per episode; the episodes appear in Seikou's Encodes tab as each upload completes.

## 4. Constraints

- The documentation standard and everything in the parent specs hold (LGPL-3.0-or-later, no ffmpeg in `encoder/src`, tools as subprocesses, decrypted discs only, AV1 + Opus, local-only app on 127.0.0.1 with its token).
- The NAS's API is the only way in: no SMB, no ssh. The pairing and the NAS's CORS and token rules apply as for any device.
- The CLI keeps working: `encode` gains `--nas` (upload to the paired NAS) and reads NAS discs by a `nas:<disc key>` argument (designer's call on the syntax); the job's `cli` string shows them.

## 5. Architecture (designer's calls)

- **NAS client** in `encoder/src/nas/`: pairing (as `NasClient` does in the app, reusing `@seikou/nas` types), the disc library listing, range reads with retry, the upload protocol. The token is stored in `<data>/nas.json` (mode 0600).
- **Fetch** (`encoder/src/nas/fetch.ts`): given a disc key and the episode plans, lists the clips each episode needs (from the playlist's play items), downloads them to `<data>/fetch/<disc key>/BDMV/…` with `.partial` and rename, verifies sizes against the NAS manifest, and exposes the folder as a disc folder to the existing pipeline. The JobRunner gains a fetch step before each episode and a cleanup after it.
- **Upload** (`encoder/src/nas/upload.ts`): the protocol of Seikou's design §5.2; the runner gains an upload step after each episode (and after packaging, which is off for NAS destinations: the MKV is the deliverable).
- **Chapter names and tags** in the Matroska writer (`encoder/src/mux/`): `ChapterDisplay` per chapter from the saved names; a `Tags` element with the values in §2 (tag names: `ANILIST_ID`, `EPISODE`, `EPISODE_TITLE`, `SEIKOU_DISC_KEY`, `SEIKOU_PLAYLIST`, `SEIKOU_EPISODE_START_MS`, `ENCODER`; designer's call, written down for Seikou's reader).
- **Saved chapter names**: `<data>/chapters/<disc key>/<playlist>.json`, keyed by chapter index; the Episodes page reads and writes it through a new route. It is the only place chapter names live (designer's call after the builder check): the subtitle helper's metadata panel shows and edits the same names through the same route, the record's per-episode `chapters` field is no longer written, and an old record's chapter names are moved into this file once when it is loaded.
- **Helper preview of NAS discs** goes through the encoder's local backend, which reads from the NAS with its own token: the page's 127.0.0.1 origin is not one the NAS's CORS rule allows, and the token stays out of the page.

## 6. What is left to the builder

- The pairing screen's layout, the NAS disc marking in the Library, the destination control in the queue dialog.
- How many clips ahead the fetch runs (one episode ahead is the minimum).
- The exact CLI syntax for NAS discs and the NAS destination.

## 7. Deferred

- Streaming the disc to BestSource over HTTP instead of fetching.
- Uploading over the WebRTC route.
