# M3 Encoder Integration and Packaging Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `seikou-encode encode` reads the subtitle helper's saved record and writes each episode's MKV with every ticked audio stream (Opus each), the chosen ASS tracks retimed exactly as previewed, their fonts as attachments, the disc's PGS tracks, the title, names, languages, track order and default flags; `seikou-encode package` turns an episode MKV into a static web directory (WebM, ASS and fonts, `.sup` files, WebVTT chapters, a manifest).

**Architecture:** The encode keeps its streaming shape: one vspipe → SvtAv1EncApp chain for video and one vspipe → opusenc chain per audio stream, all read concurrently by the Matroska writer, which now takes any number of audio tracks plus subtitle tracks whose blocks are prepared in memory before the episode starts (ASS events from the record's cached tracks, PGS segments demuxed with `@seikou/bdmv`). Audio streams are chosen by PID and handed to BestSource by their position among the clip's audio streams in its PMT. Packaging is a separate step that reads a finished MKV back (a production EBML reader), so it works on any episode MKV and the encode can call it per episode.

**Tech Stack:** Node 24, TypeScript strict ESM, Vitest (`encoder` project), `@seikou/bdmv` (demux), `@seikou/fansubs` (`retime`), `@seikou/nas` (`FansubAlignment`). External processes only: `vspipe` + BestSource, `SvtAv1EncApp`, `opusenc`. Test oracle only: `ffprobe` when present.

**Spec:** `encoder/docs/superpowers/specs/2026-11-07-subtitle-helper-design.md` (milestone 3 of its section 7, and sections 5.4 and 6); parent `encoder/docs/superpowers/specs/2026-11-06-encoding-tools-design.md` (sections 2–4: formats, Opus rates, the static web directory). Read both, `encoder/README.md`, the area READMEs under `encoder/src/`, and the root `CLAUDE.md`.

## Scope

In: the record's use by `encode` (mismatch rule, `--no-subtitles`, missing cache), every ticked audio stream, ASS tracks and fonts, PGS passthrough, MKV title/names/languages/order/defaults, the `package` command and `encode --web DIR`.

Out: the jobs UI (milestone 4), the player (milestone 5), delivery (milestone 6), interlaced sources, filtering.

Decisions this plan makes where the specs leave a choice:
- **PGS tracks come from the disc, not the record.** The record has no PGS entries, so every PG stream of the playlist's STN table is muxed after the ASS tracks, named `<Language> (disc)` with the STN language, never default. `--no-pgs` leaves them out. (The helper's metadata panel can list them in a later milestone.)
- **Without a record** (none saved, or `--no-subtitles`): every audio stream is muxed in STN order, the first default, names from the language (`jpn` → `Japanese`); PGS as above; no ASS. With a record, its `metadata.audio` order and ticks rule; a stream in the playlist but missing from the record is left out with a warning.
- **Default flags:** the first included audio track; the first included ASS track; no PGS track. No subtitle track is default when the record ticks none.
- **ASS timing:** an episode's zero is its first video frame (as the helper's preview and alignment). The muxed events are `retime(retime(text, alignmentOf(track)), { kind: 'offset', offsetMs: nudgeMs })`, where `alignmentOf` is `split` parts when present, else `{ kind: 'offset', offsetMs: shiftMs }`, else original. A positive offset moves events later, the same sign as the engine's nudge. Events that end at or before 0, or start at or after the episode's duration, are dropped; a start before 0 is clamped to 0.
- **Font MIME types** (RFC 8081): `.ttf` `font/ttf`, `.otf` `font/otf`, `.ttc` `font/collection`, `.woff` `font/woff`, `.woff2` `font/woff2`. Attachment file names come from the cached release's font list, else the pooled file's name.
- **Audio stream to BestSource:** `AudioSource(track=-n)` selects the n-th audio stream libavformat finds, which follows the PMT. The encoder reads each clip's PAT/PMT itself, counts audio stream types (0x80–0x86, 0xA1, 0xA2) in PMT order, and fails with the PIDs named when the PMT is missing from the clip's first 1,000 packets or a planned PID is not in it. After decoding starts, the WAV header's channel count and sample rate must match the stream's CLPI attributes; a mismatch fails the episode naming the PID (a guard against a silently wrong language).
- **Opus:** 160 kb/s for 1–2 channels, 320 kb/s otherwise (parent spec), `--opus-bitrate` overrides all streams.
- **Web directory layout:** `<web>/<name>/` with `video.webm` (AV1 + every Opus track, chapters, no attachments), `subs/<n>-<lang>-<kind>.ass`, `fonts/<file>`, `pgs/<n>-<lang>.sup`, `chapters.vtt`, and `episode.json` (the manifest the player milestone will read). `encode --web DIR` packages each episode after its MKV is complete.

## Global Constraints

- License: every new file starts with `// SPDX-License-Identifier: LGPL-3.0-or-later`. `npm run licence-check` stays green.
- No ffmpeg anywhere in `encoder/src`. `ffprobe` only in tests as an oracle, skipped when absent.
- Documentation standard (spec §4), checked by `encoder/tests/docs.test.ts` and every review: every exported function, class, interface, type and constant has a doc comment saying what it is for and what a caller must know; format code names each field and cites its specification section (RFC 9559 for Matroska elements, the Matroska codec specifications for `S_TEXT/ASS` and `S_HDMV/PGS`, ISO/IEC 13818-1 for PAT/PMT and PES, the WebM container guidelines); comments never cite rulings, task numbers, milestone labels or internal spec section numbers; each area's README is updated with what the task adds.
- Timing units in identifiers: `*45`, `*90`, `*Ms`, `*Ns`, `*48`.
- Nothing media-like is written to disk except the MKV, the web directory and BestSource index files; a failed episode deletes its partial MKV and partial web directory.
- Made-up names only in fixtures, tests, docs and commits (the repo is public).
- Tests that need the tools use `describe.skipIf(!haveTools)` from `encoder/tests/helpers/tools.ts`.
- Commands: `npx vitest run --project encoder`, `npm run typecheck`.
- Commit messages end with:
  ```
  Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
  Claude-Session: https://claude.ai/code/session_01VgtGbXVjADUNZTpv1LrJbZ
  ```
- Never push.

## Review Focus

1. **The wrong audio stream under the right label**: a disc whose STN, CLPI and PMT list audio in different orders, or a playlist whose clips order them differently. Expected: each muxed track decodes from the PID its label names, or the episode fails naming the PID. Test in Task 2 (`maps PIDs by PMT position per clip`, `fails when the PMT lacks a planned PID`) and Task 4 (`channel guard fails on a mismatched stream`, with disc3's 5.1 AC-3 against its stereo LPCM).
2. **A nudge applied with the wrong sign or twice**: Expected: an event at 10.00 s with `shiftMs: 1200, nudgeMs: -42` is muxed at 11.158 s. Test in Task 5 (`applies shift then nudge`).
3. **PGS cut mid-epoch at an episode start**: the first display set inside an episode may depend on an earlier epoch. Expected: blocks start at the first Epoch Start or Acquisition Point composition at or after the episode start; nothing before it. Test in Task 6 (`starts at the first epoch start or acquisition point`).
4. **A record that no longer fits the encode** (other episode spec or playlist, cache cleared): Expected: exit 2 naming both specs; exit 1 naming the release for missing files; `--no-subtitles` encodes regardless. Test in Task 1.
5. **WebM that browsers refuse**: an ASS or PGS track, an attachment, or a non-WebM element leaking into `video.webm`. Expected: DocType `webm`, only `V_AV1` and `A_OPUS` tracks, no Attachments or Tags. Test in Task 8 (ffprobe and the EBML reader).

---

### Task 1: The encode reads the record

**Files:**
- Create: `encoder/src/disc/disc-key.ts` (moved out of `encoder/src/server/disc-routes.ts`), `encoder/src/subs/encode-record.ts`
- Modify: `encoder/src/server/disc-routes.ts` (import the moved function), `encoder/src/cli.ts`, `encoder/src/encode.ts`
- Test: `encoder/tests/subs/encode-record.test.ts`, `encoder/tests/cli.test.ts`

**Interfaces:**
- Produces:
  - `discKeyOfFolder(discDir: string): Promise<{ key: string; label: string }>` in `disc/disc-key.ts` (the helper backend's computation, unchanged in result).
  - `class RecordMismatchError extends Error` (exit 2) and `class MissingSubtitleFilesError extends Error` (exit 1; message names each release label).
  - `loadEncodeRecord(o: { discDir: string; playlistId: string; episodeSpec: string; dataDir: string; noSubtitles: boolean }): Promise<SubtitleRecord | null>`: null with `noSubtitles` or no saved record; throws `RecordMismatchError` (`"The saved subtitle choices are for playlist 00001 episodes 1-3,4-5; this encode asks for 00000 episodes 1-4. Re-save them in the helper or pass --no-subtitles."`) when the playlist or episode spec differ; throws `MissingSubtitleFilesError` when `RecordStore.missingFiles` reports any.
  - `EncodeOptions` gains `dataDir: string`, `noSubtitles: boolean`, `noPgs: boolean`, `webDir?: string`; CLI flags `--no-subtitles`, `--no-pgs`, `--web DIR`.

- [ ] **Step 1: Write the failing tests**: `no record gives null`; `--no-subtitles ignores a mismatched record`; `a record for another spec throws RecordMismatchError naming both`; `a record whose track file is gone throws naming the release`; CLI: `encode with a mismatched record exits 2`; `the helper backend's disc key is unchanged after the move` (server test still passes).
- [ ] **Step 2: Run to see them fail** — `npx vitest run --project encoder encoder/tests/subs/encode-record.test.ts encoder/tests/cli.test.ts`.
- [ ] **Step 3: Implement.** `encodeEpisodes` calls `loadEncodeRecord` before planning; its result is threaded to later tasks' code as `record` (unused in this task beyond validation).
- [ ] **Step 4: Run** the encoder project and `npm run typecheck`. Expected: PASS.
- [ ] **Step 5: Commit** — `feat(encoder): encode reads the helper's saved record`

---

### Task 2: PMT reading and audio stream selection

**Files:**
- Create: `encoder/src/disc/pmt.ts`, `encoder/src/plan/audio-streams.ts`
- Create: `encoder/fixtures/disc3/` (copy of `fixtures/synthetic/disc3`, PMT-patched with `npx tsx encoder/scripts/patch-fixture-pmt.ts encoder/fixtures/disc3`), `encoder/fixtures/disc-subs/` (same for `fixtures/synthetic/disc-subs`); note both in `encoder/fixtures/README.md`
- Modify: `encoder/src/plan/episodes.ts` (a segment carries one `audioTracks` entry per selected stream)
- Test: `encoder/tests/disc/pmt.test.ts`, `encoder/tests/plan/audio-streams.test.ts`

**Interfaces:**
- Produces:
  - `readPmt(m2tsPath: string, maxPackets = 1000): Promise<{ pmtPid: number; streams: { pid: number; streamType: number }[] }>` (PAT §2.4.4.3, PMT §2.4.4.8 of ISO/IEC 13818-1; the first section of each; throws `PmtError` naming the clip when absent).
  - `audioTrackIndex(pmt, pid): number`: the 1-based position of `pid` among PMT audio stream types (0x80–0x86, 0xA1, 0xA2); throws `PmtError` naming the PID and the PMT's PIDs.
  - `interface SelectedAudio { pid: number; name: string; language: string; isDefault: boolean; codingType: number; channels: number; sampleRate: number }` and `selectAudio(playlist: Playlist, probes: Map<string, ClipProbe>, record: SubtitleRecord | null, episodeIndex: number): SelectedAudio[]` (rules in Scope; STN language, `und` when empty; names via `Intl.DisplayNames`).
  - `Segment.audioTracks: { pid: number; bsTrack: number; samples: [number, number] }[]` replacing the single `audioSamples` (sample ranges per stream, each from that stream's rate and the video's first PTS as before); `planEpisodes(playlist, probes, specs, audio: SelectedAudio[], pmts: Map<string, PmtInfo>)`.

- [ ] **Step 1: Write the failing tests**: `reads disc3's PMT in order` (0x1011 video, then 0x1100–0x1103); `maps PIDs by PMT position per clip` (a synthetic two-clip PMT pair where clip 2 lists the audio PIDs reversed: segment 2's `bsTrack` follows clip 2's order); `fails when the PMT lacks a planned PID`; `fails on a clip with no PMT in its first packets`; `selectAudio without a record takes every stream, first default`; `selectAudio follows the record's order and ticks`; `a stream missing from the record is left out with a warning`; existing episode-plan tests updated for `audioTracks`.
- [ ] **Step 2: Run to see them fail.**
- [ ] **Step 3: Copy and patch the two fixtures**, then implement. If the patcher refuses a clip for lack of null packets, report it rather than editing the fixture by hand.
- [ ] **Step 4: Run** the encoder project and `npm run typecheck`. Expected: PASS.
- [ ] **Step 5: Commit** — `feat(encoder): choose audio streams by PID through each clip's PMT`

---

### Task 3: Matroska writer: many tracks, subtitles, attachments

**Files:**
- Modify: `encoder/src/mux/mkv-writer.ts`, `encoder/src/mux/mkv-ids.ts`, `encoder/src/mux/README.md`
- Test: `encoder/tests/mux/mkv-writer.test.ts` (extend; read back with `encoder/tests/helpers/ebml-reader.ts`)

**Interfaces:**
- Produces: `MkvInput` becomes
  - `title?: string`; `video: VideoTrackInfo & TrackLabel`; `audio: (AudioTrackInfo & TrackLabel & { packets: AsyncIterable<OpusPacket>; end: Promise<{ discardPadding48: number }> })[]`;
  - `subtitles: (TrackLabel & { codecId: 'S_TEXT/ASS' | 'S_HDMV/PGS'; codecPrivate?: Uint8Array; blocks: readonly SubtitleBlock[] })[]` with `SubtitleBlock = { timeMs: number; durationMs?: number; data: Uint8Array }` (sorted by `timeMs`; `durationMs` written as `BlockDuration` in a `BlockGroup`, otherwise a `SimpleBlock`);
  - `attachments: { name: string; mediaType: string; data: Uint8Array }[]`;
  - `chapters: MkvChapter[]`; `TrackLabel = { name: string; language: string; isDefault: boolean }`.
  - Track numbers: video 1, then audio in order, then subtitles in order. `FlagDefault` written explicitly (0 or 1) on every track; `Name` and `Language` on every track; `FlagLacing 0` on subtitle tracks.
  - Attachments element after Tracks (before Chapters), indexed in the SeekHead; `FileUID` random 64-bit, `FileDescription` omitted.
  - Interleaving: blocks of every track are written in timestamp order within clusters opened at video key frames; a subtitle or audio block whose offset from its cluster's timestamp would not fit the signed 16-bit field opens a new cluster at that block.

- [ ] **Step 1: Write the failing tests**: `writes two audio tracks with names, languages and one default`; `writes an ASS track with CodecPrivate and BlockGroups with BlockDuration`; `writes a PGS track as SimpleBlocks`; `writes attachments with MIME types and lists them in the SeekHead`; `orders blocks by time across tracks`; `a subtitle block 40 s after the last key frame opens a new cluster`; existing single-audio tests adapted to the new input shape.
- [ ] **Step 2: Run to see them fail.**
- [ ] **Step 3: Implement** (element IDs with their RFC 9559 sections in `mkv-ids.ts`).
- [ ] **Step 4: Run** the encoder project and `npm run typecheck`. Expected: PASS (the M1 encode integration test keeps passing after Task 4 adapts `encode.ts`; until then adapt `encode.ts` minimally to the new input with one audio track).
- [ ] **Step 5: Commit** — `feat(encoder): Matroska writer takes many audio tracks, subtitles and attachments`

---

### Task 4: Every ticked audio stream through its own Opus chain

**Files:**
- Modify: `encoder/src/pipeline/vpy.ts` (`buildAudioScript(plan, opts, trackIndex)` builds one stream's script with each segment's `bsTrack`), `encoder/src/encode.ts`, `encoder/src/pipeline/README.md`
- Create: `encoder/src/pipeline/wav-guard.ts`
- Test: `encoder/tests/pipeline/vpy.test.ts`, `encoder/tests/pipeline/wav-guard.test.ts`, `encoder/tests/encode.test.ts` (extend)

**Interfaces:**
- Consumes: `SelectedAudio`, `Segment.audioTracks` (Task 2), the writer input (Task 3), `opusArgs(channels, bitrate)`.
- Produces: `guardWav(stream: Readable, expected: { pid: number; channels: number; sampleRate: number }): Readable`, a pass-through that reads the WAV header (reuse `readWav`'s header parsing from `encoder/src/audio/wav.ts` by exporting a `parseWavHeader`) and errors the stream with `"PID 0x1101: BestSource gave 2 channels at 48000 Hz; the disc says 6 channels at 48000 Hz"` on a mismatch. The audio chain becomes `vspipe -c wav → guardWav → opusenc` (the chain module spawns opusenc with the guarded stream as its stdin).

- [ ] **Step 1: Write the failing tests**: `audio script uses each segment's bsTrack`; `guardWav passes a matching header through unchanged`; `guardWav fails on a channel mismatch naming the PID`; `channel guard fails on a mismatched stream` (unit: a header for 2 channels against an expectation of 6); integration (`describe.skipIf(!haveTools)`): `encodes disc3 with four Opus tracks` — ffprobe (when present) reports 1 video and 4 Opus tracks with channels `[2, 6, 2, 6]` and languages `jpn, eng, eng, fra`; the existing disc1 encode test still passes.
- [ ] **Step 2: Run to see them fail.**
- [ ] **Step 3: Implement.** All chains start before any reader awaits (as M1 does for its two chains); a failure in any chain kills the others and deletes the partial MKV.
- [ ] **Step 4: Run** the encoder project and `npm run typecheck`. Expected: PASS (report whether the tools tests ran).
- [ ] **Step 5: Commit** — `feat(encoder): encode every chosen audio stream to its own Opus track`

---

### Task 5: ASS tracks and fonts from the record

**Files:**
- Create: `encoder/src/mux/ass-track.ts`, `encoder/src/subs/episode-subtitles.ts`
- Test: `encoder/tests/mux/ass-track.test.ts`, `encoder/tests/subs/episode-subtitles.test.ts`

**Interfaces:**
- Consumes: `retime` (`@seikou/fansubs`), `SubtitleRecord`, `ReleaseCache` (for font names), writer types (Task 3).
- Produces:
  - `assToMatroska(script: string, durationMs: number): { codecPrivate: Uint8Array; blocks: SubtitleBlock[] }`: CodecPrivate is the script without its `Dialogue:` lines (the `[Events]` `Format:` line kept); each Dialogue becomes a block `ReadOrder,Layer,Style,Name,MarginL,MarginR,MarginV,Effect,Text` (the Matroska codec specification's `S_TEXT/ASS` layout) with `timeMs` = start and `durationMs` = end − start; `Comment:` lines dropped; the drop and clamp rules from Scope applied.
  - `episodeSubtitleTracks(record: SubtitleRecord, episodeIndex: number, durationMs: number, dataDir: string): Promise<{ tracks: MkvInput['subtitles']; attachments: MkvInput['attachments'] }>`: included tracks in record order, timed per Scope, the first default; fonts from `record.fonts` with MIME types per Scope and names from the cached release when it has them.

- [ ] **Step 1: Write the failing tests**: `splits a script into CodecPrivate and blocks`; `ReadOrder counts Dialogue lines in file order`; `applies shift then nudge` (an event at 0:00:10.00 with `shiftMs: 1200, nudgeMs: -42` → `timeMs` 11158); `applies split parts by the event's start`; `drops events outside the episode and clamps a negative start`; `unticked tracks are left out and the first included is default`; `fonts get RFC 8081 types and their release names`.
- [ ] **Step 2: Run to see them fail.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** the encoder project and `npm run typecheck`. Expected: PASS.
- [ ] **Step 5: Commit** — `feat(encoder): ASS tracks and fonts from the saved record`

---

### Task 6: PGS passthrough

**Files:**
- Create: `encoder/src/disc/pgs.ts`
- Test: `encoder/tests/disc/pgs.test.ts`

**Interfaces:**
- Consumes: `M2tsReader`, `PesAssembler` (`@seikou/bdmv`), `EpisodePlan` segments (clip byte ranges from the CLPI EP map as `probe.ts` and Seikou's `disc-audio.ts` find them), `SubtitleBlock`.
- Produces: `episodePgsTracks(plan: EpisodePlan, playlist: Playlist): Promise<MkvInput['subtitles']>`: one track per STN PG stream (name `<Language> (disc)`, never default); each PES payload one block at its PTS rebased to the episode's first video frame across clips (33-bit wrap handled as `probe.ts` does), blocks before the first composition segment (type 0x16) whose `composition_state` is Epoch Start (0x80) or Acquisition Point (0x40) at or after the episode start dropped; blocks at or after the episode end dropped. `encodeEpisodes` skips it under `--no-pgs`.

- [ ] **Step 1: Write the failing tests** (on `encoder/fixtures/disc-subs`): `finds both PG streams with their STN languages`; `block times are relative to the episode's first frame`; `starts at the first epoch start or acquisition point` (an episode starting mid-epoch, built by planning from the second chapter); `a disc without PG gives no tracks`.
- [ ] **Step 2: Run to see them fail.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run.** Expected: PASS.
- [ ] **Step 5: Commit** — `feat(encoder): carry the disc's PGS tracks into the episode`

---

### Task 7: Everything into the episode MKV

**Files:**
- Modify: `encoder/src/encode.ts`, `encoder/README.md`
- Test: `encoder/tests/encode.test.ts` (extend)

**Interfaces:**
- Consumes: Tasks 1–6.
- Produces: per episode the MKV gets `title` from `record.episodes[i].metadata.title` (else `--title`), video name and language from the record (else empty and `und`), chapter titles from the record (else `Chapter n`), the audio tracks (Task 4), the ASS tracks and attachments (Task 5), then the PGS tracks (Task 6).

- [ ] **Step 1: Write the failing tests** (`describe.skipIf(!haveTools)`): `encodes disc-speech episode 1 with the saved record` (a record written in the test with GroupA's tracks from the recorded fixtures in `encoder/tests/fixtures/fansubs`, cached through `ReleaseCache`, shift 1200 and nudge 42): read back with the EBML reader — Title `Lantern Harbor - 01 - Arrival`, tracks in order video, Opus `jpn`, ASS full (default), ASS signs, one attachment `DejaVuSansMono.ttf` `font/ttf`, the first ASS block at the fixture's first line + 1242 ms; `encodes disc-subs with its two PGS tracks`; `--no-pgs leaves them out`; ffprobe (when present) opens each output and lists the same streams.
- [ ] **Step 2: Run to see them fail.**
- [ ] **Step 3: Implement**; README: what the MKV now carries and the new flags.
- [ ] **Step 4: Run** the encoder project and `npm run typecheck`. Expected: PASS.
- [ ] **Step 5: Commit** — `feat(encoder): episodes carry the record's subtitles, fonts and names`

---

### Task 8: The `package` command and `encode --web`

**Files:**
- Create: `encoder/src/mux/ebml-reader.ts` (promoted from `encoder/tests/helpers/ebml-reader.ts`, which then re-exports it), `encoder/src/package/package.ts`, `encoder/src/package/webm.ts`, `encoder/src/package/sup.ts`, `encoder/src/package/vtt.ts`, `encoder/src/package/README.md`
- Modify: `encoder/src/cli.ts`, `encoder/src/encode.ts`, `encoder/README.md`
- Test: `encoder/tests/package/*.test.ts`

**Interfaces:**
- Produces:
  - `readMkv(path: string): Promise<ParsedMkv>` (streaming: tracks, attachments, chapters, title, and an async iterator of blocks with track number, time and data).
  - `writeWebm(mkv: ParsedMkv, path: string): Promise<void>`: DocType `webm`, only `V_AV1` and `A_OPUS` tracks (renumbered from 1), chapters kept, Cues on video key frames, no Attachments or Tags (WebM container guidelines).
  - `toSup(blocks: AsyncIterable<SubtitleBlock>): Uint8Array`: each segment of each block as `"PG"`, PTS (90 kHz, 32 bits), DTS 0, then the segment.
  - `toVtt(chapters: MkvChapter[], durationMs: number): string` (`WEBVTT`, one cue per chapter ending at the next).
  - `packageEpisode(mkvPath: string, outDir: string): Promise<EpisodeManifest>` writing the layout in Scope; ASS files rebuilt from CodecPrivate + blocks in ReadOrder order; `episode.json` = `{ title, video: { file, width, height }, audio: { index, name, language, default }[], subtitles: { file, name, language, default }[], pgs: { file, name, language }[], fonts: string[], chapters: 'chapters.vtt' }`.
  - CLI `seikou-encode package <episode.mkv> --out DIR`; `encode --web DIR` packages each episode after its MKV, into `DIR/<name>/`; a failure removes the partial directory.

- [ ] **Step 1: Write the failing tests**: `the WebM has only AV1 and Opus and DocType webm` (EBML reader; ffprobe when present); `the rebuilt ASS file equals the muxed script's events in order`; `the .sup file starts with a PG header carrying the first block's PTS`; `chapters.vtt has one cue per chapter`; `episode.json lists every file and the defaults`; `package fails cleanly on a file that is not Matroska`; integration (`skipIf(!haveTools)`): `encode --web writes the directory for each episode`.
- [ ] **Step 2: Run to see them fail.**
- [ ] **Step 3: Implement**; README for `package/`.
- [ ] **Step 4: Run** the encoder project and `npm run typecheck`. Expected: PASS.
- [ ] **Step 5: Commit** — `feat(encoder): package an episode MKV into a static web directory`

---

### Task 9: Documentation and a real-disc check

**Files:**
- Modify: `encoder/README.md`, `CLAUDE.md` (the `seikou-encode` bullet: `encode` reads the record, `--no-subtitles`, `--no-pgs`, `--web`, `package`), `encoder/docs/superpowers/specs/2026-11-07-subtitle-helper-design.md` (status line: milestone 3 done, with the date)

- [ ] **Step 1: Update the documentation** listed under Files.
- [ ] **Step 2: Full verification** — `npm run typecheck && npm test && npm run licence-check && npx playwright test -c playwright.encoder.config.ts`. Expected: all pass (record any known flake by name).
- [ ] **Step 3: Real-disc check (the user's)**: the plan's executor stops here and asks the user to run one episode of a real disc with a saved record and `--web`, and to check in mpv that the subtitles are timed as previewed, the fonts render, audio languages are right, and the PGS track shows; their findings decide whether anything is reopened.
- [ ] **Step 4: Commit** — `docs(encoder): the encode reads the record; packaging`
