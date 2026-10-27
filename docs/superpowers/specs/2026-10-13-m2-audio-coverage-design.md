# Milestone 2: Audio Coverage — Design Spec

Date: 2026-10-13
Status: Done; merged and pushed 2026-10-13 (2e59954); real-disc gate passed 2026-10-13.
Parent spec: `2026-10-12-bluray-web-player-design.md` (§11, milestone 2)

## 1. Goal and scope

Play the audio tracks found on real Blu-ray discs, and let the user switch between them.

In scope:

- AC-3 and E-AC-3 decoding through FFmpeg's libavcodec, compiled to WASM.
- TrueHD played through its interleaved AC-3 core.
- DTS, DTS-HD High Resolution and DTS-HD Master Audio played through their DTS core (`core_only`). This moves DTS out of the parent spec's later "codec gaps" phase and into M2.
- Audio track switching: a `tracks` event, a `selectAudio` command, an audio menu and the `A` key.
- Resolving audio PIDs per play item. Today one PID taken from the first play item is used for the whole playlist.

Out of scope:

- Lossless TrueHD (MLP) and DTS-HD XLL decoding. Output is downmixed to stereo at 48 kHz, so core decoding loses nothing audible.
- Secondary audio streams (`0xa1` E-AC-3 secondary and `0xa2` DTS-HD secondary), which exist for picture-in-picture commentary mixing. They are listed in the menu but disabled.
- WebCodecs `AudioDecoder` for Dolby audio. Support differs by build and platform. It could be added behind the same decoder interface later.
- Remembering a language preference, and PSR1. The HDMV register file comes in M3.

Decisions taken during brainstorming:

| Question | Decision |
|---|---|
| Decoder source | FFmpeg (LGPL) built to WASM with emscripten in Docker; the binary is committed and its build is checked as reproducible. Not a TypeScript port (high risk; liba52 is GPL). Not WebCodecs (inconsistent support). |
| Track switching | A brief re-seek to the current time with the new stream. Not a seamless switch. |
| DTS | Included, core only. |
| Validation | A real decrypted disc with Dolby and DTS tracks under `fixtures/local/` gates completion, alongside synthetic fixtures for CI. |

## 2. Components

### 2.1 `src/wasm/audio/` (LGPL-2.1)

- `build.sh` runs `emscripten/emsdk` (pinned by image digest) in Docker.
  - It fetches FFmpeg at a git tag pinned in the script.
  - It configures FFmpeg with `--disable-everything --enable-decoder=ac3,eac3,dca --disable-asm --disable-programs`, plus `-Oz` and no threads.
  - It sets `SOURCE_DATE_EPOCH` and fixed flags so the output is byte-for-byte reproducible.
  - It writes `audio.wasm` and `audio.wasm.sha256`.
- `shim.c` exposes a C ABI with no emscripten JS glue:
  - `int audio_open(int codec)`: codec 0 = AC-3/E-AC-3, codec 1 = DTS. Codec 0 opens FFmpeg's `eac3` decoder. It shares its code with the `ac3` decoder and picks AC-3 or E-AC-3 per frame from `bsid`, so one handle covers both. The function returns a handle. It sets `downmix=stereo` and, for DTS, `core_only=1`.
  - `int audio_decode(int h, const uint8_t *in, int len, float *out, int max_frames)`: decodes one access unit: one frame, or for E-AC-3 an independent frame together with the dependent-substream frames that follow it. It returns the number of frames written as interleaved stereo float, or a negative error code. The sample rate is read back with `audio_sample_rate(h)`.
  - `void audio_reset(int h)` (calls `avcodec_flush_buffers`) and `void audio_close(int h)`.
  - It exports `malloc` and `free` for the input and output buffers.
- `NOTICE` names the FFmpeg tag, the configure line and the source URL. `src/engine/NOTICE` points to it.
- `npm run wasm:build` runs the script.

### 2.2 `src/engine/decode/wasm-audio.ts`

Deviation: frame splitting is in `src/engine/decode/audio-frames.ts` (`AudioFramer`), not here.

- `loadAudioWasm(url)` compiles the module once per worker with `WebAssembly.instantiateStreaming`. It falls back to `instantiate(bytes)` in Node for tests. Its import object supplies only memory growth and `abort`.
- `WasmFrameDecoder(wasm, codec)` decodes one whole frame at a time (`decode(frame)`), with `reset()` and `close()`. The splitting below happens in `AudioFramer`, which keeps a carry buffer and splits frames on sync words: AC-3 and E-AC-3 `0x0B77` (frame size from the header), DTS core `0x7FFE8001` (frame size from the header).
  - E-AC-3 dependent-substream frames (`strmtyp` 1, as used for 7.1 on Blu-ray) are grouped with the independent frame before them into one access unit. FFmpeg mixes them into the downmix.
  - A DTS-HD extension substream (`0x64582025`) that follows a core frame is skipped. FFmpeg ignores it in core-only mode anyway.
  - Timestamps: the PES PTS belongs to the first frame that starts in that PES. Every later frame (including one carried into the next PES) gets the previous PTS plus its duration: 1536 samples for AC-3, 256 × number of blocks for E-AC-3, and samples per frame from the header for DTS.
  - A sample rate other than 48 kHz throws `UnsupportedCodecError` (only until the decoder has produced 48 kHz output; after that such a frame is counted as failed and skipped). A reduced-rate E-AC-3 header is treated as no sync.

### 2.3 `src/engine/decode/truehd-core.ts`

- `extractAc3Core(unit)` returns the unit when its PES `stream_id_extension` is `0x76` (the AC-3 substream) and `null` when it is `0x72` (MLP). This is how libavformat's `mpegts.c` separates them.
- `demux/pes-assembler.ts` exposes `streamIdExtension` on `PesPacket` for `stream_id 0xFD` packets that have `PES_extension_flag_2` set. `PipelineUnit` carries it through.

### 2.4 `src/engine/decode/audio-decoder.ts`

`interface AudioDecoder { decode(unit): PcmChunk[]; reset(): void; close(): void }` and an async `createAudioDecoder(codingType)` that maps coding types to decoders:

| Coding type | Decoder |
|---|---|
| `0x80` LPCM | the existing `decodeLpcm`, wrapped |
| `0x81` AC-3, `0x84` E-AC-3 | WASM, AC-3 mode |
| `0x83` TrueHD | `extractAc3Core`, then WASM in AC-3 mode |
| `0x82` DTS, `0x85` DTS-HD HR, `0x86` DTS-HD MA | WASM, DTS mode |

`PLAYABLE_AUDIO` in `playback/stream-selection.ts` becomes `{0x80, 0x81, 0x82, 0x83, 0x84, 0x85, 0x86}`.

## 3. Data flow inside `Player`

### 3.1 Choosing tracks by stream number

- A Blu-ray audio track is a position in the STN table, and each play item has its own STN. The same track can use a different PID (or, rarely, codec) in different play items.
- The session stores `audioStream: number | null`, a 1-based STN index.
- `PipelineConfig.audioPid` is replaced by `audioStream`. At the start of each play item the pipeline resolves the PID from `item.stn.audio[audioStream - 1]` (main path only).
  - Each audio unit reaches the sink tagged with that entry's `codingType`.
  - A play item without the stream produces no audio for that item, see `docs/known-issues.md`.
- Initial choice: the first main-path stream in STN order whose coding type is in `PLAYABLE_AUDIO`. This is the existing rule, applied by index.

### 3.2 Decoders in the session

- The session holds `audioDecoders: Map<codingType, AudioDecoder>`, filled lazily. This covers playlists whose items mix codecs.
- `onAudioUnit` decodes through the map. Each `PcmChunk` goes through the existing decimator (96 and 192 kHz LPCM only), then into `AudioWriter.enqueue`.
- `startAt` awaits `ensureAudioDecoder(codingType)` for the selected stream, as found in the play item that contains the start time, before `pipeline.start`. The state stays `buffering`, so no units are dropped while the WASM compiles. Only the first load in a worker pays the compile cost; later instances reuse the module.
- `startAt` calls `reset()` on every decoder in the map. Teardown calls `close()`.

### 3.3 Switching tracks

On `selectAudio { index }`:

1. If there is no session, or the index is unplayable, out of range or already selected, nothing happens.
2. Otherwise set `s.audioStream = index` and emit `tracks`.
3. Call `startAt(clock.nowUs(), wantPlaying)`. A paused player stays paused at the same time. If audio had been disabled (a failed load, or too many errors) and a ring is attached, `startAt` re-arms `audioActive`.

## 4. Protocol and UI

### 4.1 Protocol (`src/engine/protocol.ts`)

```ts
interface AudioTrack {
  readonly index: number;      // 1-based STN position
  readonly codec: string;      // codingName(), e.g. "DTS-HD Master Audio"
  readonly language: string;   // ISO 639-2 from the STN, '' if absent
  readonly channels: "mono" | "stereo" | "multichannel" | '';   // from STN audio_format; '' if unknown
  readonly playable: boolean;
}

// EngineEvent
| { readonly type: 'tracks'; readonly audio: readonly AudioTrack[]; readonly selectedAudio: number | null }
// EngineCommand
| { readonly type: 'selectAudio'; readonly index: number }
// NoticeCode gains 'audio-track'
```

- `tracks` is emitted after `chapters` when a playlist starts, and after every switch. The list comes from the first play item's STN.
- `Telemetry` gains `audioCodec: string | null` (the coding name of the decoder that last produced PCM) and `audioDecodeErrors: number`.

### 4.2 UI

Deviation: `PlayerController.selectAudio` adds the `audio-track` notice.

- `PlayerController`:
  - The snapshot gains `tracks` and `selectedAudio`, and there is a new `selectAudio(index)` method.
  - `reduceEvent` handles `tracks`; `playlistCleared` clears them.
- `AudioMenu` in `ControlBar`:
  - A button opens a popover list with rows such as "2. English · DTS-HD Master Audio 5.1".
  - Unplayable rows are disabled, with a tooltip explaining why.
  - The button is hidden when there is one track or none.
  - While the menu is open, the controls do not auto-hide.
- Keyboard: `A` selects the next playable track, wrapping around. A brief `audio-track` notice names the new track.
- Language names come from `Intl.DisplayNames`. A small table maps ISO 639-2 codes to the 2-letter codes that `Intl` expects (jpn→ja, eng→en, fra/fre→fr, deu/ger→de, …). If there is no match, the raw code is shown.

## 5. Errors

| Situation | Behavior |
|---|---|
| WASM fetch or compile fails | `unsupported` audio event naming the codec and the reason; `disableAudio` without a second notice; the wall clock takes over; other tracks stay selectable |
| One frame fails to decode | Counted in `audioDecodeErrors` and `corruptPackets`; skipped |
| More than 50 consecutive frame errors | `disableAudio` with an `audio-disabled` notice; the next seek or switch tries again |
| A TrueHD stream yields no `0x76` unit within 2 s of input | `unsupported`: "This TrueHD track has no Dolby Digital core, so it can't be played." |
| Decoded sample rate is not 48 kHz | `UnsupportedCodecError`, handled by the existing path |

## 6. Testing

### 6.1 Unit tests (Vitest, Node)

- `wasm-audio.test.ts` loads the real committed `audio.wasm`.
  - It decodes ffmpeg-made fixtures in `fixtures/synthetic/audio/`: a 440 Hz tone as AC-3 2.0, AC-3 5.1, E-AC-3 and DTS.
  - It asserts frame counts, timestamps, and that the tone's frequency (zero crossings) and level (RMS within a tolerance) survive the downmix.
  - It covers splitting cases: several frames in one PES, a frame split across PES packets, garbage before the sync word, `reset()` mid-frame, and a DTS-HD extension after a core frame.
- `truehd-core.test.ts`: interleaved `0x72` and `0x76` units go in and only the AC-3 frames come out; also the "no core within 2 s" path.
- `pes-assembler.test.ts`: `streamIdExtension` is parsed.
- `pipeline.test.ts`: the PID is resolved per item, and an item without the stream produces no audio.
- `player.test.ts` (existing fakes, with an injected decoder factory):
  - the initial track choice;
  - `selectAudio` re-seeks at the current time and keeps the paused or playing state;
  - invalid and repeated indices are ignored;
  - a load failure falls back to the wall clock;
  - decoders are reset on seek;
  - the consecutive-error limit.
- `player-controller.test.ts`: `reduceEvent` for `tracks` and `playlistCleared`. The language-name helper has its own tests.

### 6.2 Synthetic disc

- `scripts/make-audio-disc.ts` writes `fixtures/synthetic/disc3`: one playlist with four audio streams.
  1. LPCM.
  2. AC-3 5.1.
  3. TrueHD: ffmpeg's experimental `truehd` encoder makes the `0x72` units and we interleave AC-3 `0x76` frames.
  4. DTS.
- `tests/helpers/ts-muxer.ts` supports `stream_id 0xFD` with an extension.
- The script is added to `npm run fixture:synthetic`.

### 6.3 E2E (Chrome)

- `tests/e2e/audio.spec.ts` opens disc3 and selects each track through the menu. For each track it asserts:
  - `telemetry.audioCodec`;
  - `audioDecodeErrors === 0`;
  - A/V sync within the existing bounds, after the switch settles;
  - no new underruns.

  It also checks that `A` cycles tracks.
- `tests/e2e/local-discs.spec.ts` selects every playable audio track on each local disc and runs the same checks.

### 6.4 Build checks

- A new CI job, `wasm`, runs when `src/wasm/**` changes. It runs `build.sh` and fails if the hash differs from `audio.wasm.sha256`.
- The worker imports the binary with Vite's `?url`. The README deployment section notes that hosts must serve `.wasm` as `application/wasm`.

## 7. Exit criteria

1. CI is green, including the `wasm` job.
2. With the user's decrypted disc carrying Dolby and DTS tracks under `fixtures/local/`, `LOCAL_DISCS=1 npx playwright test local-discs` passes on every playable track. That covers AC-3 or E-AC-3, TrueHD through its core, and DTS or DTS-HD through its core. Each must keep sync within 20 ms mean and 50 ms max, with 0 decode errors.
3. Switching between the three LPCM tracks on `TSURUNE_TSUNAGARI_1` works in Chrome.
4. The parent spec's §1, §4, §11 and §12 are updated to put DTS core in M2. `docs/known-issues.md` records the core-only choice for TrueHD and DTS-HD, and the reason for it.
