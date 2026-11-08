# Encodes library: Design

Date: 2026-11-08
Status: Draft for the user's review
Related: `encoder/docs/superpowers/specs/2026-11-08-encoder-nas-design.md` (the encoder side: fetching discs from the NAS, uploading encodes, chapter names, tags), the encoder's parent spec `encoder/docs/superpowers/specs/2026-11-06-encoding-tools-design.md` (its milestone 5, "Player", is replaced by this design and the encoder one).

## 1. Intent

The user encodes Blu-ray episodes into AV1 + Opus MKVs with Seikou encoder, and wants to watch them in Seikou, not in another player. The encodes live on the same NAS drive as the discs, and the same people and devices that use the disc library watch them, at home over HTTPS or abroad over WebRTC. AniList is the main way the library is organised. The disc library stays as it is; the encodes get a library of their own beside it.

## 2. Goals, non-goals, anti-goals

Goals:
- Two tabs on the NAS screens, **Discs** (the title library as it is today) and **Encodes** (the new library).
- The Encodes library lists the encoded episodes by AniList show, with an entry's sequels, prequels and films grouped into one show with seasons inside, as the disc library groups them.
- An encoded episode is one MKV file (AV1 video, Opus audio tracks, ASS tracks with their fonts as attachments, PGS tracks, chapters with names, tags naming its AniList entry and episode). Seikou's engine plays it directly: its own Matroska reader, WebCodecs for AV1 (and for Opus, or the engine's WASM audio decoder where WebCodecs has no Opus), Seikou's ASS and PGS renderers for subtitles, the MKV's chapters for the chapter list.
- The player has, beyond what the disc player has:
  - **Skip:** "Skip opening" during a chapter named Opening, "Skip ending" during a chapter named Ending when a chapter follows it. Pressing it seeks to the start of the next chapter.
  - **Next episode:** a "Next episode" button, shown during an Ending chapter that nothing follows (it takes the Skip ending button's place), and during a Preview chapter that comes after the Ending. Pressing it opens the next episode of the show at once, carrying the audio and subtitle choices over by language (as Up next does for discs).
  - **Countdown:** a per-person player setting, off by default. When on, the Next episode button is a countdown: its fill drains like a progress bar and the next episode starts when it empties; pressing it goes at once; a cancel control stops the countdown and leaves the button. When off, nothing advances on its own.
  - **Subtitles:** the Subtitles menu offers the MKV's own tracks, the subtitle store's uploads for that episode, Anime Tosho search and the viewer's own files, as the disc player's menu does.
- Resume, Continue watching, Up next and per-episode progress work for encodes as they do for discs, per person.
- The owner uploads encodes over HTTPS (the encoder does it, see the encoder design). The server writes them under one folder, `/encodes`, and files each one from its tags as soon as it is complete.
- Empty library: the owner sees what to do next; everyone else sees "The library is currently empty."
- A device that cannot decode AV1 shows a clear warning when an encoded episode is opened, and plays nothing.

Non-goals (this design):
- Transcoding for devices without AV1 (deferred: an HLS rendition made on the NAS).
- Shares, or several encode folders: there is one folder.
- Editing an encode's metadata from Seikou (the encoder writes it; re-upload to change it).
- Downloads for offline viewing.

Anti-goals:
- An episode that appears in the library before its whole file has arrived, or a half-written file that looks finished.
- A server that writes anywhere on the drive except its data volume and `/encodes`.
- The disc library changing for anyone because the encode library exists.
- A second, different player UI: the encode player is Seikou's player with the additions above, the same controls and menus.

## 3. The user's experience

1. **Tabs.** The NAS screens' app bar gets two tabs, Discs and Encodes. On a phone they sit under the app bar, full width, the selected one underlined in the accent; on a wide screen they sit at the left of the bar. (Approved in the mockup on 2026-11-08.) The choice is in the address bar (`/nas/…` for discs as today, `/nas/encodes/…` for encodes; designer's call on the exact paths).
2. **Empty Encodes tab.**
   - The owner, when `ENCODES_MOUNT` is not set: "Set ENCODES_MOUNT on the NAS to hold encodes", with a link to the help page that explains it.
   - The owner, when it is set and nothing is uploaded: "Encode an episode in Seikou encoder to add it here."
   - Everyone else: "The library is currently empty." and "Encoded episodes appear here once the owner adds them."
3. **The library.** Show tiles by AniList poster and name, a Continue watching row over them (encodes only), and a show page with its seasons (each AniList entry of the group is a season or a film) and their episodes, with progress marks and a resume link, as the disc library's season screen has. Episodes the owner has not encoded are not listed.
4. **Playing.** Opening an episode goes through the same pre-flight as a NAS disc (resume prompt, route choice), then plays. The chapter list shows the chapter names. Skip, Next episode and the countdown behave as in §2.
5. **No AV1.** On a device whose WebCodecs reports no AV1 decoder for the encode's configuration, opening an episode shows: "This device can't play AV1 video, which these encodes use." with a link back. Nothing is downloaded.

## 4. Constraints

- Everything in `CLAUDE.md` holds, with one change the deploy and the constraints section must state: the server writes only to its data volume and to `/encodes` (a folder the owner binds writable); the library mounts stay read-only and the server never writes anywhere else under `/mnt`.
- The engine changes stay in the packages and import nothing from `src/`. The Matroska reader is a package of its own, `@seikou/matroska` (the user's decision, 2026-11-08: useful to other people), the eighth workspace package: its own README, NOTICE, `LGPL-3.0-or-later`, in `npm run package-smoke`, and no dependency on the engine or on anything of Seikou's. The engine depends on it.
- Licences: new files LGPL-3.0-or-later; if any Matroska code is ported from FFmpeg or libmatroska-derived code, it keeps its upstream licence and goes in a NOTICE as the rules say. The encoder already has its own Matroska writer; a reader written fresh is preferred.
- Supported browsers as today (Safari 26, Chrome and Firefox stable and stable−2, Chrome Android). AV1 decode is hardware-dependent; the warning in §3.5 covers the rest.
- The repo is public: made-up names in tests, fixtures and docs.
- WebRTC: uploads are owner actions and may be large; they go over HTTPS. Playback works over both routes, as disc playback does.

## 5. Architecture (designer's calls where not stated above)

### 5.1 Storage and filing (server)

- **Mount.** `ENCODES_MOUNT` in `.env` (host folder) is bound writable at `/encodes` by `server/deploy/compose.yaml` (only when set). `.env.example`, `docs/self-hosting.md` and `docs/nas.md` explain it.
- **Layout inside `/encodes`.** The server owns it: `/encodes/<AniList id>/<episode key>.mkv` (designer's call), where the episode key is the episode number the encoder tagged (a film's single entry uses `1`), plus `.partial` files while uploading. A later upload of the same AniList id and episode replaces the earlier file (the owner re-encoded it) after the new one is complete.
- **Index.** An encodes index in the data volume (`encodes.json`, atomic writes) lists each file with its tags, size, mtime, duration, chapters (start, name), tracks (kind, codec, language, name, default, forced) and a content key for places. At start the server rescans `/encodes` (reading only each file's header, tags and chapters, and its cues for the duration) and rebuilds what changed; an upload updates the index when it completes.
- **Tags the server relies on** (written by the encoder; see the encoder design for the exact Matroska tag names): AniList id, episode number, episode title (optional), source disc key and playlist, encoder version. A file without an AniList id is listed under "Not filed" for the owner only, with its file name.
- **Grouping.** The show grouping uses AniList relations (sequel, prequel, parent, side story kept apart or not as the disc library's catalogue does), cached as the title service caches AniList answers. `packages/titles` holds the grouping rule, shared with the disc catalogue where it can be.

### 5.2 Upload API (server)

- Owner devices only, HTTPS only (refused over WebRTC with a message).
- A resumable upload: `POST /api/encodes/uploads` with the file's size and SHA-256 → an upload id; `PUT /api/encodes/uploads/<id>` with `Content-Range` chunks (any order, re-sendable); `GET` reports which ranges are stored; `POST …/<id>/complete` checks size and hash, reads the tags, renames the `.partial` into place, updates the index and answers the filed episode; `DELETE` aborts. An upload not touched for 24 h is removed.
- Limits: free space checked before accepting (507 when the drive can't hold the file), one upload per file at a time.
- `DELETE /api/encodes/<episode id>` (owner) removes an encode.

### 5.3 Reading and playing (server and engine)

- The library routes (`GET /api/encodes/titles`, a show, a season, Continue watching) follow the title routes' shapes and the `TITLE_LIBRARY` gate.
- The file is served by range reads like a disc file (`GET /api/encodes/files/<episode id>`), so the engine's `RemoteSource` and the WebRTC route work unchanged.
- **Engine.** `@seikou/matroska` (EBML, SeekHead, Cues for seeking, Clusters with SimpleBlock and BlockGroup, lacing as needed for Opus, attachments for fonts, Chapters, Tags) feeds the existing decode and render path: AV1 through WebCodecs (codec string from the AV1 CodecPrivate), Opus through WebCodecs `AudioDecoder` where present, else the WASM decoder (add Opus to `audio.wasm` only if needed), ASS through `@seikou/ass` with the attached fonts, PGS through `@seikou/pg` from the Matroska blocks, chapters into the snapshot. Seeking uses the Cues. The player works from a new `open` kind for an encoded episode; the protocol change comes first, as `CLAUDE.md` says.
- **Places.** An encoded episode's place uses its own key kind (e.g. `e.<AniList id>.<episode>`), stored with the person's places as discs' are; Continue watching and Up next include encodes in the Encodes tab only.
- **Subtitle store** (designer's call after the builder check). Stored subtitles are matched to an encode by the source disc key and playlist in its tags, not by AniList episode (a disc catalogue season is not always an AniList entry):
  - an `episode` attachment on the same disc key and playlist is offered, shifted by the episode's start time in that playlist (the `SEIKOU_EPISODE_START_MS` tag);
  - a `chapter` attachment on the same disc key and playlist whose chapter is the episode's first chapter is offered unshifted;
  - anything else is not offered for the encode.
- **Per-person player settings.** The NAS has no per-person settings store today (only owner-wide settings in `routes/admin.ts`); the countdown setting needs a small one, kept with the person's data like places.

### 5.4 Player additions (UI)

- Chapter names come from the MKV; "Opening", "Ending" and "Preview" are the names the buttons react to (exact, case-insensitive).
- Next episode: the next episode in the show's order (the next number in the season, then the first of the next season); none at the last episode.
- The countdown setting lives with the person's player settings (designer's call where; the NAS's per-person settings, so it follows the person across devices). Its length: 10 s (designer's call).

## 6. What is left to the builder

- The exact route paths and error bodies, the index format, the episode id's form.
- The Matroska package's API (a reader over byte ranges, as `ByteSource` reads); whether Opus needs the WASM decoder.
- The show page's layout within the existing look; where the countdown setting is shown.
- How AniList relations are walked and cached, sharing as much with the disc catalogue as fits.

## 7. Deferred

- HLS transcoding on the NAS for devices without AV1.
- Downloads for offline viewing.
- Automatic opening and ending detection.
