# Milestone 2: Audio Coverage Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Play AC-3, E-AC-3, TrueHD (through its AC-3 core) and DTS / DTS-HD (through its DTS core) tracks, and let the user switch audio tracks.

**Architecture:** FFmpeg's `eac3` and `dca` decoders are compiled to one standalone `audio.wasm` with a small C shim, built reproducibly in Docker and committed. In the engine worker, a TypeScript `AudioFramer` splits PES payloads into codec frames with timestamps. A `WasmFrameDecoder` turns each frame into stereo float PCM. An `AudioDecoder` factory composes these (plus the existing LPCM decoder and a TrueHD core filter) behind one synchronous `decode(unit) → { chunks, failedFrames }` interface. The player picks audio by STN stream number, and the pipeline resolves the PID per play item. Switching tracks re-seeks to the current time. The UI gets a `tracks` event, a `selectAudio` command, an audio menu and the `A` key.

**Tech Stack:** TypeScript (strict), React 19, Vite 8, Vitest 5, Playwright 1.64 (Chrome), emscripten (Docker image `emscripten/emsdk`), FFmpeg `n9.0.2`, ffmpeg CLI 9.0.2 (host) for fixtures.

**Spec:** `docs/superpowers/specs/2026-10-13-m2-audio-coverage-design.md` (parent: `docs/superpowers/specs/2026-10-12-bluray-web-player-design.md`). Read both before starting.

## Global Constraints

- `src/engine/` and `src/wasm/` are LGPL-2.1-or-later. Engine code must not import React or anything from `src/ui/` or `src/player/`. Code derived from FFmpeg or libbluray gets an SPDX header and an entry in `src/engine/NOTICE`.
- Output is always 48 kHz stereo (`OUTPUT_SAMPLE_RATE = 48_000` in `player.ts`). Codecs that decode to any other rate raise `UnsupportedCodecError`.
- TrueHD plays only through its AC-3 core (PES `stream_id_extension` `0x76`; MLP is `0x72`). DTS, DTS-HD HR and DTS-HD MA decode with `core_only=1`.
- Playable audio coding types: `0x80, 0x81, 0x82, 0x83, 0x84, 0x85, 0x86`. Unplayable: `0xa1`, `0xa2` and anything else.
- Track switching is a re-seek to the current time with the new stream: `startAt(clock.nowUs(), wantPlaying)`.
- Consecutive frame-error limit: more than 50 → `disableAudio`. TrueHD with no `0x76` unit within 2 s of input → `UnsupportedCodecError` with the message "This TrueHD track has no Dolby Digital core, so it can't be played."
- `audio.wasm` is built only by `src/wasm/audio/build.sh` (Docker, `--platform linux/amd64`, image pinned by digest, FFmpeg pinned by tag). The build must be byte-for-byte reproducible. It is committed, and CI checks it.
- TypeScript is strict, with `noUnusedLocals`, `noUnusedParameters` and `verbatimModuleSyntax` (`import type` for types).
- Match the surrounding code: few comments, explaining why, not what; `readonly` interface fields; plain classes; no new dependencies.
- E2E A/V sync bounds stay at 20 ms mean / 50 ms max, scaled by `SYNC_TOLERANCE_SCALE`.

### Deviations from the spec (decided while planning)

- **Channel labels.** The STN `audio_format` field only distinguishes mono, stereo and multichannel, so `AudioTrack.channels` is `'mono' | 'stereo' | 'multichannel' | ''` rather than "5.1" or "7.1". Task 12 updates the spec text.
- **The "Audio: …" confirmation notice is added by `PlayerController.selectAudio`** on the main thread, which has `Intl` for language names. The engine `NoticeCode` stays as it is.
- **Frame splitting lives in its own file, `decode/audio-frames.ts`** (`AudioFramer`). `decode/wasm-audio.ts` only loads the WASM and decodes one frame. This keeps both small and testable.
- **A play item that lacks the selected stream** produces no audio units; the pipeline test covers that. How the audio clock behaves across such a gap is the same as for any M1 audio gap. Real discs carry every stream in every item, so Task 12 records it in `docs/known-issues.md` instead of building gap filling.
- **E-AC-3 grouping adds one frame of latency.** A group is emitted when the next independent frame arrives, so the last 32 ms of an E-AC-3 track before end of input is not played. Plain AC-3, TrueHD core and DTS frames are emitted immediately.

## Review Focus

1. **Quick track switches while a WASM load is in flight.** The last selection must win, with no stale decoder output and no hang. Task 8 has a test.
2. **Joining an AC-3 or DTS stream mid-frame after a seek.** The PES starts with the tail of a frame. The framer must resync on the next sync word without decoding garbage or counting errors. Task 2 has a test.
3. **A track whose decoder can't load** (the WASM failed to fetch). Video must keep playing on the wall clock, and selecting an LPCM track afterwards must bring sound back. Task 8 has a test.
4. **Seek during E-AC-3 playback.** `reset()` must drop a half-built group and its carry bytes, so the first output after the seek has the right PTS. Task 2 has a test.
5. **A frame with a broken header in the middle of a stream.** It must count one failed frame (or resync), with no `UnsupportedCodecError` and no audio shutdown. Task 4 has a test.

---

## File map

| File | Status | Responsibility |
|---|---|---|
| `src/engine/demux/pes-assembler.ts` | modify | expose `streamIdExtension` |
| `tests/helpers/ts-muxer.ts` | modify | write `stream_id 0xFD` + extension |
| `src/engine/decode/audio-frames.ts` | create | `AudioFramer`: AC-3/E-AC-3/DTS frame splitting + PTS |
| `src/wasm/audio/shim.c`, `build.sh`, `NOTICE`, `audio.wasm`, `audio.wasm.sha256` | create | the WASM decoder and its reproducible build |
| `.github/workflows/wasm.yml` | create | rebuild-and-compare check |
| `src/engine/decode/wasm-audio.ts` | create | `loadAudioWasm`, `WasmFrameDecoder` |
| `tests/helpers/audio-wasm.ts` | create | Node loader for tests |
| `scripts/make-audio-fixtures.ts`, `fixtures/synthetic/audio/*` | create | ffmpeg tone fixtures |
| `src/engine/decode/truehd-core.ts` | create | `TrueHdCoreFilter` |
| `src/engine/decode/audio-decoder.ts` | create | `AudioDecoder`, `createAudioDecoderFactory` |
| `src/engine/playback/stream-selection.ts` | modify | playable set, `audioIndex`, `audioEntryFor` |
| `src/engine/playback/pipeline.ts` | modify | per-item audio PID by stream number |
| `tests/helpers/synthetic-disc.ts` | modify | multiple audio streams per clip |
| `src/engine/player.ts`, `src/engine/worker.ts` | modify | decoder map, errors, telemetry, tracks, `selectAudio` |
| `src/engine/playback/tracks.ts` | create | `audioTracks(stn)` |
| `src/engine/protocol.ts` | modify | `AudioTrack`, `tracks`, `selectAudio`, telemetry fields |
| `src/player/player-controller.ts` | modify | snapshot tracks, `selectAudio`, `cycleAudio` |
| `src/ui/language.ts`, `src/ui/AudioMenu.tsx` | create | language names, track label, menu |
| `src/ui/ControlBar.tsx`, `PlayerScreen.tsx`, `keyboard.ts`, `styles.css` | modify | wire the menu and the `A` key |
| `scripts/x264.ts`, `scripts/make-audio-disc.ts`, `fixtures/synthetic/disc3` | create | E2E disc with 4 audio tracks |
| `tests/e2e/telemetry.ts`, `tests/e2e/audio.spec.ts` | create | shared sync helpers; audio E2E |
| `tests/e2e/local-discs.spec.ts`, `tests/local/real-discs.test.ts` | modify | real-disc audio checks |
| docs: parent spec, M2 spec, `known-issues.md`, `README.md`, `CLAUDE.md`, `src/engine/NOTICE` | modify | record the changes |

---

### Task 1: PES `stream_id_extension` (demux and test muxer)

**Files:**
- Modify: `src/engine/demux/pes-assembler.ts`
- Modify: `tests/helpers/ts-muxer.ts`
- Test: `src/engine/demux/pes-assembler.test.ts`

**Interfaces:**
- Produces: `PesPacket.streamIdExtension?: number` (7-bit value, present only for `stream_id 0xFD` packets that carry `PES_extension_flag_2` with `stream_id_extension_flag = 0`); `MuxUnit.streamIdExtension?: number` (when set, the muxer writes it; callers set `streamId: 0xfd`).

- [ ] **Step 1: Write the failing test.** Append to `src/engine/demux/pes-assembler.test.ts`, inside the existing `describe`. Look at the top of the file for its existing imports and helper that turns muxed bytes into `TsPacket`s, and reuse them. If the file has no helper that goes from `muxM2ts` output to `PesPacket`s, add this one at the top:

```ts
import { muxM2ts } from '../../../tests/helpers/ts-muxer';
import { parseSourcePacket } from './ts-packet';

function demuxAll(bytes: Uint8Array): PesPacket[] {
  const out: PesPacket[] = [];
  const assembler = new PesAssembler((p) => out.push(p));
  for (let o = 0; o + 192 <= bytes.length; o += 192) {
    const packet = parseSourcePacket(bytes, o);
    if (packet && packet.pid !== 0x1fff) assembler.push(packet);
  }
  assembler.flush();
  return out;
}
```

Then the test:

```ts
  it('reads stream_id_extension from 0xFD packets (TrueHD and its AC-3 core)', () => {
    const { bytes } = muxM2ts([
      { pid: 0x1100, streamId: 0xfd, streamIdExtension: 0x76, pts: 90_000, payload: new Uint8Array([0x0b, 0x77, 1, 2]) },
      { pid: 0x1100, streamId: 0xfd, streamIdExtension: 0x72, pts: 90_450, payload: new Uint8Array([0xf8, 0x72, 0x6f, 0xba]) },
      { pid: 0x1101, streamId: 0xbd, pts: 90_000, payload: new Uint8Array([9, 9]) },
    ]);
    const pes = demuxAll(bytes);
    expect(pes.map((p) => [p.pid, p.streamId, p.streamIdExtension, p.pts, [...p.payload]])).toEqual([
      [0x1100, 0xfd, 0x76, 90_000, [0x0b, 0x77, 1, 2]],
      [0x1100, 0xfd, 0x72, 90_450, [0xf8, 0x72, 0x6f, 0xba]],
      [0x1101, 0xbd, undefined, 90_000, [9, 9]],
    ]);
  });
```

`PesPacket` and `PesAssembler` are already imported by this test file. If `PesPacket` isn't, import it as a type.

- [ ] **Step 2: Run the test and check that it fails.**

Run: `npx vitest run src/engine/demux/pes-assembler.test.ts -t "stream_id_extension"`
Expected: FAIL. TypeScript accepts the unknown `streamIdExtension` property, but the assertion shows `undefined` instead of `0x76`.

- [ ] **Step 3: Implement it in the muxer.** In `tests/helpers/ts-muxer.ts`, add the field to `MuxUnit` and write it in `buildPes`:

```ts
export interface MuxUnit {
  pid: number;
  streamId: number;
  /** 90 kHz. */
  pts: number;
  dts?: number;
  payload: Uint8Array;
  /** Written as PES_extension_2 (Blu-ray TrueHD/AC-3 substreams use stream_id 0xFD with 0x72/0x76). */
  streamIdExtension?: number;
}

function buildPes(u: MuxUnit): Uint8Array {
  const hasDts = u.dts !== undefined && u.dts !== u.pts;
  const hasExt = u.streamIdExtension !== undefined;
  const tsBytes = hasDts ? 10 : 5;
  const headerDataLength = tsBytes + (hasExt ? 3 : 0);
  const length = 3 + headerDataLength + u.payload.length;
  const out = new Uint8Array(6 + length);
  out.set([0, 0, 1, u.streamId], 0);
  const declared = length > 0xffff ? 0 : length;
  out[4] = declared >> 8;
  out[5] = declared & 0xff;
  out[6] = 0x80;
  out[7] = (hasDts ? 0xc0 : 0x80) | (hasExt ? 0x01 : 0);
  out[8] = headerDataLength;
  writeTimestamp(out, 9, hasDts ? 0x3 : 0x2, u.pts);
  if (hasDts && u.dts !== undefined) writeTimestamp(out, 14, 0x1, u.dts);
  if (hasExt) {
    const e = 9 + tsBytes;
    out[e] = 0x01; // PES_extension_flag_2 only
    out[e + 1] = 0x81; // marker bit + PES_extension_field_length 1
    out[e + 2] = (u.streamIdExtension ?? 0) & 0x7f; // stream_id_extension_flag 0
  }
  out.set(u.payload, 9 + headerDataLength);
  return out;
}
```

- [ ] **Step 4: Implement the parsing.** In `src/engine/demux/pes-assembler.ts`, add the field and parse the extension:

```ts
export interface PesPacket {
  readonly pid: number;
  readonly streamId: number;
  /** 90 kHz. */
  readonly pts?: number;
  readonly dts?: number;
  /** stream_id_extension of a 0xFD packet (Blu-ray: 0x76 AC-3 core, 0x72 TrueHD/MLP). */
  readonly streamIdExtension?: number;
  readonly payload: Uint8Array;
}
```

Replace the tail of `parsePes` (from `const ptsDtsFlags` to the end) with:

```ts
  const flags = d[7];
  const ptsDtsFlags = flags >> 6;
  const headerEnd = 9 + d[8];
  if (headerEnd > end) return null;
  return {
    pid,
    streamId,
    pts: ptsDtsFlags & 0x2 ? readTimestamp(d, 9) : undefined,
    dts: ptsDtsFlags === 0x3 ? readTimestamp(d, 14) : undefined,
    streamIdExtension: streamId === 0xfd ? readStreamIdExtension(d, flags, headerEnd) : undefined,
    payload: d.subarray(headerEnd, end),
  };
}

/** Walks the optional PES header fields (ISO 13818-1 §2.4.3.7) to PES_extension_2. */
function readStreamIdExtension(d: Uint8Array, flags: number, headerEnd: number): number | undefined {
  if (!(flags & 0x01)) return undefined;
  let o = 9;
  if ((flags >> 6) === 0x2) o += 5;
  else if ((flags >> 6) === 0x3) o += 10;
  if (flags & 0x20) o += 6; // ESCR
  if (flags & 0x10) o += 3; // ES_rate
  if (flags & 0x08) o += 1; // DSM trick mode
  if (flags & 0x04) o += 1; // additional copy info
  if (flags & 0x02) o += 2; // previous PES CRC
  if (o >= headerEnd) return undefined;
  const ext = d[o++];
  if (ext & 0x80) o += 16; // PES_private_data
  if (ext & 0x40) o += 1 + (o < headerEnd ? d[o] : 0); // pack_header_field
  if (ext & 0x20) o += 2; // program_packet_sequence_counter
  if (ext & 0x10) o += 2; // P-STD_buffer
  if (!(ext & 0x01) || o + 1 >= headerEnd) return undefined;
  const field = d[o + 1];
  return field & 0x80 ? undefined : field & 0x7f;
}
```

- [ ] **Step 5: Run the demux tests and check that they pass.**

Run: `npx vitest run src/engine/demux`
Expected: PASS (all tests, including the new one).

- [ ] **Step 6: Commit.**

```bash
git add src/engine/demux/pes-assembler.ts src/engine/demux/pes-assembler.test.ts tests/helpers/ts-muxer.ts
git commit -m "feat(demux): expose PES stream_id_extension for TrueHD substreams"
```

---

### Task 2: `AudioFramer`: AC-3, E-AC-3 and DTS frame splitting

**Files:**
- Create: `src/engine/decode/audio-frames.ts`
- Test: `src/engine/decode/audio-frames.test.ts`

**Interfaces:**
- Consumes: `UnsupportedCodecError` from `./decoder`; `codingName` from `../bdmv/stream-types`.
- Produces:
  ```ts
  export type FramerKind = 'ac3' | 'eac3' | 'dts';
  export interface AudioFrame { readonly data: Uint8Array; readonly ptsUs: number; readonly samples: number }
  export class AudioFramer {
    constructor(kind: FramerKind, codingType: number);
    push(data: Uint8Array, ptsUs: number): AudioFrame[];
    reset(): void;
  }
  ```
  `samples` is in 48 kHz frames. For `eac3` each `AudioFrame` is an access unit: an independent frame plus the dependent frames after it, concatenated.

Rules (from the spec, §2.2):
- The PTS passed to `push` belongs to the first frame (for `eac3`, the first group-starting frame) that starts inside the data passed to that `push`. Every other frame gets the previous frame's PTS plus its duration (`samples × 1e6 / 48000`).
- AC-3 (`bsid ≤ 10`): sync `0x0B77`; `fscod` must be 0 (48 kHz), otherwise the position is treated as no sync (resync); frame bytes = `AC3_WORDS_48K[frmsizecod] × 2`; 1536 samples.
- E-AC-3 (`bsid 11–16`): frame bytes = `(frmsiz + 1) × 2`; samples = `[1, 2, 3, 6][numblkscod] × 256`. `fscod != 0` throws `UnsupportedCodecError`. A group starts at an AC-3 frame or at an E-AC-3 frame with `strmtyp != 1` and `substreamid == 0`. Any other frame joins the current group, or is dropped if no group is open. In `ac3` mode every frame is emitted on its own. In `eac3` mode a group is emitted when the next group starts.
- DTS core: sync `0x7FFE8001`; `NBLKS` 7 bits and `FSIZE` 14 bits at the positions shown in the code; frame bytes = `FSIZE + 1`; samples = `(NBLKS + 1) × 32`. A DTS-HD extension substream (sync `0x64582025`) is parsed for its size and dropped.
- Bytes that aren't a sync word are skipped one at a time. An incomplete frame at the end of a push is kept for the next push. `reset()` drops the kept bytes, the open group and the running PTS.

- [ ] **Step 1: Write the failing tests.** Create `src/engine/decode/audio-frames.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { CodingType } from '../bdmv/stream-types';
import { AudioFramer } from './audio-frames';
import { UnsupportedCodecError } from './decoder';

const FRAME_US = (1536 * 1e6) / 48_000; // 32 000

/** AC-3 frame, 48 kHz; frmsizecod 8 → 128 words = 256 bytes. */
function ac3Frame(fill: number, frmsizecod = 8, fscod = 0): Uint8Array {
  const words = [64, 64, 80, 80, 96, 96, 112, 112, 128, 128][frmsizecod] ?? 128;
  const f = new Uint8Array(words * 2).fill(fill);
  f.set([0x0b, 0x77, 0, 0, (fscod << 6) | frmsizecod, 8 << 3]);
  return f;
}

/** E-AC-3 frame: strmtyp 0 independent / 1 dependent, 6 blocks, 48 kHz. */
function eac3Frame(strmtyp: number, bytes: number, fill: number, substreamid = 0, fscod = 0): Uint8Array {
  const frmsiz = bytes / 2 - 1;
  const f = new Uint8Array(bytes).fill(fill);
  f.set([0x0b, 0x77, (strmtyp << 6) | (substreamid << 3) | (frmsiz >> 8), frmsiz & 0xff, (fscod << 6) | (3 << 4), 16 << 3]);
  return f;
}

/** DTS core frame with NBLKS = 15 (512 samples). */
function dtsFrame(bytes: number, fill: number): Uint8Array {
  const f = new Uint8Array(bytes).fill(fill);
  const nblks = 15;
  const fsize = bytes - 1;
  f.set([0x7f, 0xfe, 0x80, 0x01, 0xfc | (nblks >> 6), ((nblks & 0x3f) << 2) | (fsize >> 12), (fsize >> 4) & 0xff, ((fsize & 0x0f) << 4) | 0x0f, 0x34]);
  return f;
}

/** DTS-HD extension substream, header size type 0: 8-bit header size, 16-bit fsize at bit 43. */
function exss(bytes: number): Uint8Array {
  const f = new Uint8Array(bytes);
  f.set([0x64, 0x58, 0x20, 0x25, 0x00]);
  const fsize = bytes - 1;
  // bits after byte 4: index(2)=0, type(1)=0, headerSize(8)=16, fsize(16)
  const bits = (0n << 25n) | (0n << 24n) | (16n << 16n) | BigInt(fsize);
  f[5] = Number((bits >> 19n) & 0xffn);
  f[6] = Number((bits >> 11n) & 0xffn);
  f[7] = Number((bits >> 3n) & 0xffn);
  f[8] = Number((bits & 0x7n) << 5n);
  return f;
}

const cat = (...parts: Uint8Array[]): Uint8Array => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
};

describe('AudioFramer', () => {
  it('splits several AC-3 frames in one PES and times them from the PES PTS', () => {
    const framer = new AudioFramer('ac3', CodingType.AC3);
    const frames = framer.push(cat(ac3Frame(1), ac3Frame(2), ac3Frame(3)), 1_000_000);
    expect(frames.map((f) => [f.data.length, f.data[10], f.ptsUs, f.samples])).toEqual([
      [256, 1, 1_000_000, 1536],
      [256, 2, 1_000_000 + FRAME_US, 1536],
      [256, 3, 1_000_000 + 2 * FRAME_US, 1536],
    ]);
  });

  it('carries a frame split across PES packets; the next PTS goes to the first frame starting in that PES', () => {
    const framer = new AudioFramer('ac3', CodingType.AC3);
    const a = ac3Frame(1);
    const b = ac3Frame(2);
    const c = ac3Frame(3);
    expect(framer.push(cat(a, b.subarray(0, 100)), 0).map((f) => f.ptsUs)).toEqual([0]);
    // b started in the previous PES (running PTS); c is the first frame starting here (PES PTS).
    const second = framer.push(cat(b.subarray(100), c), 64_500);
    expect(second.map((f) => [f.data[10], f.ptsUs])).toEqual([
      [2, FRAME_US],
      [3, 64_500],
    ]);
  });

  it('skips garbage and resyncs when joining mid-frame after a seek', () => {
    const framer = new AudioFramer('ac3', CodingType.AC3);
    const tail = ac3Frame(7).subarray(40); // the end of a frame we never saw the start of
    const frames = framer.push(cat(tail, ac3Frame(1)), 5_000_000);
    expect(frames.map((f) => [f.data[10], f.ptsUs])).toEqual([[1, 5_000_000]]);
  });

  it('treats a non-48 kHz AC-3 header as no sync', () => {
    const framer = new AudioFramer('ac3', CodingType.AC3);
    expect(framer.push(cat(ac3Frame(9, 8, 1), ac3Frame(1)), 0).map((f) => f.data[10])).toEqual([1]);
  });

  it('groups an E-AC-3 independent frame with its dependent frames and emits the group when the next one starts', () => {
    const framer = new AudioFramer('eac3', CodingType.EAC3);
    expect(framer.push(cat(eac3Frame(0, 200, 1), eac3Frame(1, 100, 2)), 0)).toEqual([]);
    const out = framer.push(eac3Frame(0, 200, 3), 32_000);
    expect(out).toHaveLength(1);
    expect(out[0].data.length).toBe(300);
    expect([out[0].data[10], out[0].data[210], out[0].ptsUs, out[0].samples]).toEqual([1, 2, 0, 1536]);
  });

  it('drops a dependent E-AC-3 frame with no independent frame before it', () => {
    const framer = new AudioFramer('eac3', CodingType.EAC3);
    framer.push(cat(eac3Frame(1, 100, 2), eac3Frame(0, 200, 1)), 0);
    const out = framer.push(eac3Frame(0, 200, 3), 32_000);
    expect(out.map((f) => [f.data.length, f.data[10]])).toEqual([[200, 1]]);
  });

  it('throws UnsupportedCodecError for reduced-rate E-AC-3', () => {
    const framer = new AudioFramer('eac3', CodingType.EAC3);
    expect(() => framer.push(eac3Frame(0, 200, 1, 0, 1), 0)).toThrow(UnsupportedCodecError);
  });

  it('reset() drops a half-built group and kept bytes, so the next PTS is the new PES PTS', () => {
    const framer = new AudioFramer('eac3', CodingType.EAC3);
    framer.push(cat(eac3Frame(0, 200, 1), eac3Frame(0, 200, 2).subarray(0, 50)), 0);
    framer.reset();
    framer.push(eac3Frame(0, 200, 5), 9_000_000);
    const out = framer.push(eac3Frame(0, 200, 6), 9_032_000);
    expect(out.map((f) => [f.data[10], f.ptsUs])).toEqual([[5, 9_000_000]]);
  });

  it('splits DTS core frames (512 samples) and drops DTS-HD extension substreams', () => {
    const framer = new AudioFramer('dts', CodingType.DTSHD_MASTER);
    const frames = framer.push(cat(dtsFrame(1006, 1), exss(300), dtsFrame(1006, 2), exss(300)), 2_000_000);
    expect(frames.map((f) => [f.data.length, f.data[20], f.ptsUs, f.samples])).toEqual([
      [1006, 1, 2_000_000, 512],
      [1006, 2, 2_000_000 + (512 * 1e6) / 48_000, 512],
    ]);
  });
});
```

- [ ] **Step 2: Run the tests and check that they fail.**

Run: `npx vitest run src/engine/decode/audio-frames.test.ts`
Expected: FAIL with "Failed to resolve import './audio-frames'".

- [ ] **Step 3: Implement it.** Create `src/engine/decode/audio-frames.ts`:

```ts
import { codingName } from '../bdmv/stream-types';
import { UnsupportedCodecError } from './decoder';

export type FramerKind = 'ac3' | 'eac3' | 'dts';

export interface AudioFrame {
  readonly data: Uint8Array;
  readonly ptsUs: number;
  /** Duration in 48 kHz sample frames. */
  readonly samples: number;
}

interface Parsed {
  readonly size: number;
  readonly samples: number;
  /** Starts an access unit (E-AC-3: independent substream 0); other frames join the open one. */
  readonly startsUnit: boolean;
  readonly drop?: boolean;
}

const SAMPLE_RATE = 48_000;
/** AC-3 frame size in 16-bit words per frmsizecod at 48 kHz (ATSC A/52 Table 5.18). */
const AC3_WORDS_48K = [
  64, 64, 80, 80, 96, 96, 112, 112, 128, 128, 160, 160, 192, 192, 224, 224, 256, 256, 320, 320, 384, 384, 448, 448, 512, 512, 640, 640, 768, 768, 896,
  896, 1024, 1024, 1152, 1152, 1280, 1280,
];
const EAC3_BLOCKS = [1, 2, 3, 6];
const DTS_SYNC = 0x7ffe8001;
const EXSS_SYNC = 0x64582025;

function readBits(b: Uint8Array, bitPos: number, count: number): number {
  let v = 0;
  for (let i = 0; i < count; i++) {
    const p = bitPos + i;
    v = v * 2 + ((b[p >> 3] >> (7 - (p & 7))) & 1);
  }
  return v;
}

/** Splits a codec's PES payloads into frames (or E-AC-3 access units) and gives each a PTS. */
export class AudioFramer {
  private carry: Uint8Array = new Uint8Array(0);
  private nextPtsUs: number | null = null;
  private group: { parts: Uint8Array[]; ptsUs: number; samples: number } | null = null;

  constructor(
    private readonly kind: FramerKind,
    private readonly codingType: number,
  ) {}

  push(data: Uint8Array, ptsUs: number): AudioFrame[] {
    const buf = this.carry.length === 0 ? data : concat(this.carry, data);
    const newFrom = this.carry.length;
    const out: AudioFrame[] = [];
    let ptsPending = true;
    let at = 0;
    while (at < buf.length) {
      const parsed = this.kind === 'dts' ? this.parseDts(buf, at) : this.parseAc3(buf, at);
      if (parsed === 'resync') {
        at++;
        continue;
      }
      if (parsed === null || at + parsed.size > buf.length) break;
      const start = at;
      const bytes = buf.slice(at, at + parsed.size);
      at += parsed.size;
      if (parsed.drop) continue;
      if (!parsed.startsUnit) {
        this.group?.parts.push(bytes);
        continue;
      }
      let frameUs = this.nextPtsUs ?? ptsUs;
      if (ptsPending && start >= newFrom) {
        frameUs = ptsUs;
        ptsPending = false;
      }
      this.nextPtsUs = frameUs + (parsed.samples * 1e6) / SAMPLE_RATE;
      if (this.kind === 'eac3') {
        if (this.group) out.push(finish(this.group));
        this.group = { parts: [bytes], ptsUs: frameUs, samples: parsed.samples };
      } else {
        out.push({ data: bytes, ptsUs: frameUs, samples: parsed.samples });
      }
    }
    this.carry = buf.slice(at);
    return out;
  }

  reset(): void {
    this.carry = new Uint8Array(0);
    this.nextPtsUs = null;
    this.group = null;
  }

  private parseAc3(b: Uint8Array, at: number): Parsed | 'resync' | null {
    if (b.length - at < 2) return null;
    if (b[at] !== 0x0b || b[at + 1] !== 0x77) return 'resync';
    if (b.length - at < 6) return null;
    const bsid = b[at + 5] >> 3;
    const fscod = b[at + 4] >> 6;
    if (bsid <= 10) {
      const frmsizecod = b[at + 4] & 0x3f;
      if (fscod !== 0 || frmsizecod >= AC3_WORDS_48K.length) return 'resync'; // Blu-ray AC-3 is always 48 kHz
      return { size: AC3_WORDS_48K[frmsizecod] * 2, samples: 1536, startsUnit: true };
    }
    if (bsid > 16) return 'resync';
    const strmtyp = b[at + 2] >> 6;
    if (strmtyp === 3) return 'resync';
    if (fscod !== 0) {
      throw new UnsupportedCodecError(this.codingType, `${codingName(this.codingType)} below 48 kHz is not supported.`);
    }
    const substreamId = (b[at + 2] >> 3) & 0x07;
    const frmsiz = ((b[at + 2] & 0x07) << 8) | b[at + 3];
    const blocks = EAC3_BLOCKS[(b[at + 4] >> 4) & 0x03];
    const startsUnit = this.kind !== 'eac3' || (strmtyp !== 1 && substreamId === 0);
    return { size: (frmsiz + 1) * 2, samples: blocks * 256, startsUnit };
  }

  private parseDts(b: Uint8Array, at: number): Parsed | 'resync' | null {
    if (b.length - at < 4) return null;
    const sync = ((b[at] << 24) | (b[at + 1] << 16) | (b[at + 2] << 8) | b[at + 3]) >>> 0;
    if (sync === DTS_SYNC) {
      if (b.length - at < 8) return null;
      const nblks = ((b[at + 4] & 0x01) << 6) | (b[at + 5] >> 2);
      const fsize = (((b[at + 5] & 0x03) << 12) | (b[at + 6] << 4) | (b[at + 7] >> 4)) + 1;
      if (fsize < 96) return 'resync';
      return { size: fsize, samples: (nblks + 1) * 32, startsUnit: true };
    }
    if (sync === EXSS_SYNC) {
      if (b.length - at < 12) return null;
      const base = at * 8 + 32 + 8 + 2; // after sync, UserDefinedBits(8), nExtSSIndex(2)
      const wide = readBits(b, base, 1) === 1;
      const fsize = readBits(b, base + 1 + (wide ? 12 : 8), wide ? 20 : 16) + 1;
      return { size: fsize, samples: 0, startsUnit: false, drop: true };
    }
    return 'resync';
  }
}

function concat(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

function finish(group: { parts: Uint8Array[]; ptsUs: number; samples: number }): AudioFrame {
  return { data: group.parts.length === 1 ? group.parts[0] : concat(...group.parts), ptsUs: group.ptsUs, samples: group.samples };
}
```

The test's `exss()` helper writes header size type 0: after the sync word come `UserDefinedBits` (8), `nExtSSIndex` (2), `bHeaderSizeType` (1), `nuExtSSHeaderSize` (8) and `nuExtSSFsize` (16). `parseDts` reads the same layout.

- [ ] **Step 4: Run the tests and check that they pass.**

Run: `npx vitest run src/engine/decode/audio-frames.test.ts`
Expected: PASS (9 tests).

- [ ] **Step 5: Typecheck and commit.**

```bash
npm run typecheck
git add src/engine/decode/audio-frames.ts src/engine/decode/audio-frames.test.ts
git commit -m "feat(audio): split AC-3, E-AC-3 and DTS payloads into timed frames"
```

---

### Task 3: Reproducible `audio.wasm` build and loader

**Files:**
- Create: `src/wasm/audio/shim.c`, `src/wasm/audio/build.sh`, `src/wasm/audio/NOTICE`
- Create (build output, committed): `src/wasm/audio/audio.wasm`, `src/wasm/audio/audio.wasm.sha256`
- Create: `src/engine/decode/wasm-audio.ts`, `tests/helpers/audio-wasm.ts`
- Create: `.github/workflows/wasm.yml`
- Modify: `package.json` (script `wasm:build`), `src/engine/NOTICE`
- Test: `src/engine/decode/wasm-audio.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export interface AudioWasm {
    readonly memory: WebAssembly.Memory;
    audio_open(codec: number): number;
    audio_decode(handle: number, input: number, length: number, output: number, maxFrames: number): number;
    audio_sample_rate(handle: number): number;
    audio_reset(handle: number): void;
    audio_close(handle: number): void;
    malloc(size: number): number;
    free(ptr: number): void;
  }
  export const WasmCodec: { readonly AC3: 0; readonly DTS: 1 };
  export type WasmCodecId = (typeof WasmCodec)[keyof typeof WasmCodec];
  export class AudioFrameError extends Error { readonly code: number }
  export async function loadAudioWasm(source: BufferSource | Promise<Response>): Promise<AudioWasm>;
  export class WasmFrameDecoder {
    constructor(wasm: AudioWasm, codec: WasmCodecId);
    decode(frame: Uint8Array): { readonly sampleRate: number; readonly stereo: Float32Array }; // throws AudioFrameError
    reset(): void;
    close(): void;
  }
  // tests/helpers/audio-wasm.ts
  export function loadNodeAudioWasm(): Promise<AudioWasm>;
  ```

- [ ] **Step 1: Write the C shim.** Create `src/wasm/audio/shim.c`:

```c
/*
 * bluray-web audio decoder shim over FFmpeg libavcodec (eac3, dca).
 * Copyright (c) 2026 bluray-web contributors
 *
 * SPDX-License-Identifier: LGPL-2.1-or-later
 */

#include <stdint.h>
#include <stdlib.h>
#include <string.h>
#include <emscripten/emscripten.h>
#include "libavcodec/avcodec.h"
#include "libavutil/channel_layout.h"
#include "libavutil/dict.h"
#include "libavutil/log.h"

typedef struct Decoder {
  AVCodecContext *ctx;
  AVPacket *pkt;
  AVFrame *frame;
} Decoder;

EMSCRIPTEN_KEEPALIVE void audio_close(Decoder *d) {
  if (!d) return;
  avcodec_free_context(&d->ctx);
  av_packet_free(&d->pkt);
  av_frame_free(&d->frame);
  free(d);
}

/* codec 0: AC-3 and E-AC-3 (FFmpeg's eac3 decoder handles both by bsid); codec 1: DTS core. */
EMSCRIPTEN_KEEPALIVE Decoder *audio_open(int codec) {
  av_log_set_level(AV_LOG_QUIET);
  const AVCodec *c = avcodec_find_decoder(codec == 1 ? AV_CODEC_ID_DTS : AV_CODEC_ID_EAC3);
  if (!c) return NULL;
  Decoder *d = calloc(1, sizeof(*d));
  if (!d) return NULL;
  d->ctx = avcodec_alloc_context3(c);
  d->pkt = av_packet_alloc();
  d->frame = av_frame_alloc();
  AVDictionary *opts = NULL;
  av_dict_set(&opts, "downmix", "stereo", 0);
  if (codec == 1) av_dict_set(&opts, "core_only", "1", 0);
  int ok = d->ctx && d->pkt && d->frame && avcodec_open2(d->ctx, c, &opts) >= 0;
  av_dict_free(&opts);
  if (!ok) {
    audio_close(d);
    return NULL;
  }
  return d;
}

static float sample_at(const AVFrame *f, int ch, int i) {
  switch (f->format) {
    case AV_SAMPLE_FMT_FLTP: return ((const float *)f->extended_data[ch])[i];
    case AV_SAMPLE_FMT_FLT: return ((const float *)f->extended_data[0])[i * f->ch_layout.nb_channels + ch];
    case AV_SAMPLE_FMT_S16P: return ((const int16_t *)f->extended_data[ch])[i] / 32768.0f;
    case AV_SAMPLE_FMT_S32P: return ((const int32_t *)f->extended_data[ch])[i] / 2147483648.0f;
    default: return 0.0f;
  }
}

/* Interleaved stereo. More than two channels means the decoder ignored "downmix": fold them down here. */
static int write_frame(const AVFrame *f, float *out, int max_frames) {
  int n = f->nb_samples;
  int channels = f->ch_layout.nb_channels;
  if (n > max_frames) return -2;
  if (channels == 1) {
    for (int i = 0; i < n; i++) out[2 * i] = out[2 * i + 1] = sample_at(f, 0, i);
    return n;
  }
  if (channels == 2) {
    for (int i = 0; i < n; i++) {
      out[2 * i] = sample_at(f, 0, i);
      out[2 * i + 1] = sample_at(f, 1, i);
    }
    return n;
  }
  const AVChannelLayout *l = &f->ch_layout;
  int fl = av_channel_layout_index_from_channel(l, AV_CHAN_FRONT_LEFT);
  int fr = av_channel_layout_index_from_channel(l, AV_CHAN_FRONT_RIGHT);
  int fc = av_channel_layout_index_from_channel(l, AV_CHAN_FRONT_CENTER);
  int sl = av_channel_layout_index_from_channel(l, AV_CHAN_SIDE_LEFT);
  int sr = av_channel_layout_index_from_channel(l, AV_CHAN_SIDE_RIGHT);
  int bl = av_channel_layout_index_from_channel(l, AV_CHAN_BACK_LEFT);
  int br = av_channel_layout_index_from_channel(l, AV_CHAN_BACK_RIGHT);
  if (fl < 0 || fr < 0) { fl = 0; fr = 1; }
  const float k = 0.70710678f;
  float norm = 1.0f / (1.0f + (fc >= 0 ? k : 0) + (sl >= 0 ? k : 0) + (bl >= 0 ? k : 0));
  for (int i = 0; i < n; i++) {
    float c = fc >= 0 ? k * sample_at(f, fc, i) : 0;
    float left = sample_at(f, fl, i) + c + (sl >= 0 ? k * sample_at(f, sl, i) : 0) + (bl >= 0 ? k * sample_at(f, bl, i) : 0);
    float right = sample_at(f, fr, i) + c + (sr >= 0 ? k * sample_at(f, sr, i) : 0) + (br >= 0 ? k * sample_at(f, br, i) : 0);
    out[2 * i] = left * norm;
    out[2 * i + 1] = right * norm;
  }
  return n;
}

/* Decodes one access unit; returns stereo frames written to out, or a negative error. */
EMSCRIPTEN_KEEPALIVE int audio_decode(Decoder *d, const uint8_t *in, int len, float *out, int max_frames) {
  av_packet_unref(d->pkt);
  if (av_new_packet(d->pkt, len) < 0) return -12;
  memcpy(d->pkt->data, in, len);
  if (avcodec_send_packet(d->ctx, d->pkt) < 0) return -1;
  int total = 0;
  for (;;) {
    int r = avcodec_receive_frame(d->ctx, d->frame);
    if (r == AVERROR(EAGAIN) || r == AVERROR_EOF) break;
    if (r < 0) return -1;
    int n = write_frame(d->frame, out + total * 2, max_frames - total);
    av_frame_unref(d->frame);
    if (n < 0) return n;
    total += n;
  }
  return total;
}

EMSCRIPTEN_KEEPALIVE int audio_sample_rate(Decoder *d) { return d->ctx->sample_rate; }

EMSCRIPTEN_KEEPALIVE void audio_reset(Decoder *d) { avcodec_flush_buffers(d->ctx); }
```

- [ ] **Step 2: Pin the emscripten image.** Run:

```bash
docker pull --platform linux/amd64 emscripten/emsdk:latest
docker inspect --format '{{index .RepoDigests 0}}' emscripten/emsdk:latest
docker run --rm --platform linux/amd64 emscripten/emsdk:latest emcc --version | head -1
```

Write down the digest (`emscripten/emsdk@sha256:…`) and the emcc version. They go into `build.sh` in the next step.

- [ ] **Step 3: Write the build script.** Create `src/wasm/audio/build.sh` and make it executable (`chmod +x`). Replace `<DIGEST>` and `<EMCC_VERSION>` with the values from Step 2:

```bash
#!/usr/bin/env bash
# Builds audio.wasm (FFmpeg's eac3 + dca decoders and shim.c) in Docker, reproducibly.
# Pinned: emscripten/emsdk <EMCC_VERSION> by digest, FFmpeg by tag. linux/amd64 everywhere, so CI and
# Apple-silicon hosts produce the same bytes.
set -euo pipefail

FFMPEG_TAG=n9.0.2
EMSDK_IMAGE=emscripten/emsdk@sha256:<DIGEST>
HERE="$(cd "$(dirname "$0")" && pwd)"

if [[ "${1:-}" != "--inside" ]]; then
  exec docker run --rm --platform linux/amd64 -e SOURCE_DATE_EPOCH=0 -v "$HERE:/out" "$EMSDK_IMAGE" bash /out/build.sh --inside
fi

git clone --quiet --depth 1 --branch "$FFMPEG_TAG" https://git.ffmpeg.org/ffmpeg.git /build/ffmpeg
cd /build/ffmpeg
emconfigure ./configure \
  --cc=emcc --cxx=em++ --ar=emar --ranlib=emranlib --nm=emnm \
  --target-os=none --arch=x86_32 --enable-cross-compile \
  --disable-asm --disable-inline-asm --disable-x86asm --disable-runtime-cpudetect \
  --disable-autodetect --disable-everything --disable-programs --disable-doc --disable-debug --disable-stripping \
  --disable-avdevice --disable-avformat --disable-avfilter --disable-swresample --disable-swscale --disable-network \
  --disable-pthreads --disable-w32threads --disable-os2threads \
  --enable-decoder=ac3,eac3,dca \
  --extra-cflags=-Oz
emmake make -j"$(nproc)" libavcodec/libavcodec.a libavutil/libavutil.a
emcc -Oz -I/build/ffmpeg /out/shim.c libavcodec/libavcodec.a libavutil/libavutil.a \
  -sSTANDALONE_WASM --no-entry -sALLOW_MEMORY_GROWTH=1 -sFILESYSTEM=0 -sSTACK_SIZE=1MB \
  -sEXPORTED_FUNCTIONS=_audio_open,_audio_decode,_audio_sample_rate,_audio_reset,_audio_close,_malloc,_free \
  -o /build/audio.wasm
cp /build/audio.wasm /out/audio.wasm
cd /out && sha256sum audio.wasm > audio.wasm.sha256
```

Add to the `scripts` block of `package.json`: `"wasm:build": "src/wasm/audio/build.sh"`.

- [ ] **Step 4: Build it twice and check that the output is reproducible.**

```bash
npm run wasm:build
cp src/wasm/audio/audio.wasm.sha256 /tmp/first.sha256   # use the session scratchpad instead of /tmp
npm run wasm:build
diff /tmp/first.sha256 src/wasm/audio/audio.wasm.sha256 && ls -l src/wasm/audio/audio.wasm
```

Expected: no diff, and a file size under 1 MB. If configure or the link fails, fix the flags in `build.sh` and keep the pins. If two builds differ, look for embedded paths or timestamps (`strings audio.wasm | grep /build`) and fix that before going on.

- [ ] **Step 5: Write the failing loader test.** Create `tests/helpers/audio-wasm.ts`:

```ts
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { loadAudioWasm, type AudioWasm } from '../../src/engine/decode/wasm-audio';

const WASM = fileURLToPath(new URL('../../src/wasm/audio/audio.wasm', import.meta.url));

export function loadNodeAudioWasm(): Promise<AudioWasm> {
  return loadAudioWasm(readFileSync(WASM));
}
```

Create `src/engine/decode/wasm-audio.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { loadNodeAudioWasm } from '../../../tests/helpers/audio-wasm';
import { AudioFrameError, WasmCodec, WasmFrameDecoder } from './wasm-audio';

describe('audio.wasm', () => {
  it('loads and opens and closes both decoders', async () => {
    const wasm = await loadNodeAudioWasm();
    for (const codec of [WasmCodec.AC3, WasmCodec.DTS]) {
      const d = new WasmFrameDecoder(wasm, codec);
      d.reset();
      d.close();
    }
  });

  it('reports a frame that is not audio as an AudioFrameError', async () => {
    const d = new WasmFrameDecoder(await loadNodeAudioWasm(), WasmCodec.AC3);
    expect(() => d.decode(new Uint8Array(256).fill(0x55))).toThrow(AudioFrameError);
    d.close();
  });
});
```

Run: `npx vitest run src/engine/decode/wasm-audio.test.ts`
Expected: FAIL with "Failed to resolve import ... wasm-audio".

- [ ] **Step 6: Implement the loader.** Create `src/engine/decode/wasm-audio.ts`:

```ts
export interface AudioWasm {
  readonly memory: WebAssembly.Memory;
  audio_open(codec: number): number;
  audio_decode(handle: number, input: number, length: number, output: number, maxFrames: number): number;
  audio_sample_rate(handle: number): number;
  audio_reset(handle: number): void;
  audio_close(handle: number): void;
  malloc(size: number): number;
  free(ptr: number): void;
}

export const WasmCodec = { AC3: 0, DTS: 1 } as const;
export type WasmCodecId = (typeof WasmCodec)[keyof typeof WasmCodec];

/** One frame the decoder rejected (corrupt or not this codec). */
export class AudioFrameError extends Error {
  constructor(readonly code: number) {
    super(`audio frame could not be decoded (${code})`);
    this.name = 'AudioFrameError';
  }
}

/** Largest output of one access unit: a DTS frame of 128 blocks × 32 samples, with headroom. */
const MAX_FRAMES = 8192;
const ENOSYS = 52;

/**
 * Instantiates the standalone (WASI-flavoured) module without emscripten's JS glue. The shim never does I/O,
 * so WASI calls fail with ENOSYS and exits throw.
 */
export async function loadAudioWasm(source: BufferSource | Promise<Response>): Promise<AudioWasm> {
  const module = source instanceof Promise ? await WebAssembly.compileStreaming(source) : await WebAssembly.compile(source);
  const imports: Record<string, Record<string, WebAssembly.ImportValue>> = {};
  for (const imp of WebAssembly.Module.imports(module)) {
    if (imp.kind !== 'function') throw new Error(`audio.wasm needs an unexpected ${imp.kind} import ${imp.module}.${imp.name}`);
    const exits = imp.name === 'proc_exit' || imp.name === 'abort';
    const value = imp.module === 'wasi_snapshot_preview1' ? ENOSYS : 0;
    (imports[imp.module] ??= {})[imp.name] = exits
      ? (code: number): never => {
          throw new Error(`audio decoder aborted (${code})`);
        }
      : (): number => value;
  }
  const instance = await WebAssembly.instantiate(module, imports);
  const exports = instance.exports as unknown as AudioWasm & { _initialize?: () => void };
  exports._initialize?.();
  return exports;
}

/** One FFmpeg decoder instance inside the shared module; decodes whole frames to interleaved stereo. */
export class WasmFrameDecoder {
  private readonly handle: number;
  private readonly outPtr: number;
  private inPtr = 0;
  private inCap = 0;

  constructor(
    private readonly wasm: AudioWasm,
    codec: WasmCodecId,
  ) {
    this.handle = wasm.audio_open(codec);
    if (this.handle === 0) throw new Error(`audio decoder ${codec} could not be opened`);
    this.outPtr = wasm.malloc(MAX_FRAMES * 2 * 4);
    if (this.outPtr === 0) throw new Error('audio decoder is out of memory');
  }

  decode(frame: Uint8Array): { readonly sampleRate: number; readonly stereo: Float32Array } {
    if (frame.length > this.inCap) {
      if (this.inPtr !== 0) this.wasm.free(this.inPtr);
      this.inCap = Math.max(frame.length, 8192);
      this.inPtr = this.wasm.malloc(this.inCap);
      if (this.inPtr === 0) throw new Error('audio decoder is out of memory');
    }
    // Views are taken after every call that may grow memory (growth detaches the old buffer).
    new Uint8Array(this.wasm.memory.buffer, this.inPtr, frame.length).set(frame);
    const frames = this.wasm.audio_decode(this.handle, this.inPtr, frame.length, this.outPtr, MAX_FRAMES);
    if (frames < 0) throw new AudioFrameError(frames);
    const stereo = new Float32Array(this.wasm.memory.buffer, this.outPtr, frames * 2).slice();
    return { sampleRate: this.wasm.audio_sample_rate(this.handle), stereo };
  }

  reset(): void {
    this.wasm.audio_reset(this.handle);
  }

  close(): void {
    this.wasm.audio_close(this.handle);
    this.wasm.free(this.outPtr);
    if (this.inPtr !== 0) this.wasm.free(this.inPtr);
  }
}
```

- [ ] **Step 7: Run the test and check that it passes.**

Run: `npx vitest run src/engine/decode/wasm-audio.test.ts`
Expected: PASS (2 tests). If loading fails on an import kind other than `function`, the module needs memory or a table from outside. Check that `-sSTANDALONE_WASM` is in effect, because standalone modules export their memory.

- [ ] **Step 8: Add the notices and the CI check.** Create `src/wasm/audio/NOTICE`:

```
audio.wasm: FFmpeg libavcodec decoders (ac3, eac3, dca) with shim.c, for bluray-web.
LGPL-2.1-or-later.

FFmpeg (https://ffmpeg.org), LGPL-2.1-or-later. Copyright (c) the FFmpeg developers.
  Source: https://git.ffmpeg.org/ffmpeg.git, tag n9.0.2 (unmodified).
  Configure line and link flags: build.sh in this folder.
  Rebuild: npm run wasm:build (Docker). The output is reproducible; CI checks audio.wasm.sha256.
```

Append to `src/engine/NOTICE`:

```

FFmpeg decoders (src/wasm/audio/), LGPL-2.1-or-later
  audio.wasm is built from FFmpeg n9.0.2 (ac3, eac3, dca decoders) and src/wasm/audio/shim.c.
  See src/wasm/audio/NOTICE for the exact source and build.
```

Create `.github/workflows/wasm.yml`:

```yaml
name: WASM

on:
  push:
    branches: [main]
    paths: ['src/wasm/**']
  pull_request:
    paths: ['src/wasm/**']

jobs:
  reproducible:
    name: audio.wasm matches its source
    runs-on: ubuntu-latest
    timeout-minutes: 30
    steps:
      - uses: actions/checkout@v4
      - run: src/wasm/audio/build.sh
      - run: git diff --exit-code src/wasm/audio/
```

- [ ] **Step 9: Commit.**

```bash
git add src/wasm/audio package.json src/engine/decode/wasm-audio.ts src/engine/decode/wasm-audio.test.ts tests/helpers/audio-wasm.ts src/engine/NOTICE .github/workflows/wasm.yml
git commit -m "build(audio): reproducible FFmpeg AC-3/E-AC-3/DTS decoder in WASM with a loader"
```

---

### Task 4: Tone fixtures and decode quality

**Files:**
- Create: `scripts/make-audio-fixtures.ts`, `fixtures/synthetic/audio/{tone-ac3-stereo.ac3,tone-ac3-51.ac3,tone-eac3-51.eac3,tone-dts-51.dts}`
- Modify: `package.json` (`fixture:synthetic` also runs the new script)
- Test: `src/engine/decode/wasm-audio.test.ts`

**Interfaces:**
- Consumes: `AudioFramer` (Task 2), `WasmFrameDecoder`, `loadNodeAudioWasm` (Task 3), `fixtureDir` from `scripts/fixture-dir.ts`.

- [ ] **Step 1: Write the fixture script.** Create `scripts/make-audio-fixtures.ts`:

```ts
import { execFileSync } from 'node:child_process';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fixtureDir } from './fixture-dir';

const out = fixtureDir('fixtures/synthetic/audio');
rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });

/** 1 s of 440 Hz at −12 dBFS in the front left and right channels only, so a downmix keeps it in both. */
function tone(file: string, codec: string[], layout: 'stereo' | '5.1'): void {
  const pan = layout === 'stereo' ? 'pan=stereo|FL=c0|FR=c0' : 'pan=5.1|FL=c0|FR=c0';
  const bytes = execFileSync('ffmpeg', [
    '-v', 'error', '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000:duration=1',
    '-af', `volume=0.25,${pan}`, ...codec, '-',
  ], { maxBuffer: 1 << 26 });
  writeFileSync(join(out, file), bytes);
}

tone('tone-ac3-stereo.ac3', ['-c:a', 'ac3', '-b:a', '192k', '-f', 'ac3'], 'stereo');
tone('tone-ac3-51.ac3', ['-c:a', 'ac3', '-b:a', '448k', '-f', 'ac3'], '5.1');
tone('tone-eac3-51.eac3', ['-c:a', 'eac3', '-b:a', '384k', '-f', 'eac3'], '5.1');
tone('tone-dts-51.dts', ['-c:a', 'dca', '-strict', '-2', '-b:a', '768k', '-f', 'dts'], '5.1');
```

Change the `fixture:synthetic` script in `package.json` to start with `tsx scripts/make-audio-fixtures.ts && `, followed by the existing commands.

Run: `npx tsx scripts/make-audio-fixtures.ts && ls -l fixtures/synthetic/audio`
Expected: four files, each between 20 KB and 150 KB.

- [ ] **Step 2: Write the failing quality tests.** Append to `src/engine/decode/wasm-audio.test.ts`. Add `readFileSync` and `fileURLToPath` imports, `CodingType`, and `AudioFramer` from `./audio-frames`:

```ts
const AUDIO = fileURLToPath(new URL('../../../fixtures/synthetic/audio/', import.meta.url));

/** Decodes a whole elementary stream pushed as 4 KB "PES" pieces; returns the left channel and the frame PTS list. */
async function decodeFile(name: string, kind: 'ac3' | 'eac3' | 'dts', codingType: number): Promise<{ left: Float32Array; pts: number[]; failed: number }> {
  const bytes = readFileSync(AUDIO + name);
  const framer = new AudioFramer(kind, codingType);
  const decoder = new WasmFrameDecoder(await loadNodeAudioWasm(), kind === 'dts' ? WasmCodec.DTS : WasmCodec.AC3);
  const left: number[] = [];
  const pts: number[] = [];
  let failed = 0;
  for (let at = 0; at < bytes.length; at += 4096) {
    for (const frame of framer.push(bytes.subarray(at, at + 4096), 0)) {
      pts.push(frame.ptsUs);
      try {
        const { sampleRate, stereo } = decoder.decode(frame.data);
        expect(sampleRate).toBe(48_000);
        for (let i = 0; i < stereo.length; i += 2) left.push(stereo[i]);
      } catch (err) {
        if (!(err instanceof AudioFrameError)) throw err;
        failed++;
      }
    }
  }
  decoder.close();
  return { left: Float32Array.from(left), pts, failed };
}

/** Frequency from positive-going zero crossings, and RMS, over the middle of the signal (skips codec priming). */
function measure(left: Float32Array): { hz: number; rms: number } {
  const from = Math.floor(left.length * 0.2);
  const to = Math.floor(left.length * 0.8);
  let crossings = 0;
  let sum = 0;
  for (let i = from + 1; i < to; i++) {
    if (left[i - 1] < 0 && left[i] >= 0) crossings++;
    sum += left[i] * left[i];
  }
  return { hz: (crossings * 48_000) / (to - from), rms: Math.sqrt(sum / (to - from)) };
}

describe('audio.wasm decoding', () => {
  it.each([
    ['tone-ac3-stereo.ac3', 'ac3', CodingType.AC3],
    ['tone-ac3-51.ac3', 'ac3', CodingType.AC3],
    ['tone-eac3-51.eac3', 'eac3', CodingType.EAC3],
    ['tone-dts-51.dts', 'dts', CodingType.DTS],
  ] as const)('decodes %s to a 440 Hz stereo tone at the right level', async (name, kind, codingType) => {
    const { left, failed } = await decodeFile(name, kind, codingType);
    expect(failed).toBe(0);
    expect(left.length).toBeGreaterThan(40_000); // about 1 s; the last E-AC-3 group stays open
    const { hz, rms } = measure(left);
    expect(hz).toBeGreaterThan(430);
    expect(hz).toBeLessThan(450);
    // The source is 0.25 peak (rms ≈ 0.177); downmix normalisation may lower it, but it must stay clearly audible.
    expect(rms).toBeGreaterThan(0.05);
    expect(rms).toBeLessThan(0.25);
  });

  it('times AC-3 frames 32 ms apart', async () => {
    const { pts } = await decodeFile('tone-ac3-stereo.ac3', 'ac3', CodingType.AC3);
    expect(pts.slice(0, 3)).toEqual([0, 32_000, 64_000]);
  });

  it('counts one failed frame for a corrupted frame body and keeps decoding', async () => {
    const bytes = new Uint8Array(readFileSync(AUDIO + 'tone-ac3-stereo.ac3'));
    const framer = new AudioFramer('ac3', CodingType.AC3);
    const frames = framer.push(bytes, 0);
    frames[5].data.fill(0xff, 8); // keep the sync and size, ruin CRC and payload
    const decoder = new WasmFrameDecoder(await loadNodeAudioWasm(), WasmCodec.AC3);
    let failed = 0;
    let ok = 0;
    for (const f of frames) {
      try {
        decoder.decode(f.data);
        ok++;
      } catch (err) {
        if (!(err instanceof AudioFrameError)) throw err;
        failed++;
      }
    }
    decoder.close();
    expect(failed).toBe(1);
    expect(ok).toBe(frames.length - 1);
  });
});
```

- [ ] **Step 3: Run the tests.**

Run: `npx vitest run src/engine/decode/wasm-audio.test.ts`
Expected: PASS. These tests only use code from Tasks 2 and 3, so a failure is a real bug: a framer bug (frame counts or sizes), a shim downmix or format bug (level), or a broken fixture. Fix the cause; don't loosen the bounds. If the corrupted-frame test sees 0 failures, it means FFmpeg concealed the error instead of rejecting the frame. In that case change the assertion to `failed + ok === frames.length` and add a comment explaining it.

- [ ] **Step 4: Commit.**

```bash
git add scripts/make-audio-fixtures.ts fixtures/synthetic/audio package.json src/engine/decode/wasm-audio.test.ts
git commit -m "test(audio): decode ffmpeg-made AC-3, E-AC-3 and DTS tones through audio.wasm"
```

---

### Task 5: `AudioDecoder` factory, TrueHD core filter and the playable set

**Files:**
- Create: `src/engine/decode/truehd-core.ts`, `src/engine/decode/audio-decoder.ts`
- Modify: `src/engine/playback/stream-selection.ts`
- Modify (tests that used AC-3 as "unsupported"): `src/engine/playback/stream-selection.test.ts`, `src/engine/player.test.ts`
- Test: `src/engine/decode/truehd-core.test.ts`, `src/engine/decode/audio-decoder.test.ts`

**Interfaces:**
- Consumes: `AudioFramer`, `FramerKind` (Task 2); `AudioWasm`, `WasmFrameDecoder`, `WasmCodec`, `AudioFrameError` (Task 3); `decodeLpcm`, `PcmChunk` from `./lpcm`.
- Produces:
  ```ts
  // truehd-core.ts
  export const AC3_CORE_EXTENSION = 0x76;
  export class TrueHdCoreFilter { accept(unit: AudioUnit): boolean; reset(): void }  // accept throws UnsupportedCodecError
  // audio-decoder.ts
  export interface AudioUnit { readonly data: Uint8Array; readonly ptsUs: number; readonly streamIdExtension?: number }
  export interface AudioDecodeResult { readonly chunks: readonly PcmChunk[]; readonly failedFrames: number }
  export interface AudioDecoder { decode(unit: AudioUnit): AudioDecodeResult; reset(): void; close(): void }
  export type AudioDecoderFactory = (codingType: number) => Promise<AudioDecoder>;
  export function createAudioDecoderFactory(loadWasm: () => Promise<AudioWasm>): AudioDecoderFactory;
  // stream-selection.ts
  export const PLAYABLE_AUDIO: ReadonlySet<number>; // {0x80,0x81,0x82,0x83,0x84,0x85,0x86}
  export interface StreamChoice { video; audio; audioIndex: number | null; unsupportedAudio }
  export function audioEntryFor(item: PlayItem, stream: number | null): StreamEntry | null;
  ```
  `decode` throws `UnsupportedCodecError` for stream-level problems. Corrupt frames are counted in `failedFrames`.

- [ ] **Step 1: Write the failing tests.** Create `src/engine/decode/truehd-core.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { UnsupportedCodecError } from './decoder';
import { TrueHdCoreFilter } from './truehd-core';

const unit = (ext: number | undefined, ptsUs: number, first = 0xf8) => ({ data: new Uint8Array([first, 0x77, 0, 0]), ptsUs, streamIdExtension: ext });

describe('TrueHdCoreFilter', () => {
  it('keeps the AC-3 core (0x76) and drops MLP (0x72)', () => {
    const f = new TrueHdCoreFilter();
    expect([f.accept(unit(0x72, 0)), f.accept(unit(0x76, 0)), f.accept(unit(0x72, 1000))]).toEqual([false, true, false]);
  });

  it('falls back to the AC-3 sync word when a packet has no extension', () => {
    const f = new TrueHdCoreFilter();
    expect([f.accept(unit(undefined, 0, 0x0b)), f.accept(unit(undefined, 0, 0xf8))]).toEqual([true, false]);
  });

  it('gives up after 2 s of input without a core', () => {
    const f = new TrueHdCoreFilter();
    expect(f.accept(unit(0x72, 0))).toBe(false);
    expect(f.accept(unit(0x72, 1_999_000))).toBe(false);
    expect(() => f.accept(unit(0x72, 2_000_000))).toThrow(new UnsupportedCodecError(0x83, "This TrueHD track has no Dolby Digital core, so it can't be played."));
  });
});
```

Create `src/engine/decode/audio-decoder.test.ts`:

```ts
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { loadNodeAudioWasm } from '../../../tests/helpers/audio-wasm';
import { lpcmPayload } from '../../../tests/helpers/synthetic-disc';
import { CodingType } from '../bdmv/stream-types';
import { createAudioDecoderFactory } from './audio-decoder';
import { UnsupportedCodecError } from './decoder';

const AC3 = readFileSync(fileURLToPath(new URL('../../../fixtures/synthetic/audio/tone-ac3-stereo.ac3', import.meta.url)));

describe('createAudioDecoderFactory', () => {
  it('decodes LPCM without loading the WASM and counts a corrupt unit as one failed frame', async () => {
    let loads = 0;
    const factory = createAudioDecoderFactory(() => {
      loads++;
      return loadNodeAudioWasm();
    });
    const d = await factory(CodingType.LPCM);
    const ok = d.decode({ data: lpcmPayload(240, 0), ptsUs: 5_000 });
    expect(ok.failedFrames).toBe(0);
    expect(ok.chunks.map((c) => [c.ptsUs, c.frames, c.sampleRate])).toEqual([[5_000, 240, 48_000]]);
    const bad = lpcmPayload(240, 0);
    bad[2] = 0x30; // reserved sample-rate code
    expect(d.decode({ data: bad, ptsUs: 0 })).toEqual({ chunks: [], failedFrames: 1 });
    expect(loads).toBe(0);
  });

  it('decodes AC-3 through the WASM and loads it once for several decoders', async () => {
    let loads = 0;
    const factory = createAudioDecoderFactory(() => {
      loads++;
      return loadNodeAudioWasm();
    });
    const d = await factory(CodingType.AC3);
    await factory(CodingType.DTS);
    const r = d.decode({ data: AC3.subarray(0, 3 * 768), ptsUs: 1_000_000 }); // 192 kb/s → 768-byte frames
    expect(r.failedFrames).toBe(0);
    expect(r.chunks.map((c) => [c.ptsUs, c.frames])).toEqual([
      [1_000_000, 1536],
      [1_032_000, 1536],
      [1_064_000, 1536],
    ]);
    expect(loads).toBe(1);
    d.close();
  });

  it('plays only the AC-3 core of a TrueHD stream', async () => {
    const d = await createAudioDecoderFactory(loadNodeAudioWasm)(CodingType.TRUEHD);
    expect(d.decode({ data: new Uint8Array(400).fill(0xf8), ptsUs: 0, streamIdExtension: 0x72 })).toEqual({ chunks: [], failedFrames: 0 });
    const r = d.decode({ data: AC3.subarray(0, 768), ptsUs: 0, streamIdExtension: 0x76 });
    expect(r.chunks).toHaveLength(1);
    d.close();
  });

  it('retries a failed WASM load on the next request', async () => {
    let calls = 0;
    const factory = createAudioDecoderFactory(() => (++calls === 1 ? Promise.reject(new Error('offline')) : loadNodeAudioWasm()));
    await expect(factory(CodingType.AC3)).rejects.toThrow('offline');
    await expect(factory(CodingType.AC3)).resolves.toBeDefined();
  });

  it('rejects secondary audio as unsupported', async () => {
    await expect(createAudioDecoderFactory(loadNodeAudioWasm)(CodingType.EAC3_SECONDARY)).rejects.toBeInstanceOf(UnsupportedCodecError);
  });
});
```

Check the AC-3 frame size assumption: a 192 kb/s 48 kHz frame is 768 bytes. `lpcmPayload` is already exported from `tests/helpers/synthetic-disc.ts`.

Run: `npx vitest run src/engine/decode/truehd-core.test.ts src/engine/decode/audio-decoder.test.ts`
Expected: FAIL (modules not found).

- [ ] **Step 2: Implement `truehd-core.ts`.**

```ts
import { CodingType } from '../bdmv/stream-types';
import type { AudioUnit } from './audio-decoder';
import { UnsupportedCodecError } from './decoder';

/** PES stream_id_extension of the AC-3 substream inside a Blu-ray TrueHD PID (MLP is 0x72); as in libavformat mpegts.c. */
export const AC3_CORE_EXTENSION = 0x76;
const NO_CORE_LIMIT_US = 2_000_000;

/** Passes only the AC-3 core units of a TrueHD stream. */
export class TrueHdCoreFilter {
  private firstUs: number | null = null;
  private seenCore = false;

  accept(unit: AudioUnit): boolean {
    const core = unit.streamIdExtension === undefined ? unit.data[0] === 0x0b && unit.data[1] === 0x77 : unit.streamIdExtension === AC3_CORE_EXTENSION;
    if (core) {
      this.seenCore = true;
      return true;
    }
    if (!this.seenCore) {
      this.firstUs ??= unit.ptsUs;
      if (unit.ptsUs - this.firstUs >= NO_CORE_LIMIT_US) {
        throw new UnsupportedCodecError(CodingType.TRUEHD, "This TrueHD track has no Dolby Digital core, so it can't be played.");
      }
    }
    return false;
  }

  reset(): void {
    this.firstUs = null;
  }
}
```

- [ ] **Step 3: Implement `audio-decoder.ts`.**

```ts
import { CodingType, codingName } from '../bdmv/stream-types';
import { AudioFramer, type FramerKind } from './audio-frames';
import { UnsupportedCodecError } from './decoder';
import { decodeLpcm, type PcmChunk } from './lpcm';
import { TrueHdCoreFilter } from './truehd-core';
import { AudioFrameError, WasmCodec, WasmFrameDecoder, type AudioWasm } from './wasm-audio';

export interface AudioUnit {
  readonly data: Uint8Array;
  /** Playlist time. */
  readonly ptsUs: number;
  readonly streamIdExtension?: number;
}

export interface AudioDecodeResult {
  readonly chunks: readonly PcmChunk[];
  /** Frames (or units) that could not be decoded and were skipped. */
  readonly failedFrames: number;
}

/** Synchronous PES-in, PCM-out decoder. Throws UnsupportedCodecError for stream-level problems. */
export interface AudioDecoder {
  decode(unit: AudioUnit): AudioDecodeResult;
  /** After a seek: drop buffered bytes and decoder state. */
  reset(): void;
  close(): void;
}

export type AudioDecoderFactory = (codingType: number) => Promise<AudioDecoder>;

const OUTPUT_RATE = 48_000;

const lpcmDecoder: AudioDecoder = {
  decode(unit) {
    try {
      return { chunks: [decodeLpcm(unit.data, unit.ptsUs)], failedFrames: 0 };
    } catch (err) {
      if (err instanceof UnsupportedCodecError) throw err;
      return { chunks: [], failedFrames: 1 };
    }
  },
  reset: () => undefined,
  close: () => undefined,
};

class FramedWasmDecoder implements AudioDecoder {
  constructor(
    private readonly codingType: number,
    private readonly framer: AudioFramer,
    private readonly frames: WasmFrameDecoder,
    private readonly coreFilter: TrueHdCoreFilter | null,
  ) {}

  decode(unit: AudioUnit): AudioDecodeResult {
    if (this.coreFilter && !this.coreFilter.accept(unit)) return { chunks: [], failedFrames: 0 };
    const chunks: PcmChunk[] = [];
    let failedFrames = 0;
    for (const frame of this.framer.push(unit.data, unit.ptsUs)) {
      let out: { sampleRate: number; stereo: Float32Array };
      try {
        out = this.frames.decode(frame.data);
      } catch (err) {
        if (!(err instanceof AudioFrameError)) throw err;
        failedFrames++;
        continue;
      }
      if (out.stereo.length === 0) continue;
      if (out.sampleRate !== OUTPUT_RATE) {
        throw new UnsupportedCodecError(this.codingType, `${codingName(this.codingType)} at ${out.sampleRate} Hz is not supported (only 48 kHz).`);
      }
      chunks.push({ ptsUs: frame.ptsUs, sampleRate: out.sampleRate, frames: out.stereo.length / 2, stereo: out.stereo });
    }
    return { chunks, failedFrames };
  }

  reset(): void {
    this.framer.reset();
    this.frames.reset();
    this.coreFilter?.reset();
  }

  close(): void {
    this.frames.close();
  }
}

const WASM_KINDS: ReadonlyMap<number, FramerKind> = new Map([
  [CodingType.AC3, 'ac3'],
  [CodingType.TRUEHD, 'ac3'],
  [CodingType.EAC3, 'eac3'],
  [CodingType.DTS, 'dts'],
  [CodingType.DTSHD, 'dts'],
  [CodingType.DTSHD_MASTER, 'dts'],
]);

/** Builds decoders per coding type. The WASM module is loaded on first use and shared; a failed load is retried next time. */
export function createAudioDecoderFactory(loadWasm: () => Promise<AudioWasm>): AudioDecoderFactory {
  let wasm: Promise<AudioWasm> | null = null;
  const getWasm = (): Promise<AudioWasm> => {
    if (!wasm) {
      const p = loadWasm();
      wasm = p;
      p.catch(() => {
        if (wasm === p) wasm = null;
      });
    }
    return wasm;
  };
  return async (codingType) => {
    if (codingType === CodingType.LPCM) return lpcmDecoder;
    const kind = WASM_KINDS.get(codingType);
    if (!kind) throw new UnsupportedCodecError(codingType, `${codingName(codingType)} audio is not supported.`);
    const module = await getWasm();
    return new FramedWasmDecoder(
      codingType,
      new AudioFramer(kind, codingType),
      new WasmFrameDecoder(module, kind === 'dts' ? WasmCodec.DTS : WasmCodec.AC3),
      codingType === CodingType.TRUEHD ? new TrueHdCoreFilter() : null,
    );
  };
}
```

- [ ] **Step 4: Update stream selection.** Replace `src/engine/playback/stream-selection.ts` with:

```ts
import type { PlayItem, StnTable, StreamEntry } from '../bdmv/mpls-parser';
import { CodingType } from '../bdmv/stream-types';

/** Audio coding types this build can decode (TrueHD through its AC-3 core, DTS-HD through its DTS core). */
export const PLAYABLE_AUDIO: ReadonlySet<number> = new Set([
  CodingType.LPCM,
  CodingType.AC3,
  CodingType.DTS,
  CodingType.TRUEHD,
  CodingType.EAC3,
  CodingType.DTSHD,
  CodingType.DTSHD_MASTER,
]);

export interface StreamChoice {
  readonly video: StreamEntry | null;
  readonly audio: StreamEntry | null;
  /** 1-based STN position of `audio` (the Blu-ray audio stream number), or null. */
  readonly audioIndex: number | null;
  /** Main-path audio streams present but not decodable (empty when `audio` is set). */
  readonly unsupportedAudio: readonly StreamEntry[];
}

export function chooseStreams(stn: StnTable, playableAudio: ReadonlySet<number> = PLAYABLE_AUDIO): StreamChoice {
  const video = stn.video.find((s) => !s.subPath) ?? null;
  const at = stn.audio.findIndex((s) => !s.subPath && playableAudio.has(s.codingType));
  const audio = at >= 0 ? stn.audio[at] : null;
  return { video, audio, audioIndex: at >= 0 ? at + 1 : null, unsupportedAudio: audio ? [] : stn.audio.filter((s) => !s.subPath) };
}

/** The main-path entry for audio stream number `stream` in this play item, if it has one. */
export function audioEntryFor(item: PlayItem, stream: number | null): StreamEntry | null {
  if (stream === null) return null;
  const entry = item.stn.audio[stream - 1];
  return entry && !entry.subPath ? entry : null;
}
```

- [ ] **Step 5: Update the tests that relied on AC-3, TrueHD or DTS being unsupported.**
  - In `src/engine/playback/stream-selection.test.ts`, change the import to `import { audioEntryFor, chooseStreams } from './stream-selection';` and add `import type { PlayItem } from '../bdmv/mpls-parser';`, then replace the three tests with:

```ts
  it('picks the first main-path video and the first playable audio, with its stream number', () => {
    const choice = chooseStreams({
      video: [entry(0x1b00, CodingType.AVC, true), entry(0x1011, CodingType.AVC)],
      audio: [entry(0x1100, CodingType.EAC3_SECONDARY), entry(0x1101, CodingType.AC3), entry(0x1102, CodingType.LPCM)],
      pg: [],
      ig: [],
    });
    expect(choice.video?.pid).toBe(0x1011);
    expect(choice.audio?.pid).toBe(0x1101);
    expect(choice.audioIndex).toBe(2);
    expect(choice.unsupportedAudio).toEqual([]);
  });

  it('plays TrueHD and DTS-HD (through their cores)', () => {
    const choice = chooseStreams({ video: [], audio: [entry(0x1100, CodingType.TRUEHD), entry(0x1101, CodingType.DTSHD_MASTER)], pg: [], ig: [] });
    expect(choice.audio?.codingType).toBe(CodingType.TRUEHD);
  });

  it('reports unsupported audio when nothing is playable', () => {
    const choice = chooseStreams({ video: [entry(0x1011, CodingType.AVC)], audio: [entry(0x1100, CodingType.EAC3_SECONDARY), entry(0x1101, CodingType.DTSHD_SECONDARY)], pg: [], ig: [] });
    expect(choice.audio).toBeNull();
    expect(choice.audioIndex).toBeNull();
    expect(choice.unsupportedAudio.map((a) => a.codingType)).toEqual([CodingType.EAC3_SECONDARY, CodingType.DTSHD_SECONDARY]);
  });

  it('handles playlists without audio or video', () => {
    expect(chooseStreams({ video: [], audio: [], pg: [], ig: [] })).toEqual({ video: null, audio: null, audioIndex: null, unsupportedAudio: [] });
  });
});

describe('audioEntryFor', () => {
  const item = { stn: { video: [], audio: [entry(0x1100, CodingType.LPCM), entry(0x1101, CodingType.AC3), entry(0x1102, CodingType.AC3, true)], pg: [], ig: [] } } as unknown as PlayItem;

  it('returns the main-path entry for a stream number, or null', () => {
    expect(audioEntryFor(item, 2)?.pid).toBe(0x1101);
    expect(audioEntryFor(item, 3)).toBeNull(); // sub-path
    expect(audioEntryFor(item, 4)).toBeNull();
    expect(audioEntryFor(item, null)).toBeNull();
  });
```

  (The closing `});` of `describe('audioEntryFor')` ends the file.)
  - In `src/engine/player.test.ts`, the three `harness(CodingType.AC3)` calls (around lines 167, 255 and 348) become `harness(CodingType.EAC3_SECONDARY)`. The `unsupported` assertion's codec becomes `'Dolby Digital Plus (secondary)'`.

- [ ] **Step 6: Run the tests and check that they pass.**

Run: `npx vitest run src/engine/decode src/engine/playback src/engine/player.test.ts`
Expected: PASS.

- [ ] **Step 7: Commit.**

```bash
git add src/engine/decode/truehd-core.ts src/engine/decode/truehd-core.test.ts src/engine/decode/audio-decoder.ts src/engine/decode/audio-decoder.test.ts src/engine/playback/stream-selection.ts src/engine/playback/stream-selection.test.ts src/engine/player.test.ts
git commit -m "feat(audio): decoder factory for LPCM, AC-3, E-AC-3, TrueHD core and DTS core"
```

---

### Task 6: Several audio streams in synthetic discs; per-item audio PIDs in the pipeline

**Files:**
- Modify: `tests/helpers/synthetic-disc.ts`
- Modify: `src/engine/playback/pipeline.ts`
- Modify: `src/engine/player.ts` (only to pass the new pipeline config; the full integration is Task 7)
- Test: `src/engine/playback/pipeline.test.ts`

**Interfaces:**
- Consumes: `audioEntryFor` (Task 5); `MuxUnit.streamIdExtension` (Task 1).
- Produces:
  ```ts
  // synthetic-disc.ts
  export interface SyntheticAudioUnit { pts: number; payload: Uint8Array; streamIdExtension?: number }
  export interface SyntheticAudioStream { pid: number; codingType: number; format?: number; lang?: string; units: SyntheticAudioUnit[] }
  export function lpcmStream(pid: number, seconds: number, opts?: { startPts?: number; lang?: string }): SyntheticAudioStream;
  export function dummyAudioStream(pid: number, codingType: number, seconds: number, opts?: { startPts?: number; lang?: string; format?: number }): SyntheticAudioStream;
  // SyntheticClipSpec.audioStreams?: SyntheticAudioStream[]; syntheticClip opts.audioStreams
  // pipeline.ts
  export interface PipelineAudioUnit extends PipelineUnit { readonly codingType: number; readonly streamIdExtension?: number }
  export interface PipelineSinks { video(unit: PipelineUnit): void; audio(unit: PipelineAudioUnit): void; isFull(): boolean; ended(): void; failed(err: unknown): void }
  export interface PipelineConfig { source; timeline; clips; videoPid: number; playItems: readonly PlayItem[]; audioStream: number | null }
  PlaybackPipeline.setAudioStream(stream: number | null): void   // takes effect on the next start()
  ```

- [ ] **Step 1: Extend the synthetic disc builder.** In `tests/helpers/synthetic-disc.ts`:
  - Add the two interfaces above.
  - Add `audioStreams?: SyntheticAudioStream[]` to `SyntheticClipSpec`, with the doc comment "Replaces `audio` when set: each stream on its own PID, listed in this order in the CLPI and STN."
  - Add `audioStreams?: SyntheticAudioStream[]` to the options of `syntheticClip` and pass it through to the returned spec.
  - Add the helpers:

```ts
/** LPCM tone PES every 5 ms on `pid`. */
export function lpcmStream(pid: number, seconds: number, opts: { startPts?: number; lang?: string } = {}): SyntheticAudioStream {
  const start = opts.startPts ?? CLIP_START_PTS;
  const count = Math.ceil((seconds * 90_000) / AUDIO_PES_TICKS_90K);
  const units = Array.from({ length: count }, (_, j) => ({ pts: start + j * AUDIO_PES_TICKS_90K, payload: lpcmPayload(AUDIO_FRAMES_PER_PES, j * AUDIO_FRAMES_PER_PES) }));
  return { pid, codingType: CodingType.LPCM, lang: opts.lang, units };
}

/** Placeholder payloads every 5 ms for codecs the unit tests decode with fakes. */
export function dummyAudioStream(pid: number, codingType: number, seconds: number, opts: { startPts?: number; lang?: string; format?: number } = {}): SyntheticAudioStream {
  const start = opts.startPts ?? CLIP_START_PTS;
  const count = Math.ceil((seconds * 90_000) / AUDIO_PES_TICKS_90K);
  const units = Array.from({ length: count }, (_, j) => ({ pts: start + j * AUDIO_PES_TICKS_90K, payload: new Uint8Array(64).fill(0x0b) }));
  return { pid, codingType, lang: opts.lang, format: opts.format, units };
}
```

  In `buildSyntheticDisc`, replace the `if (clip.audio !== undefined) { … }` block, the `muxKey` and sort lines, the `streams` construction and the `clips.set` call with:

```ts
    const audioStreams: SyntheticAudioStream[] = clip.audioStreams ?? (clip.audio !== undefined ? [legacyAudioStream(clip, endPts)] : []);
    for (const stream of audioStreams) {
      for (const u of stream.units) {
        units.push({ pid: stream.pid, streamId: u.streamIdExtension === undefined ? 0xbd : 0xfd, streamIdExtension: u.streamIdExtension, pts: u.pts, payload: u.payload });
      }
    }
    const lag = clip.audioMuxLag90k ?? 0;
    const isAudio = (u: MuxUnit): boolean => u.pid !== VIDEO_PID;
    const muxKey = (u: MuxUnit): number => (u.dts ?? u.pts) + (isAudio(u) ? lag : 0);
    units.sort((a, b) => muxKey(a) - muxKey(b) || (isAudio(a) ? -1 : 1));
```

and

```ts
    const audioSpecs = audioStreams.map((s) => ({ pid: s.pid, codingType: s.codingType, format: s.format, lang: s.lang }));
    const streams: Array<{ pid: number; codingType: number }> = [{ pid: VIDEO_PID, codingType: CodingType.AVC }, ...audioSpecs.map(({ pid, codingType }) => ({ pid, codingType }))];
    …
    clips.set(clip.clipId, { inTime: clip.startPts / 2, outTime: endPts / 2, audio: audioSpecs });
```

  Change the `clips` map type to `Map<string, { inTime: number; outTime: number; audio: StreamSpec[] }>` (import `type StreamSpec` from `./bdmv-builders`). Change the play item line to `audio: clip.audio,`. Then add, below `buildSyntheticDisc`:

```ts
function legacyAudioStream(clip: SyntheticClipSpec, endPts: number): SyntheticAudioStream {
  const codingType = clip.audio ?? CodingType.LPCM;
  const count = Math.ceil((endPts - clip.startPts) / AUDIO_PES_TICKS_90K);
  const units = Array.from({ length: count }, (_, j) => {
    const payload = codingType === CodingType.LPCM ? lpcmPayload(AUDIO_FRAMES_PER_PES, j * AUDIO_FRAMES_PER_PES) : new Uint8Array(64).fill(0x0b);
    if (j === clip.corruptAudioPesIndex && payload.length > 2) payload[2] = 0x30; // reserved sample-rate code
    return { pts: clip.startPts + j * AUDIO_PES_TICKS_90K, payload };
  });
  return { pid: AUDIO_PID, codingType, units };
}
```

  The `units` array in `buildSyntheticDisc` is typed `Array<MuxUnit & { videoIndex?: number }>`, so pushing an audio unit with `streamIdExtension` typechecks after Task 1.

  Then check that nothing changed for the existing callers: run `npx vitest run src/engine` and `npm run typecheck`. Both must pass. Then run `npm run fixture:synthetic` and `git status --short fixtures/`. **Expected: no changes to disc1, disc2 or vc1-disc.** The builder must still produce identical bytes for one-stream clips.

- [ ] **Step 2: Write the failing pipeline test.** In `src/engine/playback/pipeline.test.ts`, change `setup()` so it returns `{ source, timeline: new Timeline(mpls.playItems), clips: …, videoPid: VIDEO_PID, playItems: mpls.playItems, audioStream: 1 }`, and type `Collected.audio` as `PipelineAudioUnit[]` (import the type). Add:

```ts
  it('resolves the audio PID per play item from the stream number', async () => {
    const files = buildSyntheticDisc({
      clips: [
        syntheticClip('00001', 2, { audioStreams: [lpcmStream(0x1100, 2)] }),
        syntheticClip('00002', 2, { audioStreams: [lpcmStream(0x1101, 2)] }),
        syntheticClip('00003', 2, {}),
      ],
      playlists: [{ id: '00000', clipIds: ['00001', '00002', '00003'] }],
    });
    const source = syntheticSource(files);
    const mpls = parseMpls(await readWhole(source, 'BDMV/PLAYLIST/00000.MPLS'));
    const config: PipelineConfig = {
      source,
      timeline: new Timeline(mpls.playItems),
      clips: await loadClips(source, ['00001', '00002', '00003']),
      videoPid: VIDEO_PID,
      playItems: mpls.playItems,
      audioStream: 1,
    };
    const { got, done } = run(config, 0);
    await done;
    const inItem = (from: number, to: number) => got.audio.filter((u) => u.ptsUs >= from && u.ptsUs < to);
    expect(inItem(0, 2_000_000).length).toBeGreaterThan(300);
    expect(inItem(2_000_000, 4_000_000).length).toBeGreaterThan(300);
    expect(inItem(4_000_000, 6_000_000)).toEqual([]); // the third item has no audio stream
    expect(new Set(got.audio.map((u) => u.codingType))).toEqual(new Set([CodingType.LPCM]));
  });

  it('reads no audio when the stream number is null, and follows setAudioStream on the next start', async () => {
    const config = { ...(await setup()), audioStream: null };
    const silent = run(config, 0);
    await silent.done;
    expect(silent.got.audio).toEqual([]);

    let finish: () => void = () => undefined;
    const done = new Promise<void>((r) => (finish = r));
    const got: PipelineAudioUnit[] = [];
    const p = new PlaybackPipeline(config, { video: () => undefined, audio: (u) => got.push(u), isFull: () => false, ended: () => finish(), failed: () => finish() });
    p.setAudioStream(1);
    p.start(0);
    await done;
    expect(got.length).toBeGreaterThan(0);
  });
```

Import `lpcmStream` from the helpers and `PlaybackPipeline` and `PipelineAudioUnit` from `./pipeline` (as type imports where the name is only used as a type).

Run: `npx vitest run src/engine/playback/pipeline.test.ts`
Expected: FAIL. TypeScript errors: `playItems` and `audioStream` aren't in `PipelineConfig`, and `setAudioStream` doesn't exist.

- [ ] **Step 3: Implement it in the pipeline.** In `src/engine/playback/pipeline.ts`:

```ts
import type { PlayItem } from '../bdmv/mpls-parser';
import { audioEntryFor } from './stream-selection';

export interface PipelineAudioUnit extends PipelineUnit {
  /** Coding type of the selected stream in this unit's play item. */
  readonly codingType: number;
  readonly streamIdExtension?: number;
}

export interface PipelineSinks {
  video(unit: PipelineUnit): void;
  audio(unit: PipelineAudioUnit): void;
  /** Backpressure: reading pauses while this returns true. */
  isFull(): boolean;
  ended(): void;
  failed(err: unknown): void;
}

export interface PipelineConfig {
  readonly source: ByteSource;
  readonly timeline: Timeline;
  readonly clips: ReadonlyMap<string, Clpi>;
  readonly videoPid: number;
  /** Same order as the timeline items; each has its own STN, so a stream's PID can change per item. */
  readonly playItems: readonly PlayItem[];
  /** 1-based audio stream number, or null for no audio. */
  readonly audioStream: number | null;
}
```

In the class, add `private audioStream: number | null;`, set it in the constructor body (`this.audioStream = config.audioStream;`), and add:

```ts
  /** Takes effect on the next start(). */
  setAudioStream(stream: number | null): void {
    this.audioStream = stream;
  }
```

In `run()`:
- Read `const { source, timeline, clips, videoPid, playItems } = this.config;` and `const audioStream = this.audioStream;` at the top.
- Delete the old `pids` lines.
- Inside the item loop, after the `clip` lookup, compute:

```ts
      const audioEntry = audioEntryFor(playItems[i], audioStream);
      const pids = new Set([videoPid]);
      if (audioEntry) pids.add(audioEntry.pid);
```

- Pass `pids` to the reader. Replace the unit dispatch with:

```ts
          const { us, inRange } = timeline.toPlaylistUs(i, pes.pts);
          if (pes.pid === videoPid) this.sinks.video({ data: pes.payload, ptsUs: us, inRange });
          else if (audioEntry && pes.pid === audioEntry.pid) {
            this.sinks.audio({ data: pes.payload, ptsUs: us, inRange, codingType: audioEntry.codingType, streamIdExtension: pes.streamIdExtension });
          }
```

- [ ] **Step 4: Keep the player compiling.** In `src/engine/player.ts` `playPlaylist`, change the `PlaybackPipeline` config to:

```ts
      { source, timeline, clips, videoPid: choice.video.pid, playItems: mpls.playItems, audioStream: audioActive ? choice.audioIndex : null },
```

The `audio:` sink passes the new unit type to `onAudioUnit`. Change `onAudioUnit`'s parameter type to `PipelineAudioUnit` (import it). It keeps decoding with `decodeLpcm` until Task 7.

- [ ] **Step 5: Run the tests and check that they pass.**

Run: `npx vitest run src/engine && npm run typecheck`
Expected: PASS.

- [ ] **Step 6: Commit.**

```bash
git add tests/helpers/synthetic-disc.ts src/engine/playback/pipeline.ts src/engine/playback/pipeline.test.ts src/engine/player.ts
git commit -m "feat(pipeline): choose audio by stream number and resolve its PID per play item"
```

---

### Task 7: Player audio decoding through the factory

**Files:**
- Modify: `src/engine/player.ts`, `src/engine/worker.ts`, `src/engine/protocol.ts` (telemetry only)
- Test: `src/engine/player.test.ts`

**Interfaces:**
- Consumes: `AudioDecoder`, `AudioDecoderFactory`, `AudioDecodeResult`, `createAudioDecoderFactory` (Task 5); `loadAudioWasm` (Task 3); `PipelineAudioUnit`, `setAudioStream` (Task 6); `audioEntryFor`, `PLAYABLE_AUDIO` (Task 5).
- Produces:
  - `PlayerDeps.createAudioDecoder: AudioDecoderFactory` (required).
  - `Telemetry.audioCodec: string | null`; `Telemetry.audioDecodeErrors: number`.
  - Session fields used by Task 8: `audioStream: number | null`, `playItems: readonly PlayItem[]`, `audioDecoders: Map<number, AudioDecoder>`, `audioDecoderLoads: Map<number, Promise<AudioDecoder>>`, `audioErrorsInRow: number`, `audioErrorDisabled: boolean`.
  - Player methods used by Task 8: `private loadAudioDecoder(s, codingType): Promise<AudioDecoder>`, `private audioCodingTypeAt(s, timeUs): number | null`.

- [ ] **Step 1: Write the failing tests.** In `src/engine/player.test.ts`:
  - Extend the `harness` options with `audioStreams?: SyntheticAudioStream[]` (passed to both `syntheticClip` calls) and `createAudioDecoder?: AudioDecoderFactory`.
  - Pass `createAudioDecoder: opts.createAudioDecoder ?? noWasmFactory` to `new Player({…})`.
  - Add these helpers above `describe`:

```ts
const noWasmFactory = createAudioDecoderFactory(() => Promise.reject(new Error('no wasm in unit tests')));

interface FakeAudioLog {
  decoded: number[];
  resets: number;
  failNext: number;
}

/** LPCM decodes for real; AC-3 decodes to silence 240 frames per unit, failing `failNext` units first. */
function fakeAudioFactory(log: FakeAudioLog = { decoded: [], resets: 0, failNext: 0 }, gate?: Promise<void>): AudioDecoderFactory {
  return async (codingType) => {
    if (codingType !== CodingType.AC3) return noWasmFactory(codingType);
    await gate;
    return {
      decode: (u) => {
        if (log.failNext > 0) {
          log.failNext--;
          return { chunks: [], failedFrames: 1 };
        }
        log.decoded.push(u.ptsUs);
        return { chunks: [{ ptsUs: u.ptsUs, sampleRate: 48_000, frames: 240, stereo: new Float32Array(480) }], failedFrames: 0 };
      },
      reset: () => {
        log.resets++;
      },
      close: () => undefined,
    };
  };
}
```

Add these tests inside `describe('Player')`:

```ts
  it('plays AC-3 audio on the audio clock through the decoder factory', async () => {
    const log: FakeAudioLog = { decoded: [], resets: 0, failNext: 0 };
    const h = await harness(CodingType.AC3, { createAudioDecoder: fakeAudioFactory(log) });
    await h.player.handle({ type: 'playPlaylist', playlistId: '00000' });
    await untilPlaying(h);
    await h.play(1000);
    expect(log.decoded.length).toBeGreaterThan(100);
    expect(lastTelemetry(h)).toMatchObject({ clockMode: 'audio', audioCodec: 'Dolby Digital (AC-3)', audioDecodeErrors: 0 });
  });

  it('falls back to the wall clock when the audio decoder cannot load', async () => {
    const h = await harness(CodingType.AC3); // noWasmFactory
    await h.player.handle({ type: 'playPlaylist', playlistId: '00000' });
    expect(h.events).toContainEqual(expect.objectContaining({ type: 'unsupported', kind: 'audio', codec: 'Dolby Digital (AC-3)' }));
    await untilPlaying(h);
    h.drawn.length = 0;
    await h.play(1000);
    expect(h.drawn.length).toBeGreaterThan(15);
    expect(lastTelemetry(h)?.clockMode).toBe('wall');
  });

  it('resets the audio decoders on seek', async () => {
    const log: FakeAudioLog = { decoded: [], resets: 0, failNext: 0 };
    const h = await harness(CodingType.AC3, { createAudioDecoder: fakeAudioFactory(log) });
    await h.player.handle({ type: 'playPlaylist', playlistId: '00000' });
    await untilPlaying(h);
    const before = log.resets;
    await h.player.handle({ type: 'seek', timeUs: 3_000_000 });
    expect(log.resets).toBeGreaterThan(before);
  });

  it('disables audio after more than 50 failed frames in a row and retries on the next seek', async () => {
    const log: FakeAudioLog = { decoded: [], resets: 0, failNext: 0 };
    const h = await harness(CodingType.AC3, { createAudioDecoder: fakeAudioFactory(log) });
    await h.player.handle({ type: 'playPlaylist', playlistId: '00000' });
    await untilPlaying(h);
    log.failNext = 60;
    await h.play(1000);
    expect(h.events).toContainEqual(expect.objectContaining({ type: 'notice', code: 'audio-disabled' }));
    expect(lastTelemetry(h)?.clockMode).toBe('wall');
    expect(lastTelemetry(h)?.audioDecodeErrors).toBeGreaterThan(50);
    await h.player.handle({ type: 'seek', timeUs: 1_000_000 });
    await untilPlaying(h);
    await h.play(1000);
    expect(lastTelemetry(h)?.clockMode).toBe('audio');
  });
```

Imports to add: `createAudioDecoderFactory` and `type AudioDecoderFactory` from `./decode/audio-decoder`, and `type SyntheticAudioStream` from the helpers.

Run: `npx vitest run src/engine/player.test.ts`
Expected: FAIL: the type error for the unknown `createAudioDecoder` dep, and `audioCodec` is missing from telemetry.

- [ ] **Step 2: Add the telemetry fields.** In `src/engine/protocol.ts` `Telemetry`, add:

```ts
  /** Coding name of the stream whose decoder last produced PCM, or null before any. */
  readonly audioCodec: string | null;
  readonly audioDecodeErrors: number;
```

- [ ] **Step 3: Implement it in `Player`.** In `src/engine/player.ts`:
  - Imports:
    - Remove `decodeLpcm` (keep `type PcmChunk`).
    - Add `type AudioDecodeResult`, `type AudioDecoder` and `type AudioDecoderFactory` from `./decode/audio-decoder`.
    - Add `type PlayItem` from `./bdmv/mpls-parser`.
    - Add `type PipelineAudioUnit` from `./playback/pipeline`.
    - Add `audioEntryFor` and `PLAYABLE_AUDIO` from `./playback/stream-selection`.
  - `PlayerDeps`: add `readonly createAudioDecoder: AudioDecoderFactory;`.
  - Add the constant `const MAX_AUDIO_ERRORS_IN_ROW = 50;`.
  - Add these `Session` fields:

```ts
  readonly playItems: readonly PlayItem[];
  /** 1-based STN audio stream number; null when the playlist has no playable audio. */
  audioStream: number | null;
  readonly audioDecoders: Map<number, AudioDecoder>;
  readonly audioDecoderLoads: Map<number, Promise<AudioDecoder>>;
  audioErrorsInRow: number;
  /** Audio was turned off by too many decode errors; the next seek or switch tries again. */
  audioErrorDisabled: boolean;
```

  - Replace the class field `corruptAudioUnits` with `private audioDecodeErrors = 0;` and `private audioCodec: string | null = null;`. Reset both where `corruptAudioUnits = 0` was reset.
  - In `playPlaylist`, initialise the session fields (`playItems: mpls.playItems`, `audioStream: choice.audioIndex`, empty maps, `0`, `false`). Pass `audioStream: audioActive ? choice.audioIndex : null` to the pipeline.
  - In `teardownSession`, after `s.decoder.close();`:

```ts
    for (const d of s.audioDecoders.values()) d.close();
    s.audioDecoders.clear();
```

  - Add these methods:

```ts
  /** Coding type of the selected audio stream in the play item containing `timeUs`, if playable. */
  private audioCodingTypeAt(s: Session, timeUs: number): number | null {
    const entry = audioEntryFor(s.playItems[s.timeline.locate(timeUs).item.index], s.audioStream);
    return entry && PLAYABLE_AUDIO.has(entry.codingType) ? entry.codingType : null;
  }

  /** One load per coding type per session; a decoder that arrives after teardown is closed. */
  private loadAudioDecoder(s: Session, codingType: number): Promise<AudioDecoder> {
    let load = s.audioDecoderLoads.get(codingType);
    if (!load) {
      const p = this.deps.createAudioDecoder(codingType);
      load = p;
      s.audioDecoderLoads.set(codingType, p);
      p.then(
        (d) => {
          if (this.session === s) s.audioDecoders.set(codingType, d);
          else d.close();
        },
        () => {
          if (s.audioDecoderLoads.get(codingType) === p) s.audioDecoderLoads.delete(codingType);
        },
      );
    }
    return load;
  }

  private audioUnavailable(s: Session, codingType: number, err: unknown): void {
    const codec = codingName(codingType);
    const reason = err instanceof Error ? err.message : String(err);
    this.deps.emit({ type: 'unsupported', kind: 'audio', codec, message: `${codec} audio can't be played (${reason}), so video will play without sound.` });
    s.audioActive = false;
  }
```

  - In `startAt`, directly after the `audioRecovered` block, add:

```ts
    if (s.audioErrorDisabled && this.ring) {
      s.audioActive = true;
      s.audioErrorDisabled = false;
    }
    s.audioErrorsInRow = 0;
    for (const d of s.audioDecoders.values()) d.reset();
    const audioType = s.audioActive ? this.audioCodingTypeAt(s, t) : null;
    if (audioType !== null) {
      try {
        await this.loadAudioDecoder(s, audioType);
      } catch (err) {
        if (gen !== this.seekGeneration) return;
        this.audioUnavailable(s, audioType, err);
      }
      if (gen !== this.seekGeneration) return;
    }
```

  `t` and `gen` are already defined at the top of `startAt`. Leave the rest of `startAt` (ring discard, clock, `pipeline.start`) as it is, but just before `s.pipeline.start(t);` add `s.pipeline.setAudioStream(s.audioActive ? s.audioStream : null);`.

  - Replace `onAudioUnit` with:

```ts
  private onAudioUnit(s: Session, u: PipelineAudioUnit): void {
    const writer = this.audioWriter;
    if (!s.audioActive || !writer) return;
    const decoder = s.audioDecoders.get(u.codingType);
    if (!decoder) {
      void this.loadAudioDecoder(s, u.codingType).catch(() => undefined); // a later item switched codec; ready for its next units
      return;
    }
    let result: AudioDecodeResult;
    try {
      result = decoder.decode(u); // out-of-range units still go in, to keep decoder state continuous
    } catch (err) {
      if (!(err instanceof UnsupportedCodecError)) throw err;
      this.deps.emit({ type: 'unsupported', kind: 'audio', codec: codingName(err.codingType), message: err.message });
      this.disableAudio(s, err.message, false);
      return;
    }
    if (result.failedFrames > 0) {
      this.audioDecodeErrors += result.failedFrames;
      s.audioErrorsInRow += result.failedFrames;
      if (s.audioErrorsInRow > MAX_AUDIO_ERRORS_IN_ROW) {
        s.audioErrorDisabled = true;
        this.disableAudio(s, `The ${codingName(u.codingType)} audio is too damaged to play, so playback continues without sound.`);
        return;
      }
    }
    if (result.chunks.length > 0) {
      s.audioErrorsInRow = 0;
      this.audioCodec = codingName(u.codingType);
    }
    if (!u.inRange) return;
    for (let chunk of result.chunks) {
      if (chunk.sampleRate !== OUTPUT_SAMPLE_RATE) {
        const factor = chunk.sampleRate / OUTPUT_SAMPLE_RATE;
        if (!s.decimator || s.decimator.factor !== factor) s.decimator = new Decimator(factor);
        chunk = s.decimator.process(chunk);
      }
      writer.enqueue(chunk);
    }
  }
```

  If `decoder.decode` throws an error that isn't an `UnsupportedCodecError`, it propagates to the pipeline's `failed` sink, as any other bug would.

  `let chunk of result.chunks` needs `PcmChunk` (already imported as a type). If `noUnusedLocals` complains about it, keep the import.

  - In `maybeEmitTelemetry`, change `corruptPackets` to `stats.corruptPackets + this.audioDecodeErrors` and add `audioCodec: this.audioCodec, audioDecodeErrors: this.audioDecodeErrors,`.

- [ ] **Step 4: Wire up the worker.** In `src/engine/worker.ts`:

```ts
import audioWasmUrl from '../wasm/audio/audio.wasm?url';
import { createAudioDecoderFactory } from './decode/audio-decoder';
import { loadAudioWasm } from './decode/wasm-audio';
```

and in the `Player` deps add `createAudioDecoder: createAudioDecoderFactory(() => loadAudioWasm(fetch(audioWasmUrl))),`.

- [ ] **Step 5: Run the tests and check that they pass.**

Run: `npx vitest run src/engine && npm run typecheck && npm run build`
Expected: PASS. The build output includes a hashed `audio-*.wasm` asset (`ls dist/assets | grep wasm`).

- [ ] **Step 6: Commit.**

```bash
git add src/engine/player.ts src/engine/player.test.ts src/engine/worker.ts src/engine/protocol.ts
git commit -m "feat(engine): decode audio through the decoder factory with error limits and telemetry"
```

---

### Task 8: Track list and `selectAudio` in the engine

**Files:**
- Create: `src/engine/playback/tracks.ts`
- Modify: `src/engine/protocol.ts`, `src/engine/player.ts`
- Test: `src/engine/playback/tracks.test.ts`, `src/engine/player.test.ts`

**Interfaces:**
- Consumes: the Task 7 session fields and methods; `PLAYABLE_AUDIO`.
- Produces:
  ```ts
  // protocol.ts
  export interface AudioTrack { readonly index: number; readonly codec: string; readonly language: string; readonly channels: string; readonly playable: boolean }
  // EngineEvent: | { readonly type: 'tracks'; readonly audio: readonly AudioTrack[]; readonly selectedAudio: number | null }
  // EngineCommand: | { readonly type: 'selectAudio'; readonly index: number }
  // tracks.ts
  export function channelsLabel(format: number): string;
  export function audioTracks(stn: StnTable, playable?: ReadonlySet<number>): AudioTrack[];
  ```

- [ ] **Step 1: Write the failing tests.** Create `src/engine/playback/tracks.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import type { StreamEntry } from '../bdmv/mpls-parser';
import { CodingType } from '../bdmv/stream-types';
import { audioTracks, channelsLabel } from './tracks';

const entry = (codingType: number, format: number, lang: string, subPath = false): StreamEntry => ({ pid: 0x1100, codingType, format, rate: 1, lang, subPath });

describe('audioTracks', () => {
  it('lists every STN audio entry with its 1-based number and playability', () => {
    const tracks = audioTracks({
      video: [],
      audio: [entry(CodingType.LPCM, 3, 'jpn'), entry(CodingType.DTSHD_MASTER, 6, 'eng'), entry(CodingType.DTSHD_SECONDARY, 3, 'eng'), entry(CodingType.AC3, 6, 'fra', true)],
      pg: [],
      ig: [],
    });
    expect(tracks).toEqual([
      { index: 1, codec: 'LPCM', language: 'jpn', channels: 'stereo', playable: true },
      { index: 2, codec: 'DTS-HD Master Audio', language: 'eng', channels: 'multichannel', playable: true },
      { index: 3, codec: 'DTS-HD (secondary)', language: 'eng', channels: 'stereo', playable: false },
      { index: 4, codec: 'Dolby Digital (AC-3)', language: 'fra', channels: 'multichannel', playable: false },
    ]);
  });

  it('labels the STN audio_format values', () => {
    expect([1, 3, 6, 12, 0].map(channelsLabel)).toEqual(['mono', 'stereo', 'multichannel', 'multichannel', '']);
  });
});
```

In `src/engine/player.test.ts`, add:

```ts
  const twoTracks = (second: number) => [lpcmStream(0x1100, 4, { lang: 'jpn' }), dummyAudioStream(0x1101, second, 4, { lang: 'eng' })];
  const tracksEvents = (h: Harness) => h.events.flatMap((e) => (e.type === 'tracks' ? [e] : []));

  it('lists the audio tracks after the chapters and selects the first playable one', async () => {
    const h = await harness(undefined, { audioStreams: twoTracks(CodingType.AC3), createAudioDecoder: fakeAudioFactory() });
    await h.player.handle({ type: 'playPlaylist', playlistId: '00000' });
    const types = h.events.map((e) => e.type);
    expect(types.indexOf('tracks')).toBeGreaterThan(types.indexOf('chapters'));
    expect(tracksEvents(h).at(-1)).toEqual({
      type: 'tracks',
      selectedAudio: 1,
      audio: [
        { index: 1, codec: 'LPCM', language: 'jpn', channels: 'stereo', playable: true },
        { index: 2, codec: 'Dolby Digital (AC-3)', language: 'eng', channels: 'stereo', playable: true },
      ],
    });
  });

  it('switches the audio track at the current time and keeps playing', async () => {
    const log: FakeAudioLog = { decoded: [], resets: 0, failNext: 0 };
    const h = await harness(undefined, { audioStreams: twoTracks(CodingType.AC3), createAudioDecoder: fakeAudioFactory(log) });
    await h.player.handle({ type: 'playPlaylist', playlistId: '00000' });
    await untilPlaying(h);
    await h.play(1500);
    const at = lastTelemetry(h)?.clockUs ?? 0;
    await h.player.handle({ type: 'selectAudio', index: 2 });
    expect(tracksEvents(h).at(-1)?.selectedAudio).toBe(2);
    await untilPlaying(h);
    await h.play(800);
    expect(Math.min(...log.decoded)).toBeGreaterThan(at - 1_100_000); // read from the keyframe before the switch point
    expect(lastTelemetry(h)).toMatchObject({ clockMode: 'audio', audioCodec: 'Dolby Digital (AC-3)' });
  });

  it('switching while paused stays paused at the same time', async () => {
    const h = await harness(undefined, { audioStreams: twoTracks(CodingType.AC3), createAudioDecoder: fakeAudioFactory() });
    await h.player.handle({ type: 'playPlaylist', playlistId: '00000' });
    await untilPlaying(h);
    await h.play(1000);
    await h.player.handle({ type: 'pause' });
    const pausedAt = lastTelemetry(h)?.clockUs ?? 0;
    await h.player.handle({ type: 'selectAudio', index: 2 });
    await h.play(300);
    expect(lastState(h)).toBe('paused');
    const lastTime = h.events.flatMap((e) => (e.type === 'time' ? [e.timeUs] : [])).at(-1) ?? -1;
    expect(Math.abs(lastTime - pausedAt)).toBeLessThan(300_000);
  });

  it('ignores unplayable, unknown and already-selected tracks', async () => {
    const h = await harness(undefined, { audioStreams: twoTracks(CodingType.EAC3_SECONDARY), createAudioDecoder: fakeAudioFactory() });
    await h.player.handle({ type: 'playPlaylist', playlistId: '00000' });
    await untilPlaying(h);
    const before = h.events.length;
    for (const index of [2, 9, 1]) await h.player.handle({ type: 'selectAudio', index });
    expect(h.events.slice(before).filter((e) => e.type === 'tracks' || (e.type === 'state' && e.state === 'buffering'))).toEqual([]);
  });

  it('the last of two quick switches wins while a decoder is still loading', async () => {
    let open: () => void = () => undefined;
    const gate = new Promise<void>((r) => (open = r));
    const log: FakeAudioLog = { decoded: [], resets: 0, failNext: 0 };
    const h = await harness(undefined, { audioStreams: twoTracks(CodingType.AC3), createAudioDecoder: fakeAudioFactory(log, gate) });
    await h.player.handle({ type: 'playPlaylist', playlistId: '00000' });
    await untilPlaying(h);
    const toAc3 = h.player.handle({ type: 'selectAudio', index: 2 });
    const back = h.player.handle({ type: 'selectAudio', index: 1 });
    open();
    await Promise.all([toAc3, back]);
    await untilPlaying(h);
    log.decoded.length = 0;
    await h.play(800);
    expect(tracksEvents(h).at(-1)?.selectedAudio).toBe(1);
    expect(log.decoded).toEqual([]);
    expect(lastTelemetry(h)).toMatchObject({ clockMode: 'audio', audioCodec: 'LPCM' });
  });

  it('brings sound back by switching to a playable track after a decoder failed to load', async () => {
    const h = await harness(undefined, { audioStreams: [dummyAudioStream(0x1100, CodingType.AC3, 4), lpcmStream(0x1101, 4)] }); // noWasmFactory
    await h.player.handle({ type: 'playPlaylist', playlistId: '00000' });
    await untilPlaying(h);
    await h.play(500);
    expect(lastTelemetry(h)?.clockMode).toBe('wall');
    await h.player.handle({ type: 'selectAudio', index: 2 });
    await untilPlaying(h);
    await h.play(800);
    expect(lastTelemetry(h)).toMatchObject({ clockMode: 'audio', audioCodec: 'LPCM' });
  });
```

Import `lpcmStream` and `dummyAudioStream` from the helpers.

Run: `npx vitest run src/engine/playback/tracks.test.ts src/engine/player.test.ts`
Expected: FAIL (no `tracks.ts`, no `tracks` event, `selectAudio` isn't a command).

- [ ] **Step 2: Add the protocol types.** In `src/engine/protocol.ts`, add the `AudioTrack` interface (with doc comments: `index` is the 1-based STN position; `language` is the ISO 639-2 code from the STN, or '' if absent; `channels` is one of 'mono', 'stereo', 'multichannel' or ''). Add the `tracks` event and the `selectAudio` command exactly as in **Interfaces**.

- [ ] **Step 3: Implement `tracks.ts`.**

```ts
import type { StnTable } from '../bdmv/mpls-parser';
import { codingName } from '../bdmv/stream-types';
import type { AudioTrack } from '../protocol';
import { PLAYABLE_AUDIO } from './stream-selection';

/** STN audio_format (libbluray mpls_data.h): 1 mono, 3 stereo, 6 multichannel, 12 stereo + multichannel. */
export function channelsLabel(format: number): string {
  switch (format) {
    case 1:
      return 'mono';
    case 3:
      return 'stereo';
    case 6:
    case 12:
      return 'multichannel';
    default:
      return '';
  }
}

export function audioTracks(stn: StnTable, playable: ReadonlySet<number> = PLAYABLE_AUDIO): AudioTrack[] {
  return stn.audio.map((s, i) => ({
    index: i + 1,
    codec: codingName(s.codingType),
    language: s.lang,
    channels: channelsLabel(s.format),
    playable: !s.subPath && playable.has(s.codingType),
  }));
}
```

- [ ] **Step 4: Implement it in `Player`.**
  - Add `readonly tracks: readonly AudioTrack[];` to `Session`. In `playPlaylist`, set it to `audioTracks(mpls.playItems[0].stn)`.
  - In `playPlaylist`, right after the `chapters` emit, add `this.emitTracks(session);`.
  - Add `case 'selectAudio': await this.selectAudio(cmd.index); break;` to `run()`.
  - Add these methods:

```ts
  private emitTracks(s: Session): void {
    this.deps.emit({ type: 'tracks', audio: s.tracks, selectedAudio: s.audioStream });
  }

  /** Switching is a re-seek to the current time with the new stream (a brief video refill). */
  private async selectAudio(index: number): Promise<void> {
    const s = this.session;
    if (!s || index === s.audioStream || this.state === 'error') return;
    if (!s.tracks.find((t) => t.index === index)?.playable) return;
    s.audioStream = index;
    s.audioActive = this.ring !== null;
    s.audioErrorDisabled = false;
    s.audioStalledBeat = null;
    this.emitTracks(s);
    await this.startAt(this.clock.nowUs(), this.wantPlaying);
  }
```

  Import `audioTracks` from `./playback/tracks` and `type AudioTrack` from `./protocol`.

- [ ] **Step 5: Run the tests and check that they pass.**

Run: `npx vitest run src/engine && npm run typecheck`
Expected: PASS. If "the last of two quick switches wins" fails because AC-3 units were decoded, check that `startAt` returns early when `gen !== this.seekGeneration` after awaiting the load, and that `setAudioStream` is called right before `pipeline.start`, so the second switch's stream is the one being read.

- [ ] **Step 6: Commit.**

```bash
git add src/engine/playback/tracks.ts src/engine/playback/tracks.test.ts src/engine/protocol.ts src/engine/player.ts src/engine/player.test.ts
git commit -m "feat(engine): report audio tracks and switch between them"
```

---

### Task 9: Controller and UI: audio menu, `A` key, language names

**Files:**
- Create: `src/ui/language.ts`, `src/ui/AudioMenu.tsx`
- Modify: `src/player/player-controller.ts`, `src/ui/ControlBar.tsx`, `src/ui/PlayerScreen.tsx`, `src/ui/keyboard.ts`, `src/ui/styles.css`
- Test: `src/ui/language.test.ts`, `src/ui/keyboard.test.ts`, `src/player/player-controller.test.ts`

**Interfaces:**
- Consumes: `AudioTrack` and the `tracks` and `selectAudio` protocol items (Task 8).
- Produces:
  ```ts
  // language.ts
  export function languageName(code: string): string;   // '' for empty/'und'
  export function trackLabel(track: AudioTrack): string; // "2. English · DTS-HD Master Audio (multichannel)"
  // player-controller.ts
  PlayerSnapshot.audioTracks: readonly AudioTrack[]; PlayerSnapshot.selectedAudio: number | null;
  PlayerController.selectAudio(index: number): void; PlayerController.cycleAudio(): void;
  // keyboard.ts
  KeyAction | { readonly type: 'cycleAudio' }
  ```

- [ ] **Step 1: Write the failing tests.** Create `src/ui/language.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { languageName, trackLabel } from './language';

describe('languageName', () => {
  it('names ISO 639-2 codes, including bibliographic variants', () => {
    expect(['jpn', 'eng', 'fre', 'fra', 'ger', 'chi'].map(languageName)).toEqual(['Japanese', 'English', 'French', 'French', 'German', 'Chinese']);
  });

  it('returns empty for missing or undetermined, and the raw code when unknown', () => {
    expect([languageName(''), languageName('und'), languageName('qqq'), languageName('1x!')]).toEqual(['', '', 'qqq', '1x!']);
  });
});

describe('trackLabel', () => {
  it('reads number, language, codec and channels', () => {
    expect(trackLabel({ index: 2, codec: 'DTS-HD Master Audio', language: 'eng', channels: 'multichannel', playable: true })).toBe('2. English · DTS-HD Master Audio (multichannel)');
    expect(trackLabel({ index: 1, codec: 'LPCM', language: '', channels: '', playable: true })).toBe('1. Unknown language · LPCM');
  });
});
```

`Intl.DisplayNames.of('qqq')` returns `'qqq'`, and an invalid tag such as `'1x!'` throws a `RangeError`, which the helper catches.

Add to `src/ui/keyboard.test.ts`:

```ts
  it('cycles audio tracks with A', () => {
    expect(keyToAction('a')).toEqual({ type: 'cycleAudio' });
    expect(keyToAction('A')).toEqual({ type: 'cycleAudio' });
  });
```

Add to `src/player/player-controller.test.ts` (in a new `describe('audio tracks', …)`):

```ts
  const tracks = [
    { index: 1, codec: 'LPCM', language: 'jpn', channels: 'stereo', playable: true },
    { index: 2, codec: 'DTS-HD (secondary)', language: 'eng', channels: 'stereo', playable: false },
    { index: 3, codec: 'Dolby Digital (AC-3)', language: 'eng', channels: 'multichannel', playable: true },
  ];

  it('stores tracks and clears them with the playlist', () => {
    let s = reduceEvent(INITIAL_SNAPSHOT, { type: 'tracks', audio: tracks, selectedAudio: 1 });
    expect(s).toMatchObject({ audioTracks: tracks, selectedAudio: 1 });
    s = reduceEvent(s, { type: 'playlistCleared' });
    expect(s).toMatchObject({ audioTracks: [], selectedAudio: null });
  });

  it('selects a playable track with a confirmation notice and ignores the rest', () => {
    const worker = new FakeWorker();
    const c = new PlayerController(worker, new FakeAudio());
    worker.emit({ type: 'tracks', audio: tracks, selectedAudio: 1 });
    worker.posted.length = 0;
    c.selectAudio(2);
    c.selectAudio(1);
    c.selectAudio(3);
    expect(worker.posted).toEqual([{ type: 'selectAudio', index: 3 }]);
    expect(c.getSnapshot().notices).toContainEqual({ code: 'audio-track', message: 'Audio: 3. English · Dolby Digital (AC-3) (multichannel)' });
  });

  it('cycles through playable tracks and wraps around', () => {
    const worker = new FakeWorker();
    const c = new PlayerController(worker, new FakeAudio());
    worker.emit({ type: 'tracks', audio: tracks, selectedAudio: 3 });
    worker.posted.length = 0;
    c.cycleAudio();
    expect(worker.posted).toEqual([{ type: 'selectAudio', index: 1 }]);
  });
```

Run: `npx vitest run src/ui src/player`
Expected: FAIL.

- [ ] **Step 2: Implement `language.ts`.**

```ts
import type { AudioTrack } from '../engine/protocol';

/** ISO 639-2 codes (B and T forms) that differ from the two-letter tags Intl expects. */
const TWO_LETTER: Readonly<Record<string, string>> = {
  ara: 'ar', cat: 'ca', ces: 'cs', cze: 'cs', chi: 'zh', zho: 'zh', dan: 'da', deu: 'de', ger: 'de', dut: 'nl', nld: 'nl', ell: 'el', gre: 'el',
  eng: 'en', fin: 'fi', fra: 'fr', fre: 'fr', heb: 'he', hin: 'hi', hun: 'hu', ice: 'is', isl: 'is', ind: 'id', ita: 'it', jpn: 'ja', kor: 'ko',
  may: 'ms', msa: 'ms', nor: 'no', pol: 'pl', por: 'pt', ron: 'ro', rum: 'ro', rus: 'ru', spa: 'es', swe: 'sv', tha: 'th', tur: 'tr', ukr: 'uk',
  vie: 'vi',
};

let names: Intl.DisplayNames | null = null;

export function languageName(code: string): string {
  const c = code.trim().toLowerCase();
  if (c === '' || c === 'und') return '';
  try {
    names ??= new Intl.DisplayNames(['en'], { type: 'language' });
    return names.of(TWO_LETTER[c] ?? c) ?? code;
  } catch {
    return code;
  }
}

export function trackLabel(track: AudioTrack): string {
  const language = languageName(track.language) || 'Unknown language';
  return `${track.index}. ${language} · ${track.codec}${track.channels ? ` (${track.channels})` : ''}`;
}
```

- [ ] **Step 3: Implement the controller changes.** In `src/player/player-controller.ts`:
  - Import `type AudioTrack` from `../engine/protocol` and `trackLabel` from `../ui/language`.
  - Add `readonly audioTracks: readonly AudioTrack[]; readonly selectedAudio: number | null;` to `PlayerSnapshot`, and `audioTracks: [], selectedAudio: null,` to `INITIAL_SNAPSHOT`.
  - In `reduceEvent`:
    - add `case 'tracks': return { ...s, audioTracks: e.audio, selectedAudio: e.selectedAudio };`;
    - add `audioTracks: [], selectedAudio: null` to the objects returned for `titles` and `playlistCleared`.
  - In `playPlaylist`, add `|| code === 'audio-track'` to `playlistScoped`.
  - Add these methods:

```ts
  selectAudio(index: number): void {
    const track = this.snapshot.audioTracks.find((t) => t.index === index);
    if (!track?.playable || index === this.snapshot.selectedAudio) return;
    this.post({ type: 'selectAudio', index });
    this.update(withNotice(this.snapshot, { code: 'audio-track', message: `Audio: ${trackLabel(track)}` }));
  }

  /** The A key: the next playable track, wrapping around. */
  cycleAudio(): void {
    const playable = this.snapshot.audioTracks.filter((t) => t.playable);
    if (playable.length < 2) return;
    const at = playable.findIndex((t) => t.index === this.snapshot.selectedAudio);
    this.selectAudio(playable[(at + 1) % playable.length].index);
  }
```

- [ ] **Step 4: Add the keyboard binding.** In `src/ui/keyboard.ts`:
  - add `| { readonly type: 'cycleAudio' }` to `KeyAction`;
  - add `case 'a': case 'A': return { type: 'cycleAudio' };`;
  - update the doc comment to mention A (audio track).

- [ ] **Step 5: Build the menu.** Create `src/ui/AudioMenu.tsx`:

```tsx
import { useEffect, useRef, useState, type ReactElement } from 'react';
import type { AudioTrack } from '../engine/protocol';
import { trackLabel } from './language';

interface AudioMenuProps {
  readonly tracks: readonly AudioTrack[];
  readonly selected: number | null;
  onSelect(index: number): void;
  /** While open, the player keeps its controls up. */
  onOpenChange(open: boolean): void;
}

export function AudioMenu({ tracks, selected, onSelect, onOpenChange }: AudioMenuProps): ReactElement | null {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const shown = tracks.length > 1;

  useEffect(() => {
    if (!shown) setOpen(false);
  }, [shown]);

  useEffect(() => onOpenChange(open), [open, onOpenChange]);

  useEffect(() => {
    if (!open) return;
    const outside = (e: PointerEvent): void => {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false);
    };
    const escape = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') setOpen(false);
    };
    window.addEventListener('pointerdown', outside);
    window.addEventListener('keydown', escape);
    return () => {
      window.removeEventListener('pointerdown', outside);
      window.removeEventListener('keydown', escape);
    };
  }, [open]);

  if (!shown) return null;
  return (
    <div className="audio-menu" ref={rootRef}>
      <button type="button" aria-haspopup="menu" aria-expanded={open} data-testid="audio-menu" onClick={() => setOpen((o) => !o)}>
        Audio
      </button>
      {open && (
        <ul role="menu" className="audio-menu-list">
          {tracks.map((t) => (
            <li key={t.index} role="none">
              <button
                type="button"
                role="menuitemradio"
                aria-checked={t.index === selected}
                disabled={!t.playable}
                title={t.playable ? undefined : `${t.codec} isn't supported`}
                data-testid={`audio-track-${t.index}`}
                data-codec={t.codec}
                onClick={() => {
                  setOpen(false);
                  onSelect(t.index);
                }}
              >
                {trackLabel(t)}
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
```

  In `src/ui/ControlBar.tsx`:
  - add `onMenuOpenChange(open: boolean): void;` to `ControlBarProps` and destructure it;
  - render `<AudioMenu tracks={snapshot.audioTracks} selected={snapshot.selectedAudio} onSelect={(i) => controller.selectAudio(i)} onOpenChange={onMenuOpenChange} />` right before the `Playlists` button.

  In `src/ui/PlayerScreen.tsx`:
  - add `const [menuOpen, setMenuOpen] = useState(false);`;
  - pass `onMenuOpenChange={setMenuOpen}` to `ControlBar`;
  - change the hide effect's guard to `if (!playing || pressed || menuOpen) return;` and add `menuOpen` to its dependency list;
  - add `case 'cycleAudio': controller.cycleAudio(); break;` to the key switch;
  - add this effect, which auto-dismisses the confirmation notice:

```tsx
  const trackNotice = snapshot.notices.find((n) => n.code === 'audio-track')?.message;
  useEffect(() => {
    if (!trackNotice) return;
    const timer = window.setTimeout(() => controller.dismissNotice('audio-track'), 3000);
    return () => window.clearTimeout(timer);
  }, [controller, trackNotice]);
```

  Append to `src/ui/styles.css`:

```css
.audio-menu { position: relative; }
.audio-menu-list { position: absolute; bottom: calc(100% + 8px); right: 0; margin: 0; padding: 4px; list-style: none; background: rgba(30, 30, 36, 0.96); border-radius: 8px; min-width: 280px; }
.audio-menu-list button { display: block; width: 100%; text-align: left; padding: 6px 10px; white-space: nowrap; }
.audio-menu-list button[aria-checked='true']::before { content: '✓ '; }
.audio-menu-list button:disabled { opacity: 0.45; cursor: not-allowed; }
```

- [ ] **Step 6: Run the tests and check that they pass.**

Run: `npx vitest run && npm run typecheck`
Expected: PASS.

- [ ] **Step 7: Commit.**

```bash
git add src/ui src/player
git commit -m "feat(ui): audio track menu, A to cycle tracks, language names"
```

---

### Task 10: The `disc3` synthetic disc and the audio E2E

**Files:**
- Create: `scripts/x264.ts`, `scripts/make-audio-disc.ts`, `fixtures/synthetic/disc3/**`
- Modify: `scripts/make-fixture-disc.ts` (use `scripts/x264.ts`), `package.json` (`fixture:synthetic`)
- Create: `tests/e2e/telemetry.ts`, `tests/e2e/audio.spec.ts`
- Modify: `tests/e2e/playback.spec.ts` (import the shared helpers)

**Interfaces:**
- Consumes: `buildSyntheticDisc`, `SyntheticAudioStream`, `lpcmPayload`, `CLIP_START_PTS` (helpers); `AudioFramer` (Task 2); the UI test ids from Task 9 (`audio-menu`, `audio-track-N`, `data-codec`); `Telemetry.audioCodec` and `audioDecodeErrors` (Task 7).
- Produces:
  ```ts
  // scripts/x264.ts
  export function encodeTestVideo(frames: number): Uint8Array[];  // access units, IDR every 24, SPS/PPS at each IDR
  // tests/e2e/telemetry.ts
  export interface TelemetrySample { clockUs: number; clockMode: string; avOffsetMeanUs: number | null; avOffsetMaxAbsUs: number | null; framesInWindow: number; framesPresented?: number; decoderErrors?: number; openGopStarts?: number; leadingPicturesSkipped?: number; audioUnderruns?: number; audioCodec?: string | null; audioDecodeErrors?: number }
  export function telemetry(page: Page): Promise<TelemetrySample | null>;
  export function collectWindows(page: Page, untilUs: number, deadlineMs?: number): Promise<TelemetrySample[]>;
  export function expectInSync(windows: TelemetrySample[]): void;
  export const SYNC_TOLERANCE_US: number; export const MAX_ABS_TOLERANCE_US: number;
  ```

- [ ] **Step 1: Move the shared E2E helpers.** Create `tests/e2e/telemetry.ts` containing the `SYNC_SCALE` check, `SYNC_TOLERANCE_US`, `MAX_ABS_TOLERANCE_US`, `TelemetrySample` (with the extra optional fields above), `telemetry`, `collectWindows` and `expectInSync`, moved unchanged from `tests/e2e/playback.spec.ts` and exported. Delete them from `playback.spec.ts` and import them instead.

Run: `npm run test:e2e -- playback`
Expected: PASS, exactly as before.

- [ ] **Step 2: Move the x264 helper.** Create `scripts/x264.ts`. Move the `execFileSync('ffmpeg', …)` H.264 call and `splitAccessUnits` out of `scripts/make-fixture-disc.ts` into:

```ts
import { execFileSync } from 'node:child_process';

/** IDR every second at 24 fps, no B-frames, AUD before every access unit, SPS/PPS repeated at every IDR. */
export function encodeTestVideo(frames: number): Uint8Array[] {
  const h264 = execFileSync('ffmpeg', [
    '-v', 'error', '-f', 'lavfi', '-i', 'testsrc2=size=640x360:rate=24', '-frames:v', String(frames),
    '-c:v', 'libx264', '-profile:v', 'high', '-level', '4.1', '-pix_fmt', 'yuv420p',
    '-x264-params', 'keyint=24:min-keyint=24:scenecut=0:bframes=0:aud=1:repeat-headers=1', '-f', 'h264', '-',
  ], { maxBuffer: 1 << 30 });
  const aus = splitAccessUnits(new Uint8Array(h264));
  if (aus.length !== frames) throw new Error(`expected ${frames} access units, got ${aus.length}`);
  return aus;
}
```

`splitAccessUnits` moves along with it, unchanged. Use `encodeTestVideo(framesPerClip * 2)` in `make-fixture-disc.ts`.

Run: `npx tsx scripts/make-fixture-disc.ts fixtures/synthetic/disc1 && git status --short fixtures/synthetic/disc1`
Expected: no changes.

- [ ] **Step 3: Write `make-audio-disc.ts`.**

```ts
import { execFileSync } from 'node:child_process';
import { CodingType } from '../src/engine/bdmv/stream-types';
import { AudioFramer } from '../src/engine/decode/audio-frames';
import { CLIP_START_PTS, buildSyntheticDisc, lpcmPayload, type SyntheticAudioStream } from '../tests/helpers/synthetic-disc';
import { writeFixture } from './fixture-dir';
import { encodeTestVideo } from './x264';

const outDir = process.argv[2];
if (!outDir) {
  console.error('usage: tsx scripts/make-audio-disc.ts <outDir>');
  process.exit(1);
}
const SECONDS = 12;
const TICKS_PER_SAMPLE = 90_000 / 48_000;

function encode(codec: string[], layout: 'stereo' | '5.1'): Uint8Array {
  return new Uint8Array(execFileSync('ffmpeg', [
    '-v', 'error', '-f', 'lavfi', '-i', `sine=frequency=440:sample_rate=48000:duration=${SECONDS}`,
    '-af', `volume=0.25,pan=${layout === 'stereo' ? 'stereo|FL=c0|FR=c0' : '5.1|FL=c0|FR=c0'}`, ...codec, '-',
  ], { maxBuffer: 1 << 28 }));
}

/** One codec frame per PES, timed by sample count from the clip start. */
function framed(bytes: Uint8Array, kind: 'ac3' | 'dts', codingType: number, ext?: number): Array<{ pts: number; payload: Uint8Array; streamIdExtension?: number }> {
  const frames = new AudioFramer(kind, codingType).push(bytes, 0);
  let samples = 0;
  return frames.map((f) => {
    const unit = { pts: CLIP_START_PTS + Math.round(samples * TICKS_PER_SAMPLE), payload: f.data, streamIdExtension: ext };
    samples += f.samples;
    return unit;
  });
}

/** TrueHD access units (length in the first 12 bits, in 16-bit words), 24 per PES. */
function truehdUnits(bytes: Uint8Array): Array<{ pts: number; payload: Uint8Array; streamIdExtension: number }> {
  const aus: Uint8Array[] = [];
  for (let at = 0; at + 2 <= bytes.length; ) {
    const len = (((bytes[at] & 0x0f) << 8) | bytes[at + 1]) * 2;
    if (len === 0) break;
    aus.push(bytes.subarray(at, at + len));
    at += len;
  }
  const out = [];
  for (let i = 0; i < aus.length; i += 24) {
    const group = aus.slice(i, i + 24);
    const payload = new Uint8Array(group.reduce((n, a) => n + a.length, 0));
    let o = 0;
    for (const a of group) {
      payload.set(a, o);
      o += a.length;
    }
    out.push({ pts: CLIP_START_PTS + Math.round(i * 40 * TICKS_PER_SAMPLE), payload, streamIdExtension: 0x72 });
  }
  return out;
}

const ac3 = encode(['-c:a', 'ac3', '-b:a', '448k', '-f', 'ac3'], '5.1');
const core = encode(['-c:a', 'ac3', '-b:a', '192k', '-f', 'ac3'], 'stereo');
const mlp = encode(['-c:a', 'truehd', '-strict', '-2', '-f', 'truehd'], 'stereo');
const dts = encode(['-c:a', 'dca', '-strict', '-2', '-b:a', '768k', '-f', 'dts'], '5.1');

const lpcmCount = Math.ceil((SECONDS * 90_000) / 450);
const streams: SyntheticAudioStream[] = [
  { pid: 0x1100, codingType: CodingType.LPCM, lang: 'jpn', format: 3, units: Array.from({ length: lpcmCount }, (_, j) => ({ pts: CLIP_START_PTS + j * 450, payload: lpcmPayload(240, j * 240) })) },
  { pid: 0x1101, codingType: CodingType.AC3, lang: 'eng', format: 6, units: framed(ac3, 'ac3', CodingType.AC3) },
  {
    pid: 0x1102,
    codingType: CodingType.TRUEHD,
    lang: 'eng',
    format: 3,
    units: [...framed(core, 'ac3', CodingType.AC3, 0x76), ...truehdUnits(mlp)].sort((a, b) => a.pts - b.pts || (a.streamIdExtension === 0x76 ? -1 : 1)),
  },
  { pid: 0x1103, codingType: CodingType.DTS, lang: 'fra', format: 6, units: framed(dts, 'dts', CodingType.DTS) },
];

const frames = SECONDS * 24;
const files = buildSyntheticDisc({
  clips: [{ clipId: '00001', videoAus: encodeTestVideo(frames), keyIndices: Array.from({ length: SECONDS }, (_, i) => i * 24), startPts: CLIP_START_PTS, audioStreams: streams }],
  playlists: [{ id: '00000', clipIds: ['00001'], chapterEverySeconds: 4 }],
});
writeFixture(outDir, files);
```

  Append `&& tsx scripts/make-audio-disc.ts fixtures/synthetic/disc3` to `fixture:synthetic`.

Run: `npx tsx scripts/make-audio-disc.ts fixtures/synthetic/disc3 && du -sh fixtures/synthetic/disc3`
Expected: under 10 MB. If ffmpeg's experimental `truehd` encoder refuses stereo at 48 kHz, use `-ac 6` with the 5.1 pan and set the stream's `format: 6`. The MLP payload is never decoded; it only has to be realistic.

- [ ] **Step 4: Write the E2E.** Create `tests/e2e/audio.spec.ts`:

```ts
import { expect, test, type Page } from '@playwright/test';
import { collectWindows, expectInSync, telemetry } from './telemetry';

const DISC = 'fixtures/synthetic/disc3';
const TRACKS = [
  { index: 1, codec: 'LPCM' },
  { index: 2, codec: 'Dolby Digital (AC-3)' },
  { index: 3, codec: 'Dolby TrueHD' },
  { index: 4, codec: 'DTS' },
];

async function seekTo(page: Page, fraction: number): Promise<void> {
  await page.getByTestId('player').hover();
  const bar = await page.getByTestId('seek').boundingBox();
  if (!bar) throw new Error('seek bar not found');
  await page.mouse.click(bar.x + bar.width * fraction, bar.y + bar.height / 2);
}

test('plays every audio track of the disc in sync', async ({ page }) => {
  test.setTimeout(120_000);
  await page.goto('/?telemetry=1');
  await page.getByTestId('folder-input').setInputFiles(DISC);
  await page.getByTestId('playlist-00000').click();
  await expect(page.getByTestId('player')).toHaveAttribute('data-state', 'playing', { timeout: 10_000 });

  for (const track of TRACKS) {
    await page.getByTestId('player').hover();
    if (track.index !== 1) {
      await page.getByTestId('audio-menu').click();
      await page.getByTestId(`audio-track-${track.index}`).click();
    }
    await seekTo(page, 1 / 12);
    await expect(page.getByTestId('player')).toHaveAttribute('data-state', 'playing', { timeout: 10_000 });
    await expect.poll(async () => (await telemetry(page))?.audioCodec, { timeout: 10_000 }).toBe(track.codec);
    const start = (await telemetry(page))?.clockUs ?? 0;
    const underrunsBefore = (await telemetry(page))?.audioUnderruns ?? 0;
    await page.waitForTimeout(500); // let the switch settle before measuring
    const windows = await collectWindows(page, start + 3_000_000);
    expect(windows.length).toBeGreaterThan(3);
    expectInSync(windows.slice(1));
    const t = await telemetry(page);
    expect(t?.clockMode).toBe('audio');
    expect(t?.audioDecodeErrors).toBe(0);
    expect(t?.audioUnderruns).toBe(underrunsBefore);
  }
});

test('A cycles the audio track and shows which one is playing', async ({ page }) => {
  await page.goto('/?telemetry=1');
  await page.getByTestId('folder-input').setInputFiles(DISC);
  await page.getByTestId('playlist-00000').click();
  await expect(page.getByTestId('player')).toHaveAttribute('data-state', 'playing', { timeout: 10_000 });
  await page.keyboard.press('a');
  await expect(page.getByRole('status').filter({ hasText: 'Audio: 2. English · Dolby Digital (AC-3) (multichannel)' })).toBeVisible();
  await expect.poll(async () => (await telemetry(page))?.audioCodec, { timeout: 10_000 }).toBe('Dolby Digital (AC-3)');
});
```

`audioUnderruns` is reported by the ring and counts across seeks. If the re-seek itself adds an underrun (the ring is discarded while the worklet runs), take the "before" value after the 500 ms settle wait instead, and write down why in a comment.

- [ ] **Step 5: Run the E2E suite.**

Run: `npm run test:e2e`
Expected: every spec passes, including both new tests. Each track's line in the output shows its `sync stats`. If a codec is consistently out of sync by a fixed offset, check the framer's PTS for the first frame after a seek (Review Focus 2) before touching the tolerances.

- [ ] **Step 6: Commit.**

```bash
git add scripts/x264.ts scripts/make-fixture-disc.ts scripts/make-audio-disc.ts fixtures/synthetic/disc3 package.json tests/e2e
git commit -m "test(e2e): play LPCM, AC-3, TrueHD core and DTS tracks from a synthetic disc"
```

---

### Task 11: Real-disc audio checks

**Files:**
- Modify: `tests/local/real-discs.test.ts`, `tests/e2e/local-discs.spec.ts`

**Interfaces:**
- Consumes: `createAudioDecoderFactory` (Task 5); `loadNodeAudioWasm` (Task 3); `audioTracks` (Task 8); `M2tsReader`; the E2E helpers (Task 10).

- [ ] **Step 1: Decode every playable track of each local disc in Node.** In `tests/local/real-discs.test.ts`, add a second `it` per disc inside the same loop:

```ts
    it(`decodes the first seconds of every playable audio track on ${basename(dir)}`, async () => {
      const source = new FileSource(normalizeDiscPaths(await entriesOf(dir)));
      const disc = await openDisc(source);
      const main = disc.summaries.find((s) => s.playable);
      const mpls = main && disc.playlists.get(main.id);
      if (!mpls) throw new Error('no playable playlist');
      const item = mpls.playItems[0];
      const factory = createAudioDecoderFactory(loadNodeAudioWasm);
      for (const track of audioTracks(item.stn).filter((t) => t.playable)) {
        const entry = item.stn.audio[track.index - 1];
        const reader = new M2tsReader({ source, path: streamPath(item.clipId), startSpn: 0, pids: new Set([entry.pid]), chunkPackets: 6144 * 4 });
        const decoder = await factory(entry.codingType);
        let frames = 0;
        let failed = 0;
        for (let n = 0; n < 4; n++) {
          for (const pes of (await reader.next()) ?? []) {
            const r = decoder.decode({ data: pes.payload, ptsUs: ((pes.pts ?? 0) / 90_000) * 1e6, streamIdExtension: pes.streamIdExtension });
            failed += r.failedFrames;
            for (const c of r.chunks) frames += c.frames;
          }
        }
        decoder.close();
        console.info(`${basename(dir)}: audio ${track.index} ${track.codec} ${track.language}: ${frames} frames, ${failed} failed`);
        expect(frames, `${track.codec} produced audio`).toBeGreaterThan(48_000);
        expect(failed).toBe(0);
      }
    }, 120_000);
```

Add the imports for `createAudioDecoderFactory`, `loadNodeAudioWasm` and `audioTracks`. `chunkPackets: 6144 * 4` is about 4.7 MB per read, which is enough for a few seconds of any track.

Run: `npx vitest run tests/local`
Expected: with only HDMV_DISC_A present, its three LPCM tracks each decode and the test passes. With no local discs, the suite is skipped.

- [ ] **Step 2: Switch through every track of each local disc in Chrome.** In `tests/e2e/local-discs.spec.ts`, import `collectWindows`, `expectInSync` and `telemetry` from `./telemetry`, and remove the local `telemetry` and `TelemetrySample` copies. Then, after the seek loop and before the final `decoderErrors` assertion, add:

```ts
    const menu = page.getByTestId('audio-menu');
    if (await menu.isVisible()) {
      const items = page.locator('[data-testid^="audio-track-"]:not([disabled])');
      await menu.click();
      const count = await items.count();
      const tracks: Array<{ id: string; codec: string }> = [];
      for (let i = 0; i < count; i++) {
        tracks.push({ id: (await items.nth(i).getAttribute('data-testid')) ?? '', codec: (await items.nth(i).getAttribute('data-codec')) ?? '' });
      }
      await page.keyboard.press('Escape');
      for (const track of tracks) {
        await page.getByTestId('player').hover();
        await menu.click();
        await page.getByTestId(track.id).click();
        await expect(page.getByTestId('player')).toHaveAttribute('data-state', 'playing', { timeout: 15_000 });
        await expect.poll(async () => (await telemetry(page))?.audioCodec, { timeout: 15_000 }).toBe(track.codec);
        await page.waitForTimeout(500);
        const start = (await telemetry(page))?.clockUs ?? 0;
        const windows = await collectWindows(page, start + 4_000_000, 30_000);
        expectInSync(windows.slice(1));
        expect((await telemetry(page))?.audioDecodeErrors, `${track.codec} decode errors`).toBe(0);
        console.log(`${name}: ${track.id} ${track.codec} in sync`);
      }
    }
```

Clicking the track that is already selected does nothing (the controller ignores it), so `audioCodec` already matches and the check still runs.

Run: `LOCAL_DISCS=1 npx playwright test local-discs`
Expected: PASS on HDMV_DISC_A, with three lines showing LPCM tracks in sync.

- [ ] **Step 3: Commit.**

```bash
git add tests/local/real-discs.test.ts tests/e2e/local-discs.spec.ts
git commit -m "test(local): decode and switch every playable audio track on local discs"
```

---

### Task 12: Docs, final verification and the real-disc gate

**Files:**
- Modify: `docs/superpowers/specs/2026-10-12-bluray-web-player-design.md` (§1, §4, §11, §12)
- Modify: `docs/superpowers/specs/2026-10-13-m2-audio-coverage-design.md` (deviations)
- Modify: `docs/known-issues.md`, `README.md`, `CLAUDE.md`

- [ ] **Step 1: Update the parent spec.**
  - §1, "In scope": the audio line becomes "LPCM (TypeScript); AC-3 / E-AC-3, the AC-3 core of TrueHD, and the DTS core of DTS / DTS-HD (FFmpeg-derived WASM decoder); …".
  - §1, out-of-scope table: the codec gaps row becomes "Lossless TrueHD / DTS-HD decoding, VC-1, MPEG-2 via WASM decoders".
  - §4 step 3, Audio: add DTS core (`core_only`).
  - §11, milestone 2: add the DTS core and say that the WASM build is reproducible and committed.
  - §12, "Audio in v1": "LPCM, plus WASM AC-3/E-AC-3 (with the TrueHD AC-3 core) and DTS core (all DTS-HD flavours); lossless extensions later."

- [ ] **Step 2: Record the deviations in the M2 spec.** Change the `channels` comment in §4.1 to `"mono" | "stereo" | "multichannel" | ''`. In §4.2, say that `PlayerController.selectAudio` adds the `audio-track` notice. In §2.2, say that frame splitting is in `decode/audio-frames.ts`. In §3.1, replace "the writer leaves the gap silent" with "see known-issues.md".

- [ ] **Step 3: Update `docs/known-issues.md`.** Add under a new "## Audio" heading:
  - **TrueHD and DTS-HD play through their lossy cores.** The output is a stereo 48 kHz downmix, so decoding MLP or XLL would not be audible. *Revisit if* multichannel or high-resolution output is added.
  - **A play item without the selected audio stream** gets no audio units. The audio clock then behaves as for any gap in the audio (it can drop to buffering until video read-ahead fills). Blu-ray discs carry every stream in every play item, so nothing fills the gap. *Revisit if* a real disc shows it.
  - **The last E-AC-3 access unit before the end of input is not played** (32 ms), because a group is emitted when the next one starts.
  - **AC-3 at 44.1 or 32 kHz is ignored** (treated as no sync). Blu-ray AC-3 is always 48 kHz.

- [ ] **Step 4: Update `README.md` and `CLAUDE.md`.**
  - README: list `npm run wasm:build` (it needs Docker; CI checks that the committed `audio.wasm` matches). In the deployment section, add "Hosts must serve `.wasm` as `application/wasm`." Mention `fixtures/synthetic/disc3` as the four-codec audio disc.
  - CLAUDE.md:
    - Change the milestone status to "1 and 2 done".
    - Add `npm run wasm:build` to the commands.
    - Add a sentence to the architecture section: audio goes PES → `AudioFramer` → `WasmFrameDecoder` (or LPCM) → `PcmChunk` → `AudioWriter`, and decoders come from `PlayerDeps.createAudioDecoder`.
    - Note that `src/wasm/` is LGPL, and that `audio.wasm` must only be rebuilt with the script.

- [ ] **Step 5: Run the full verification.**

```bash
npm run typecheck && npm test && npm run test:e2e
LOCAL_DISCS=1 npx playwright test local-discs
npx vitest run tests/local
```

Expected: all pass. Copy the `sync stats` lines into the final report.

- [ ] **Step 6: Commit.**

```bash
git add docs README.md CLAUDE.md
git commit -m "docs: record milestone 2 audio coverage"
```

- [ ] **Step 7: Real-disc gate (needs the user).** Ask the user to put their decrypted disc with Dolby and DTS tracks under `fixtures/local/<name>/BDMV/…`. Then run:

```bash
npx vitest run tests/local
LOCAL_DISCS=1 npx playwright test local-discs
```

Expected:
- Every playable track on that disc decodes in Node with 0 failed frames.
- In Chrome, each track reports its codec in `audioCodec`, stays within 20 ms mean / 50 ms max, and has 0 decode errors.

Report the per-track lines. M2 is done only when this passes. Exit criteria 2 and 3 of the spec depend on it, and criterion 3 is the HDMV_DISC_A LPCM switching that Task 11 already covers. If a real disc fails, debug it before declaring the milestone done, using superpowers:systematic-debugging.
