# Subtitle Helper and Seikou Packages: Design

Date: 2026-11-07
Status: Draft for the user's review
Parent: `2026-11-06-encoding-tools-design.md` (M1 shipped on 2026-11-06 and confirmed on a real disc). This document replaces that spec's milestone 2 and reorders milestones 3 to 5.

## 1. Intent

An encoded episode is only watchable with subtitles, and the subtitles the user wants come from fansub releases, usually the one SeaDex ranks best, pulled from Anime Tosho. Today the user does this by hand: find the release, download it, extract the tracks and fonts, retime them against the disc, mux. Seikou's NAS already automates the fetch and the line-up for playback, but the encoder has none of it.

This project gives the encoding app a subtitle helper: a small web page where the user picks the release with SeaDex's own notes beside it, matches tracks to episodes named from AniList, watches each episode play with the subtitles on while nudging the timing, and sets the file's title, stream names and languages. What comes out feeds the encoder directly. The playback is Seikou's engine on the disc itself, so the helper needs no encode to exist first.

Because the helper reuses most of Seikou, the project starts by cutting Seikou into packages. That extraction was already planned (bdmv, pg, ass); this design widens it to the player engine, the fansub pipeline and the title matcher, and makes it the first milestone.

## 2. Goals, non-goals, anti-goals

Goals:
- The user chooses the release, with SeaDex's ranking and notes next to the choice, a free-text search over Anime Tosho when SeaDex's list does not fit, and a way to drop their own files.
- Episodes are named from AniList, so the disc's episodes and the release's files match by number and title, and the user confirms the matches.
- Each episode plays in the browser with the chosen subtitles rendered with their fonts, at the shift the tool found, and the user nudges the offset while watching.
- The user can set the MKV title, each stream's name and language, with defaults taken from the disc's stream table, the release and AniList.
- The encoder muxes the chosen ASS tracks and fonts into each episode's MKV with those names and languages, and the web package (static directory) ships the same.
- Choices are saved per disc and playlist, so a re-encode reuses them.
- The Seikou pieces this needs exist as packages the encoding app imports, and Seikou itself keeps working from the same packages.

Non-goals:
- A full web UI for encoding jobs (queue, logs, settings). That stays milestone 4. The helper gets the backend server early, with only the routes it needs.
- OCR of PGS. PGS is carried through untouched and rendered client side (unchanged from the parent spec).
- Automatic retiming beyond one global shift per episode. Seikou's line-up reports a split point when the timing changes mid-episode; the helper shows it and the user handles it, as in Seikou.
- Downloading video. Only subtitle tracks and fonts come from Anime Tosho.

Anti-goals (a failure even if it works):
- A helper that silently picks a release. The user picks; the tool proposes.
- Playback that is a proxy encode. If the engine cannot play a disc, the helper says so rather than falling back to an encode the user did not ask for.
- Seikou's NAS screens duplicated in the encoding app. The helper is a new, smaller UI; the NAS library, pairing and people stay in Seikou.

## 3. The user's flow

The helper is one page with a step bar. Episodes are the ones the user grouped from chapters (M1's episode spec), so the helper opens after a disc and playlist are chosen and the episode ranges set.

Step 1, pick a release. The page shows the show's title and cover from AniList, found through the disc catalogue (TheDiscDB fingerprint to AniList id) with a search box as fallback. Below it, the releases SeaDex lists for the show, best first, each with SeaDex's notes (why best, which groups, dual audio, unmuxed) and a link that opens the SeaDex page. A search box queries Anime Tosho by text for anything else. "Add your own files" accepts `.ass`, `.ssa`, `.srt` and font files. Picking a release fetches its subtitle tracks and fonts from Anime Tosho (no video) and shows what came back: tracks per episode, languages, font count.

Step 2, match episodes. A table: one row per disc episode (number and AniList title), one cell per candidate track from the release, matched by episode number. The user corrects a match, picks between full and signs tracks when a release has both, or marks an episode "no subtitles". Unmatched release files are listed so nothing is lost silently.

Step 3, line up and preview, one episode at a time. The tool lines the track up with the disc's audio (Seikou's align) and shows the shift it found, and the split point if it found one. The backend writes a retimed copy of the track with the shift, and the split's per-part offsets when there is one, already applied (Seikou's retime), cut to the episode; the engine plays that copy with only the nudge as its offset, so what the user previews is byte for byte what the encoder will mux (designer's call: this keeps the engine's single-offset API unchanged and makes split episodes preview correctly). The episode plays in Seikou's engine with the subtitles rendered, starting at the first dialogue line. A nudge control changes the offset in 42 ms and 10 ms steps, with keys as in Seikou (`[` and `]`), and the change applies live. "Accept, next episode" moves on; "Use original timing" drops the shift; "Skip" leaves the episode without subtitles.

How the page opens (designer's call): `npm run cli -- serve <disc> --playlist <id> --episodes "<spec>"` registers that disc, playlist and episode grouping, starts the backend, and opens the helper on it. The page has no disc or chapter picker in this milestone; that arrives with the jobs UI in milestone 4. When `encode` later runs with a playlist and episode spec that differ from the saved record, it fails and says so rather than remapping; `encode --no-subtitles` encodes without the record.

Metadata panel, reachable from any step and shown before "Save for encoding". Fields: MKV title per episode (default `<Show> - <nn> - <episode title>` from AniList), video stream name (default empty) and language (default from the playlist's stream table, else `und`), audio stream name and language (defaults from the stream table's language code, name `Japanese` style from the language), subtitle track name (default the release group plus "full" or "signs") and language (default from the release's track language), chapter titles (default `Chapter n`). Audio tracks and subtitle tracks can each be dragged into any order; the order is the MKV track order, and the first audio track and the first subtitle track carry the default flag. A track can be unticked to leave it out. Anything the user types or reorders wins and is saved.

Save. The helper writes one record per disc and playlist (section 6). The CLI and the future job runner read it: when a record exists for the disc and playlist being encoded, every episode gets its tracks, fonts, names and languages without further flags.

## 4. Constraints

- Everything from the parent spec holds: LGPL-3.0-or-later for the app, no ffmpeg, tools as subprocesses, decrypted discs only, AV1 + Opus, no Apple-specific renditions.
- Seikou code stays LGPL-2.1-or-later in its packages; the app imports them. Nothing GPL is linked.
- The helper runs locally in the user's browser against the app's own backend. No account, no cloud. Anime Tosho, SeaDex and AniList are called from the backend, with Seikou's existing fetch cache and rate limits.
- Playback uses Seikou's engine unchanged: the encoding app's backend serves the BDMV folder over HTTP with range requests, the same contract Seikou's NAS uses, so the engine needs no new transport.
- Look and feel: one typeface, Instrument Sans (shared with Seikou), tabular numerals for times; palette base `#0F1B2D`, panel `#17273D`, ink `#E9EFF7`, muted `#8FA1BC`, one accent `#4D9BFF` for the chosen item and the alignment marks, amber `#F0B45B` only for the nudge; content left aligned, single column under a step bar, 16 px side gutters, usable at phone width. The alignment strip (disc audio onsets above, subtitle cues below, slid by the shift) is the one memorable element; everything else stays quiet. No uppercase labels, no numbered markers except the step bar, which is a real sequence.
- No new runtime dependencies in the app beyond what Seikou's packages bring (React and Vite for the page, 7z-wasm for archives, werift is not needed).

## 5. Architecture

### 5.1 Seikou packages (Seikou repo, npm workspaces)

Each package keeps LGPL-2.1-or-later, its own NOTICE listing ported files, and its existing tests. Seikou's app and server switch to importing them; nothing in Seikou's behaviour changes. Packages:

| Package | From | Size today | Exposes |
|---|---|---|---|
| `@seikou/bdmv` | `src/engine/bdmv`, `src/engine/disc/udf`, `src/engine/demux` | ~2,500 lines | MPLS/CLPI/index parsers, UDF reader, TS packet and PES assembly, stream types |
| `@seikou/pg` | `src/engine/graphics/pg-*`, `segments`, `composition`, `overlay-plane`, `rle` | ~700 lines | PGS decoder and renderer: push segments with timestamps, render at a time onto a canvas |
| `@seikou/ass` | `src/engine/ass` | ~5,000 lines | the libass port: load tracks and fonts, render at a time |
| `@seikou/engine` | `src/engine` (player, worker, protocol, decode, playback, render, subs, hdmv, nav) plus `src/player` | ~9,000 lines excluding the above and BD-J | the player worker bundle and its controller: open a disc from a byte source, play a playlist with optional in/out times, select audio and subtitle streams, load an ASS set with fonts and an offset, seek, clock |
| `@seikou/fansubs` | `server/src/fansubs` | ~3,200 lines | SeaDex lookup, Anime Tosho search and fetch, archive extraction, episode file matching, audio line-up, retime, pick store |
| `@seikou/titles` | `server/src/titles` | ~5,000 lines | disc catalogue, TheDiscDB fingerprints, AniList lookup and art |

BD-J (`src/engine/bdj`, 25,000 lines) stays in Seikou's app. The engine package must build without it: the controller takes an optional BD-J provider, absent in the encoding app, so BD-J discs open to the playlist picker there. This is the one Seikou-side design change; everything else is moving files and naming boundaries.

What the engine's byte source needs from a host: file size and ranged reads of a path under the disc, which is what Seikou's NAS transport already provides over HTTP. The package exports the transport interface and the HTTP implementation.

Seikou's line-up today decodes the disc's audio by spawning ffmpeg (`server/src/fansubs/disc-audio.ts`). The parent spec rules ffmpeg out, so `@seikou/fansubs` takes a decoder hook instead: `align` receives a function that yields PCM for a playlist range, and each host supplies its own. The encoding app passes one built on the M1 vspipe audio chain (BestSource), so nothing in this app ever runs ffmpeg. Seikou's own NAS server keeps the ffmpeg-backed decoder it has today; that is Seikou's choice, outside this design, and the hook lets it switch to the same vspipe path later if VapourSynth is added to its image. The first line-up on a disc pays BestSource's indexing, which the encode then reuses (designer's call).

How the encoding app gets the packages (designer's call): during development, `file:` dependencies on the sibling checkout through the existing `vendor/seikou` symlink (`vendor/seikou/packages/<name>`), which npm links; publishing to a registry is part of milestone 6 (delivery), and the `@seikou` npm scope's availability is checked then. The engine's worker bundle and wasm files are shipped inside the package's `dist/` so Vite copies them as assets.

### 5.2 Encoding app backend (Node, in `~/encoding-tools`)

A local HTTP server, started by `npm run cli -- serve` (and later by the UI job runner), with these routes and nothing else in this milestone:

- `GET /disc/<id>/files/<path>` with range support, serving a registered BDMV folder. Disc ids come from `@seikou/bdmv`'s disc key.
- `GET /disc/<id>/playlists` and `GET /disc/<id>/episodes?playlist=&spec=`: the M1 playlist model and episode plan as JSON.
- `GET /titles/lookup?disc=` and `GET /titles/search?q=`: `@seikou/titles`.
- `GET /fansubs/seadex?anilist=`, `GET /fansubs/search?q=`, `POST /fansubs/fetch` (release id → tracks and fonts into the app's cache), `POST /fansubs/upload` (user's own files), `POST /fansubs/align` (episode plan, track → shift and split): `@seikou/fansubs`.
- `GET`/`PUT /subtitles/<disc>/<playlist>`: the saved record (section 6).
- The page itself and its assets.

The server does not encode. Encoding stays the CLI's job in this milestone; the job runner is milestone 4.

### 5.3 Helper page

A Vite-built React page in the encoding app, embedding `@seikou/engine`'s worker and a minimal player surface (video canvas, play/pause, seek bar, the nudge). It uses the routes above and nothing of Seikou's NAS UI. The alignment strip draws the disc's audio onsets (from the align result) and the track's cue onsets; nudging slides the lower lane and sends the new offset to the engine.

### 5.4 Encoder integration

`encodeEpisodes` gains an optional subtitle record. For each episode it adds to `writeMkv`: one `S_TEXT/ASS` track per chosen ASS track with the retimed script (Seikou's retime applies the shift and the episode's cut offset), `S_TEXT/UTF8` for SRT, attachments for every font (`application/x-truetype-font` or `font/ttf`, `font/otf`), the MKV `Title`, and per-track `Name` and `Language` from the metadata panel, in the panel's order with `FlagDefault` on the first audio and the first subtitle track and off on the rest. The Matroska writer gains `Attachments`, subtitle `BlockGroup`s with `BlockDuration`, and track ordering. PGS passthrough from the parent spec's milestone 2 stays in scope here: `S_HDMV/PGS` tracks fed from `@seikou/bdmv`'s demuxer.

## 6. Data

One JSON record per disc and playlist, stored under the app's data directory (`~/Library/Application Support/encoding-tools/subtitles/<discKey>/<playlist>.json` on macOS, XDG equivalent elsewhere), never inside the disc folder:

```
{
  "disc": { "key": "...", "label": "TSURUNE_TSUNAGARI_1" },
  "playlist": "00000",
  "episodeSpec": "1-4,5-8",
  "anilist": { "id": 12345, "title": "...", "episodeOffset": 0 },
  "release": { "source": "seadex" | "tosho" | "local", "id": "...", "group": "...", "label": "..." },
  "fonts": ["<cache path>", ...],
  "episodes": [
    { "index": 1, "title": "...", "tracks": [ { "file": "<cache path>", "kind": "full" | "signs", "language": "eng", "name": "SubsPlease", "shiftMs": 1208, "nudgeMs": -42, "split": null } ],
      "metadata": { "title": "...", "video": { "name": "", "language": "und" }, "audio": [ { "pid": 4352, "name": "Japanese", "language": "jpn", "included": true } ], "chapters": ["...", "..."] } }
  ],
  "savedAt": "2026-11-07T10:00:00Z"
}
```

Array order in `tracks` and `metadata.audio` is the MKV track order; the first of each kind is the default track. Fetched tracks and fonts live in the app cache keyed by release; the record points at them. A missing cache entry at encode time is an error that names the release, not a silent encode without subtitles.

## 7a. Where the encoder lives (decided 2026-11-07)

After the Seikou packages branch merges, the encoding app moves into the Seikou repository as a top-level `encoder/` directory, beside `server/` and `rendezvous/`, with its own tsconfig project; its tests join Seikou's unit project and skip when the encoding tools are absent. Its milestone 1 history comes across with `git subtree add`. It then imports `@seikou/*` packages as workspace dependencies, so the `vendor/seikou` symlink and the `file:` links in section 5.1 no longer apply, and publishing to a registry is no longer needed. The command keeps the name `seikou-encode`. Seikou itself moves to LGPL-3.0-or-later in the packages branch, so the encoder and Seikou share one licence; ported files keep their upstream LGPL-2.1-or-later headers and `src/bdj-classlib/` stays GPL-2.0-only with the Classpath Exception.

## 7. Milestones (replacing the parent spec's 2 to 5)

1. **Seikou packages** (Seikou repo). Workspaces; extract the six packages; Seikou's app and server import them; BD-J becomes an optional provider; CI green. Its own plan.
2. **Backend and helper** (this repo). The server, the helper page with its three steps and the metadata panel, the saved record, engine playback with ASS. Its own plan.
3. **Encoder integration and packaging** (this repo). ASS and fonts and metadata into the MKV, PGS passthrough, every audio stream the user left ticked in the metadata panel (all ticked by default; one Opus chain per stream, with the playlist PID mapped to BestSource's track index through the stream order `@seikou/bdmv` reads from the clip's PMT; 5.1 at 320 kb/s as the parent spec says), the static web directory (WebM remux, `.sup`, ASS and fonts, WebVTT chapters). Its own plan. (Multi-channel audio and PID selection were in the parent spec's milestone 2 and belong here; designer's call to include every stream by default.)
4. Web UI for jobs (unchanged).
5. Player (unchanged, now reusing `@seikou/engine`'s subtitle rendering where the WebM path cannot).
6. Delivery (unchanged).

## 8. What is left to the builder

- Package names, internal module layout inside each package, and how the engine's worker bundle is built and served from the app.
- The exact matching heuristics between release files and episodes beyond episode numbers (Seikou's `episode-files` already has them; keep them).
- The alignment strip's rendering details and the player surface's controls, within section 4's look.
- Route shapes beyond the list above, error bodies, and the cache layout.
- Whether SRT tracks get converted to ASS at mux time or carried as `S_TEXT/UTF8` (either is fine; pick one and say so).

## 9. Calls the designer made after the builder check

A builder reviewed this document on 2026-11-07 and asked five questions; none needed the user, and each answer is marked "designer's call" where it lands: the line-up decoder hook (5.1), how the app consumes the packages (5.1), retimed copies for preview so splits preview exactly (3), how the page opens and the CLI's mismatch rule (3), and every audio stream included by default (7). The user can overturn any of them.
