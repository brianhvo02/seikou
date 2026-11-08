# Encodes Library Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A second library in Seikou, Encodes, that lists the user's AV1 + Opus MKV episodes stored on the NAS by AniList show and plays them in Seikou's player with chapters, Skip, Next episode, subtitles and resume.

**Architecture:** A new workspace package `@seikou/matroska` (the encoder's Matroska writer and readers, moved and made platform-neutral, plus a range-based reader for playback). The NAS server stores uploaded MKVs under `/encodes`, indexes them by their tags, groups them by AniList with the catalogue's rules, and serves them by range. The engine gains an encode session that feeds the existing decode and render path (AV1 through WebCodecs, Opus through WebCodecs, ASS and PGS through Seikou's renderers). The UI gains Discs and Encodes tabs, the Encodes screens and the player's chapter actions.

**Tech Stack:** TypeScript (strict), React, Vitest, Playwright, Node server (no native deps), WebCodecs.

**Spec:** `docs/superpowers/specs/2026-11-08-encodes-library-design.md` (and, for the tag names and the encoder side, `encoder/docs/superpowers/specs/2026-11-08-encoder-nas-design.md`).

## Global Constraints

- Every new file starts with `// SPDX-License-Identifier: LGPL-3.0-or-later`; `npm run licence-check` stays green. No ported code is planned; if any is ported, follow CLAUDE.md's licensing rules.
- Packages import nothing from `src/` and nothing React; `@seikou/matroska` depends on no other Seikou package and runs in Node and in browser workers (no `node:` imports, no `Buffer`).
- `protocol.ts` changes first when a feature crosses the UI/engine boundary.
- The server writes only to its data volume and to `ENCODES_DIR` (`/encodes`); library mounts stay read-only. The server has no native dependencies.
- New browser APIs go behind injectable interfaces (as `PlayerDeps` does) so unit tests use fakes.
- The repo is public: made-up names in tests, fixtures and docs (the NAS fixtures use Starfall Wanderer and similar; made-up AniList ids in `tests/e2e/fixtures/nas-metadata.json`).
- Tag names the server reads (written by the encoder): `ANILIST_ID`, `EPISODE`, `EPISODE_TITLE`, `SEIKOU_DISC_KEY`, `SEIKOU_PLAYLIST`, `SEIKOU_EPISODE_START_MS`, `ENCODER` (SimpleTag names at the Segment level, TargetTypeValue 50).
- Chapter names the player reacts to: `Opening`, `Ending`, `Preview` (exact, case-insensitive). Countdown: 10 s, a per-person setting, off by default.
- Docs: CLAUDE.md, `docs/nas.md`, `docs/self-hosting.md`, `docs/playing-discs.md` (or a new help page) and `server/deploy/.env.example` describe what changes, in the files' plain style.
- Commands: `npm run typecheck`, `npm test`, `npx vitest run <file>`, `npm run licence-check`, `npm run package-smoke`, `npm run server:build`, `npm run test:e2e`, `npx playwright test tests/e2e/nas.spec.ts`.
- Commit messages end with:
  ```
  Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
  Claude-Session: https://claude.ai/code/session_01VgtGbZtXAimwUtbzgUDxJj
  ```

## Review Focus

1. **An upload interrupted or replaced mid-way:** a reasonable person expects the old episode to keep playing until the new one is whole, and no `.partial` ever listed. Owned by Task 5 (`replacing an episode keeps the old file until the new upload completes`).
2. **Seeking in an MKV whose subtitle event started before the seek point:** the line on screen at the seek time must show (the encoder writes subtitle cues for this). Owned by Task 2 (`blocksFrom includes a subtitle block that started before the seek time and is still on screen`) and Task 9.
3. **A device without AV1 opening an encode:** a clear warning, nothing downloaded beyond the probe. Owned by Task 12 (`a device without AV1 sees the warning and no file read`).
4. **Places for encodes not leaking into discs (and back):** an `e.` key never reaches disc code paths that parse disc keys. Owned by Task 7 (`a disc route answers 404 bad-key for an e. key`, `continue watching lists encodes only in the encodes list`).
5. **The last episode of a show:** no Next episode button, no countdown, at the last episode of the last season. Owned by Task 11 (`no next-episode action at the show's last episode`).

---

### Task 1: `@seikou/matroska`: move the encoder's Matroska code into a platform-neutral package

**Files:**
- Create: `packages/matroska/` (`package.json` as `packages/nas`'s shape: name `@seikou/matroska`, exports `"."` and `"./*"`, files, licence; `README.md`, `NOTICE` (original code), `LICENSE`, `COPYING`), `packages/matroska/src/index.ts`, `src/io.ts` (`RangeReader`, `MkvSink`), and the moved modules `ebml.ts`, `ids.ts` (from `mkv-ids.ts`), `ebml-reader.ts`, `writer.ts` (from `mkv-writer.ts`), `reader.ts` (from `mkv-reader.ts`)
- Create (encoder side): `encoder/src/mux/node-io.ts` (`nodeRangeReader(path)`, `nodeFileSink(path)`)
- Modify: every encoder importer of the moved modules (`encode.ts`, `cli.ts`, `subs/episode-subtitles.ts`, `server/test-encode.ts`, `disc/pgs.ts`, `disc/pmt.ts`, `disc/probe.ts`, `package/*.ts`), `scripts/package-smoke.sh` (install list and barrel import), CLAUDE.md (eight packages), `encoder/src/mux/README.md`
- Move tests: `encoder/tests/mux/ebml.test.ts`, `mkv-writer.test.ts`, `encoder/tests/package/mkv-reader.test.ts`, `encoder/tests/helpers/ebml-reader.ts` users → `packages/matroska/src/*.test.ts` where they test the moved code (tests that need the encoder's tools stay in the encoder)

**Interfaces:**
- Produces:
  - `interface RangeReader { readonly size: number; read(offset: number, length: number, signal?: AbortSignal): Promise<Uint8Array> }`
  - `interface MkvSink { write(bytes: Uint8Array): Promise<void>; writeAt(position: number, bytes: Uint8Array): Promise<void>; close(): Promise<void> }`
  - `writeMatroska(sink: MkvSink, input: MkvInput): Promise<MkvResult>` (today's `writeMkv` body, writing through the sink; `MkvInput`, `MkvResult`, `MkvChapter`, track and attachment types unchanged in shape)
  - `readMatroska(reader: RangeReader): Promise<ParsedMkv>` (today's `readMkv` semantics over a `RangeReader`; `ParsedMkv`, `MkvTrack`, `MkvBlock`, `MkvReadError`, `NotMatroskaError` unchanged in shape; `blocks()` reads one cluster at a time)
  - encoder: `writeMkv(path, input)` and `readMkv(path)` stay as thin wrappers (`writeMatroska(nodeFileSink(path), input)`, `readMatroska(await nodeRangeReader(path))`), so encoder call sites change only their import path
- Rule: no `Buffer`, no `node:` import in `packages/matroska/src` (a test greps for it).

- [ ] **Step 1: Write the failing tests**: in `packages/matroska/src/`: `the package imports nothing from node and uses no Buffer` (reads every non-test source and asserts no `node:` and no `Buffer`); the moved writer and reader tests, rewritten against `writeMatroska`/`readMatroska` with an in-memory `MkvSink`/`RangeReader` (`memorySink()` and `memoryReader(bytes)` test helpers in `src/test-io.ts`, excluded from `files`); `a file written through the sink reads back with its tracks, attachments and chapters`.
- [ ] **Step 2: Run** `npx vitest run packages/matroska` — expected FAIL (package missing).
- [ ] **Step 3: Implement** the package (move with `git mv` where the file moves whole, then replace `Buffer` with `Uint8Array`/`DataView` and file I/O with the interfaces); the encoder's wrappers; package-smoke and CLAUDE.md.
- [ ] **Step 4: Run** `npx vitest run packages/matroska`, `npx vitest run --project encoder`, `npm run typecheck`, `npm run licence-check`, `npm run package-smoke`. Expected: PASS.
- [ ] **Step 5: Commit** — `refactor: @seikou/matroska, the encoder's Matroska writer and readers as a package`

### Task 2: Matroska reading for playback: Cues, seeking, chapter names, tags, lacing

**Files:**
- Create: `packages/matroska/src/playback.ts`, test `playback.test.ts`
- Modify: `writer.ts` (write `Tags` from `MkvInput.tags`; `MkvChapter` keeps `title` as the ChapterString), `index.ts`, README

**Interfaces:**
- Consumes: Task 1's `RangeReader`, `readMatroska` internals.
- Produces:
  - `MkvInput.tags?: Readonly<Record<string, string>>` (Segment-level SimpleTags, TargetTypeValue 50)
  - `openMatroska(reader: RangeReader, signal?: AbortSignal): Promise<MatroskaFile>` — reads the EBML header, the SeekHead and through it Info, Tracks, Attachments, Chapters, Tags and Cues without reading Clusters
  - `interface MatroskaFile { readonly durationMs: number; readonly tracks: readonly MkvTrack[]; readonly attachments: readonly MkvAttachedFile[]; readonly chapters: readonly MkvChapterInfo[]; readonly tags: Readonly<Record<string, string>>; blocksFrom(timeMs: number, signal?: AbortSignal): AsyncIterable<MkvBlock> }`
  - `MkvChapterInfo { startMs: number; endMs: number | null; name: string | null }`, `MkvAttachedFile { name: string; mediaType: string; data(): Promise<Uint8Array> }` (lazy)
  - `blocksFrom(t)`: starts at the cluster of the last video cue at or before `t`, and also at the earliest subtitle cue whose block is on screen at `t` (CueTime ≤ t < CueTime + CueDuration); yields blocks in file order; laced blocks (Xiph, EBML, fixed) are split into frames with their timestamps
- A file without Cues still plays from the start and seeks by scanning clusters (slow path).

- [ ] **Step 1: Write the failing tests**: `opens a written file and reads tracks, attachments, chapter names, tags and duration without reading clusters` (counting reader asserts no read past the first Cluster's header except Cues); `blocksFrom starts at the video key frame at or before the time`; `blocksFrom includes a subtitle block that started before the seek time and is still on screen`; `splits Xiph, EBML and fixed laced blocks`; `tags written through MkvInput.tags read back`; `a file without Cues seeks by scanning`.
- [ ] **Step 2: Run** — expected FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `npx vitest run packages/matroska` and the encoder project. Expected: PASS.
- [ ] **Step 5: Commit** — `feat(matroska): seeking, chapter names and tags for playback`

### Task 3: A committed encode fixture

**Files:**
- Create: `scripts/make-encode-fixture.ts` (uses the encoder's pipeline on `fixtures/synthetic/disc-speech` or `encoder/fixtures/disc-speech`: two episodes of about 20 s, AV1 + one Opus stereo track, one ASS track with a font attachment, one PGS track, chapters named `Avant`, `Opening`, `Part A`, `Ending`, `Preview`, tags with made-up AniList id `990001`, episodes 1 and 2), output `fixtures/encodes/990001/1.mkv`, `fixtures/encodes/990001/2.mkv`; `fixtures/encodes/README.md`
- Modify: `package.json` (`fixture:encodes` script), CLAUDE.md (fixtures paragraph), `tests/e2e/fixtures/nas-metadata.json` (made-up AniList entries 990001 and a sequel 990002 with a PREQUEL/SEQUEL relation)

**Interfaces:**
- Produces: the fixture files; their known facts in `fixtures/encodes/README.md` (durations, chapter starts, track list) for later tests.

- [ ] **Step 1:** Write the script (it needs VapourSynth, SvtAv1EncApp and opusenc, like `fixture:synthetic` needs ffmpeg). The encoder writes neither tags nor chosen chapter names yet (that is the encoder plan's work), so the script encodes with `encodeEpisodes`, then rewrites each MKV through `readMatroska` and `writeMatroska` with the chapter names and `MkvInput.tags` set (no re-encode).
- [ ] **Step 2: Run** `npm run fixture:encodes`; check with `readMatroska` that both files have the tracks, chapters and tags above (a small test `fixtures-encodes.test.ts` under `packages/matroska` reads them).
- [ ] **Step 3: Commit** the script and the output — `test: encoded-episode fixtures`

### Task 4: Server: `/encodes`, the index and range reads

**Files:**
- Create: `server/src/encodes/index-store.ts` (`EncodeIndex`), `server/src/encodes/node-reader.ts`, `server/src/routes/encodes.ts` (reads), `server/deploy/compose.encodes.yaml`
- Modify: `server/src/config.ts` (`encodesDir: string | null` from `ENCODES_DIR`), `server/src/app.ts` and `main.ts` (wire), `server/deploy/deploy.sh` (add `compose.encodes.yaml` when the NAS's `.env` sets `ENCODES_MOUNT`, as it does `compose.gpu.yaml`), `server/deploy/.env.example`, `docs/self-hosting.md`, `docs/nas.md`, CLAUDE.md (the constraint "writes only to its data volume and `/encodes`"), `tests/e2e/nas-server.ts` (`ENCODES_DIR`, fixture copy)
- Test: `server/src/encodes/index-store.test.ts`, `server/src/routes/encodes.test.ts`

**Interfaces:**
- Produces:
  - `EncodeEntry { id: string /* "<anilistId>-<episode>" */; anilistId: number; episode: number; episodeTitle: string | null; discKey: string | null; playlistId: string | null; episodeStartMs: number | null; path: string; size: number; mtimeMs: number; durationMs: number; chapters: MkvChapterInfo[]; tracks: { kind: 'video' | 'audio' | 'subtitle'; codec: string; language: string; name: string; isDefault: boolean; isForced: boolean }[] }`
  - `class EncodeIndex { constructor(opts: { dir: string; dataDir: string; log }); scan(): Promise<void>; list(): readonly EncodeEntry[]; get(id): EncodeEntry | null; unfiled(): readonly { path: string; size: number }[]; add(path): Promise<EncodeEntry>; remove(id): Promise<void> }` — `<dataDir>/encodes.json` (atomic), files under `<dir>/<anilistId>/<episode>.mkv`, `.partial` skipped, a file without `ANILIST_ID`/`EPISODE` is unfiled
  - Routes: `GET /api/encodes/status` → `{ configured: boolean; count: number }`; `GET /api/encodes/files/<id>` (ranges, 206/416, as disc files); `GET /api/encodes/manifest/<id>` → a `DiscManifest`-shaped `{ discId: id, name, files: [{ path: 'EPISODE.MKV', size }], inline: {} }` so `RemoteSource` reads it unchanged; device token required; title gate as the title routes.
- Consumes: `openMatroska` (Task 2) over `node-reader.ts`'s `RangeReader` on a file.

- [ ] **Step 1: Write the failing tests**: `scans the folder, files tagged MKVs and lists untagged ones as unfiled`; `skips .partial files`; `rescans only what changed (size, mtime)`; `serves a range of an episode with 206 and 416 out of range`; `status says not configured without ENCODES_DIR`; `a guest behind a closed gate gets 404`.
- [ ] **Step 2: Run** — FAIL. **Step 3: Implement.** **Step 4: Run** the server tests, `npm run server:build`, typecheck. PASS.
- [ ] **Step 5: Commit** — `feat(server): the encodes folder, its index and range reads`

### Task 5: Server: the upload API

**Files:**
- Create: `server/src/encodes/uploads.ts` (`UploadStore`), extend `routes/encodes.ts`
- Test: `server/src/encodes/uploads.test.ts`

**Interfaces:**
- Produces (owner device, HTTPS only: refused with 403 `https-only` when `viaChannel(req)`):
  - `POST /api/encodes/uploads` `{ size, sha256, name }` → `{ id }` (507 `no-room` when free space < size + 1 GiB margin; 409 `in-progress` when an upload for the same name is open)
  - `PUT /api/encodes/uploads/<id>` with `Content-Range: bytes a-b/size` → 204 (any order, re-sendable, at most 16 MiB a request)
  - `GET /api/encodes/uploads/<id>` → `{ size, ranges: [a, b][] }` (stored ranges)
  - `POST /api/encodes/uploads/<id>/complete` → checks size and SHA-256, reads tags; 422 `bad-tags` without `ANILIST_ID`/`EPISODE`; renames into `<dir>/<anilistId>/<episode>.mkv` (replacing an existing file only now), updates the index → `{ entry: EncodeEntry }`
  - `DELETE /api/encodes/uploads/<id>`; `DELETE /api/encodes/<id>` (owner) removes an encode
  - Uploads stored as `<dir>/.uploads/<id>.partial` plus a small ranges file; removed after 24 h untouched; never listed.
- Consumes: Task 4's `EncodeIndex.add`.

- [ ] **Step 1: Write the failing tests**: `an upload in three out-of-order chunks completes and files the episode`; `a wrong hash is refused and nothing is listed`; `replacing an episode keeps the old file until the new upload completes`; `a guest device gets 403`; `a WebRTC request gets 403 https-only`; `not enough room answers 507`; `an upload untouched for 24 h is removed` (injected clock); `missing tags answer 422 bad-tags`.
- [ ] **Step 2–4:** fail, implement, pass (server tests, typecheck).
- [ ] **Step 5: Commit** — `feat(server): resumable uploads of encoded episodes`

### Task 6: The encodes catalogue: AniList grouping

**Files:**
- Create: `packages/titles/src/encode-catalogue.ts`, test
- Modify: `packages/titles/src/catalogue.ts` (export the series rule it already has, `anilistSeries` and the story-link attachment, for reuse; no behaviour change), `server/src/titles/service.ts` (an `entriesFor(ids)` that loads AniList entries and their relation chain through the existing cache), `routes/encodes.ts` (library routes)
- Test: `packages/titles/src/encode-catalogue.test.ts`, route tests

**Interfaces:**
- Produces:
  - `buildEncodeCatalogue(entries: readonly EncodeEntry-like[], anilist: ReadonlyMap<number, Entry>): EncodeCatalogue` (pure) with `EncodeShow { id: string; name: string; poster: string | null; seasons: EncodeSeason[] }`, `EncodeSeason { anilistId: number; name: string; kind: 'season' | 'film' | 'other'; number: number | null; episodes: { episode: number; id: string; title: string | null; durationMs: number }[] }` — TV entries linked by PREQUEL/SEQUEL are seasons in order; films, OVAs and specials attach by the same story links as the disc catalogue; only entries with at least one encode are listed
  - `nextEncodeEpisode(catalogue, id): string | null` (next number in the season, else the first episode of the next season; null at the end)
  - Routes: `GET /api/encodes/shows` → `{ shows: { id, name, poster, episodeCount }[], unfiled?: { path, size }[] /* owners only */ }`; `GET /api/encodes/shows/<id>` → `EncodeShow`; the title gate applies
- Consumes: `EncodeIndex.list()`, `TitleService` cache and art (posters through `ArtCache` as the title routes do).

- [ ] **Step 1: Write the failing tests**: `two TV entries linked as sequels are one show with seasons 1 and 2`; `a film linked by SIDE_STORY attaches to the show`; `an entry with no encodes is not listed`; `next episode crosses into the next season and is null at the end`; route: `owners see unfiled files, guests don't`.
- [ ] **Step 2–4.** **Step 5: Commit** — `feat: the encodes library grouped by AniList`

### Task 7: Places and per-person player settings for encodes

**Files:**
- Modify: `packages/nas/src/disc-key.ts` (or a sibling `place-key.ts`: `parsePlaceKey(key): { kind: 'disc'; … } | { kind: 'encode'; anilistId: number; episode: number } | null`), `server/src/playback-store.ts`, `server/src/routes/playback.ts`, `packages/titles/src/up-next.ts` (encode places in their own list), `packages/nas/src/nas-api.ts`
- Create: `server/src/player-settings-store.ts` and route `GET/PUT /api/me/player-settings` → `{ nextEpisodeCountdown: boolean }`
- Test: the store and route tests, `up-next.test.ts`

**Interfaces:**
- Produces:
  - Place key `e.<anilistId>.<episode>` (validated: integers ≥ 1); places for it carry `mode: 'none'`, `playlistId: 'mkv'`, `psrs: []`
  - `GET /api/me/continue?library=encodes` (and the default stays discs) returns `ContinueItem`s for encodes (with `encodeId` set; `discKey`/`discId` empty) built from the encodes catalogue; `titleProgress` for an encode show
  - `PlayerSettings { nextEpisodeCountdown: boolean }`, default `false`, stored per person under `/data/users/<personId>/player-settings.json`
- Consumes: Task 6's catalogue and `nextEncodeEpisode`.

- [ ] **Step 1: Write the failing tests**: `an e. key stores and reads a place`; `a disc route answers 404 bad-key for an e. key`; `continue watching lists encodes only in the encodes list`; `up next after a finished encode episode is the next encode episode`; `player settings default to countdown off and are per person`.
- [ ] **Step 2–4.** **Step 5: Commit** — `feat: places, continue watching and player settings for encodes`

### Task 8: Engine: the encode session with AV1 video

**Files:**
- Modify: `packages/engine/src/protocol.ts` (first), `packages/engine/src/player.ts`, `packages/engine/src/decode/video-decoder.ts` (an AV1 `CodecOps`), `packages/engine/src/controller/player-controller.ts` (`openEncode`), `packages/engine/package.json` (depends on `@seikou/matroska`)
- Create: `packages/engine/src/encode/encode-session.ts`, `packages/engine/src/encode/encode-pipeline.ts`
- Test: `encode-session.test.ts`, `video-decoder.test.ts` additions

**Interfaces:**
- Produces:
  - Command `{ type: 'openEncode'; encode: EncodeSpec; startUs?: number }`, `EncodeSpec { base: string; token: string; manifest: DiscManifest; query?: string; fetchPort?: MessagePort; encodeId: string }`; controller `openEncode(spec: EncodeSpec, refreshToken?, startUs?)`
  - Snapshot: `encodeId: string | null`, `chapters` entries gain `name?: string` (the `Chapter` type in `nav/timeline.ts` gains an optional `name`; disc chapters leave it unset)
  - `EncodePipeline` reads `openMatroska` over the `RemoteSource` and drives the same `PipelineSinks` the M2TS pipeline drives (`video`, `audio`, `pg`, `isFull`, `ended`, `failed`), with read-ahead, backpressure and cancellation on seek as `PlaybackPipeline` has
  - Video coding id `CODING_AV1` (an engine-internal number outside the BD coding types), `CodecOps` from the track's `av1C` CodecPrivate (codec string `av01.P.LLT.DD…`) and the block's keyframe flag; the decoder takes AV1 temporal units as Matroska stores them (no Annex-B)
  - Event `{ type: 'unsupported'; reason: 'av1' }` when `isConfigSupported` says no (the UI shows the warning)
- Consumes: Task 2's `openMatroska`, `MatroskaFile.blocksFrom`.

- [ ] **Step 1: Write the failing tests** (fake `VideoDecoder`, fixture bytes from Task 3 through an in-memory `ByteSource`): `opens an encode and presents its first frame`; `seeking starts decoding at the key frame before the time`; `reports chapters with their names`; `reports unsupported av1 when the decoder config is not supported`.
- [ ] **Step 2–4.** **Step 5: Commit** — `feat(engine): play encoded episodes: the Matroska session and AV1 video`

### Task 9: Engine: Opus audio, ASS and PGS from the MKV, track selection

**Files:**
- Create: `packages/engine/src/decode/opus-decoder.ts` (WebCodecs `AudioDecoder` behind an injectable `AudioDecoderApi`, adapted to the engine's audio writer: its output is queued and handed on as `PcmChunk`s at 48 kHz), `packages/engine/src/encode/mkv-subtitles.ts` (an ASS script rebuilt from the track's CodecPrivate and its blocks for `TextSet`, with the MKV's font attachments; a `PgsControl` that feeds `PgSegmentDecoder` from `S_HDMV/PGS` blocks into the PG `OverlayPlane` without PSRs)
- Modify: `encode-session.ts`, `protocol.ts` (`selectEncodeTracks { audio: number; subtitle: number | 'off' }` or reuse `selectAudio`/`selectSubtitle` with the encode's track indexes), snapshot (`audioTracks`, `subtitles` filled from the MKV's tracks with names and languages)
- Test: `opus-decoder.test.ts` (fake `AudioDecoder`), `mkv-subtitles.test.ts`, session tests

**Interfaces:**
- Produces: audio from the default Opus track (else the first); the default subtitle track shown at open (a forced track always when its language matches the audio); switching tracks without reopening; stored and Tosho subtitles still go through `addTextSubtitles` and sit at time 0 of the episode.

- [ ] **Step 1: Write the failing tests**: `opus packets decode to 48 kHz PCM through the injected AudioDecoder`; `the ASS track renders its first Dialogue at its time with the attached font`; `a PGS display set shows at its time`; `switching audio track continues at the same time`; `a subtitle on screen at the seek time shows after the seek`.
- [ ] **Step 2–4.** **Step 5: Commit** — `feat(engine): Opus audio and the MKV's own subtitles`

### Task 10: UI: Discs and Encodes tabs, the Encodes screens

Load `frontend-design:frontend-design` first. The approved mockup: `.superpowers/brainstorm/77600-1794171082/content/library-tabs.html` (tabs under the app bar on a phone, full width, the selected one underlined in `--laser`; at the left of the bar on a wide screen).

**Files:**
- Modify: `src/ui/nas/nas-route.ts` (routes `encodes { q }` → `/nas/encodes`, `encodeShow { showId }` → `/nas/encodes/show/<id>`, `encodePlay { encodeId, timeS, resume }` → `/nas/encodes/play/<id>`), `src/ui/LandingScreen.tsx` (tabs), `src/ui/nas/nas-client.ts` (encodes methods), `src/ui/styles.css`
- Create: `src/ui/nas/LibraryTabs.tsx`, `src/ui/nas/EncodesLibrary.tsx`, `src/ui/nas/EncodeShowScreen.tsx`, `src/ui/nas/encodes-model.ts` (pure)
- Test: `encodes-model.test.ts`, `nas-route.test.ts` additions, component tests (jsdom)

**Interfaces:**
- Produces: the tabs on every NAS screen; the empty states (owner without `ENCODES_DIR`: "Set ENCODES_MOUNT on the NAS to hold encodes", with a help link; owner with it and nothing yet: "Encode an episode in Seikou encoder to add it here."; everyone else: "The library is currently empty." and "Encoded episodes appear here once the owner adds them."); the show grid with a Continue watching row (encodes); the show screen with seasons and episodes, progress marks and resume links; owners see "Not filed" files.

- [ ] **Step 1: Write the failing tests**: route round trips; `the encodes tab shows the owner's empty state without ENCODES_DIR`; `a guest sees the library is currently empty`; `the show screen lists seasons in order with progress`.
- [ ] **Step 2–4** (unit tests, typecheck, `npm run build`). **Step 5: Commit** — `feat(ui): Discs and Encodes tabs and the encodes library`

### Task 11: UI: the encode player: pre-flight, chapters, Skip, Next episode, countdown

Load `frontend-design:frontend-design` first.

**Files:**
- Create: `src/ui/chapter-actions.ts` (pure), `src/ui/NextEpisodeButton.tsx`, `src/ui/nas/EncodePreflight.tsx` (resume prompt as `ResumePrompt`; the AV1 check through `src/ui/video-caps.ts`)
- Modify: `src/ui/PlayerScreen.tsx`, `src/ui/ControlBar.tsx` (a chapter list with names for encodes), `src/ui/place-saver.ts` (encode places), `src/ui/place-apply.ts` (carry over by language to the next episode), `src/ui/nas/nas-client.ts` (player settings), a settings control for the countdown (in the player's settings menu)
- Test: `chapter-actions.test.ts`, `NextEpisodeButton.test.tsx`, PlayerScreen tests

**Interfaces:**
- Produces:
  - `chapterAction(chapters: { startUs: number; name?: string }[], timeUs: number, durationUs: number, hasNext: boolean): { kind: 'skip-opening' | 'skip-ending'; toUs: number } | { kind: 'next-episode' } | null` — during `Opening`: skip to the next chapter's start; during `Ending` with a chapter after it: skip-ending to that chapter; during `Ending` with nothing after it, or during a `Preview` after an `Ending`: next-episode when `hasNext`, else null
  - `NextEpisodeButton { countdown: boolean; seconds: 10; onNext(); onCancel() }`: with countdown, its fill drains over 10 s and calls `onNext` at the end; cancel stops the countdown and keeps the button
  - Next episode opens the next encode with the audio and subtitle choices carried by language and saves the finished place
- Consumes: Task 6's next episode (from the show data), Task 7's player settings, Task 8's chapter names.

- [ ] **Step 1: Write the failing tests**: `skip-opening jumps to the chapter after Opening`; `skip-ending when a chapter follows the Ending`; `next-episode during an Ending that nothing follows`; `next-episode during a Preview after the Ending`; `no next-episode action at the show's last episode`; `the countdown drains and calls onNext after 10 s` (fake timers); `cancel stops the countdown and keeps the button`; `without the setting the button shows and nothing advances`.
- [ ] **Step 2–4.** **Step 5: Commit** — `feat(ui): chapters, Skip and Next episode for encodes`

### Task 12: Subtitles menu for encodes, the AV1 warning, end-to-end and docs

**Files:**
- Modify: `src/ui/PlayerScreen.tsx` (Subtitles menu sources for encodes: the MKV's tracks; stored subtitles matched by the encode's `SEIKOU_DISC_KEY` and `SEIKOU_PLAYLIST`: an `episode` attachment on that disc and playlist shifted by `SEIKOU_EPISODE_START_MS`, a `chapter` attachment on the episode's first chapter unshifted; Anime Tosho search; own files), `src/ui/nas/subtitle-model.ts` (`storedForEncode(items, entry)` pure), the AV1 warning screen
- Create: `tests/e2e/encodes.spec.ts`
- Modify: CLAUDE.md, `docs/nas.md`, `docs/playing-discs.md` (or a new `docs/encodes.md` added to `HELP_PAGES`)

**Interfaces:**
- Produces: the E2E (Chrome; WebKit and Firefox skip with a reason where AV1 WebCodecs is missing): the Encodes tab lists the fixture show with two episodes; opening episode 1 plays (time advances); the chapter list shows `Opening`; Skip opening jumps past it; Next episode at the end opens episode 2; resume offers the saved place on reopening; an owner upload of a fixture through the API appears in the list; `a device without AV1 sees the warning and no file read` (forced with a test flag like `?nodecoder=1`, e.g. `?noav1=1`).

- [ ] **Step 1: Write** `storedForEncode` tests and the E2E.
- [ ] **Step 2: Run** — FAIL. **Step 3: Implement.** **Step 4: Run** `npm test`, `npm run typecheck`, `npm run build`, `npx playwright test tests/e2e/encodes.spec.ts`, `npx playwright test tests/e2e/nas.spec.ts` (no regressions), `npm run licence-check`, `npm run package-smoke`.
- [ ] **Step 5: Commit** — `feat: subtitles for encodes, the AV1 warning, end-to-end check and docs`
