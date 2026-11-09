// SPDX-License-Identifier: LGPL-3.0-or-later
import type { MkvTrack } from '@seikou/matroska';
import type { AudioDecodeResult, AudioDecoder, AudioUnit } from './audio-decoder';
import { UnsupportedCodecError } from './decoder';
import type { PcmChunk } from './lpcm';

// Opus from Matroska (an encoded episode), decoded by the browser's WebCodecs AudioDecoder. The track's CodecPrivate is
// the OpusHead (RFC 7845 §5.1), CodecDelay its pre-skip and SeekPreRoll the 80 ms a decoder needs before a seek point
// (RFC 7845 §4.6). WebCodecs decodes asynchronously; the engine's AudioDecoder contract is synchronous, so the output
// is queued as it comes and handed on by the next decode() or takeOutput(). The audio writer places every chunk at the
// ring frame its PTS names, so when it is handed on does not move it: the master clock stays exact.
//
// Browsers differ in whether they apply the OpusHead's pre-skip themselves. The description is given with its pre-skip
// zeroed, so no browser drops anything, and the pre-skip is dropped here, by time: a block at time T decodes to the
// samples of T - CodecDelay (RFC 9559's Opus mapping), and what falls before 0 is the pre-skip.

/**
 * The engine's coding number for Opus audio. Blu-ray coding types (`CodingType`) are one byte; this lies outside them,
 * so it never names a disc stream.
 */
export const CODING_OPUS = 0x1_0002;

/** The codec name the engine reports for Opus (telemetry, notices). */
export const OPUS_NAME = 'Opus';

/** The message of the UnsupportedCodecError for Opus audio the browser can't decode. */
export const OPUS_UNSUPPORTED_MESSAGE = "This browser can't play Opus audio, so the episode will play without sound.";

/** The part of a WebCodecs AudioData the adapter reads. */
export interface AudioDataLike {
  /** Microseconds: the timestamp of the chunk it came from. */
  readonly timestamp: number;
  readonly numberOfFrames: number;
  readonly numberOfChannels: number;
  readonly sampleRate: number;
  copyTo(destination: AllowSharedBufferSource, options: { planeIndex: number; format?: AudioSampleFormat }): void;
  close(): void;
}

/** The part of a WebCodecs AudioDecoder the adapter uses. */
export interface AudioDecoderLike {
  readonly state: CodecState;
  readonly decodeQueueSize: number;
  configure(config: AudioDecoderConfig): void;
  decode(chunk: EncodedAudioChunk): void;
  flush(): Promise<void>;
  reset(): void;
  close(): void;
}

/** WebCodecs' audio decoding, injectable so tests can stand in for the browser. */
export interface AudioDecoderApi {
  create(init: { output(data: AudioDataLike): void; error(error: DOMException): void }): AudioDecoderLike;
  isConfigSupported(config: AudioDecoderConfig): Promise<{ readonly supported?: boolean }>;
  makeChunk(init: EncodedAudioChunkInit): EncodedAudioChunk;
}

/** The browser's WebCodecs AudioDecoder, or null where it has none. */
export const browserAudioDecoderApi: AudioDecoderApi | null =
  typeof AudioDecoder === 'undefined'
    ? null
    : {
      create: (init) => new AudioDecoder({ output: (data) => init.output(data), error: (e) => init.error(e) }),
      isConfigSupported: (config) => AudioDecoder.isConfigSupported(config),
      makeChunk: (init) => new EncodedAudioChunk(init),
    };

/** The OpusHead fields the adapter needs (RFC 7845 §5.1). */
export interface OpusHead {
  readonly channels: number;
  /** Samples at 48 kHz to drop at the start. */
  readonly preSkip: number;
  /** The encoder's input rate in Hz (informational: Opus always decodes at 48 kHz here). */
  readonly inputRate: number;
  readonly mappingFamily: number;
}

/** Reads an OpusHead; null when it is too short or has no `OpusHead` magic. */
export function parseOpusHead(head: Uint8Array): OpusHead | null {
  if (head.length < 19) return null;
  const magic = String.fromCharCode(...head.subarray(0, 8));
  if (magic !== 'OpusHead') return null;
  const view = new DataView(head.buffer, head.byteOffset, head.byteLength);
  return { channels: head[9]!, preSkip: view.getUint16(10, true), inputRate: view.getUint32(12, true), mappingFamily: head[18]! };
}

/** What decoding one Opus track needs, from its TrackEntry. */
export interface OpusTrackConfig {
  /** The OpusHead (CodecPrivate), when the track has one. */
  readonly head: Uint8Array | null;
  readonly channels: number;
  /** CodecDelay in microseconds: what a block's time is ahead of the samples it decodes to. */
  readonly codecDelayUs: number;
  /** SeekPreRoll in microseconds: how much earlier than a seek target decoding starts. */
  readonly seekPreRollUs: number;
}

/** The decoding settings of a Matroska Opus track; without a CodecDelay the OpusHead's pre-skip stands in. */
export function opusTrackConfig(track: MkvTrack): OpusTrackConfig {
  const head = track.codecPrivate ?? null;
  const parsed = head ? parseOpusHead(head) : null;
  const delayUs = track.codecDelayNs > 0n ? Number(track.codecDelayNs) / 1000 : parsed ? (parsed.preSkip * 1e6) / 48_000 : 0;
  return {
    head,
    channels: parsed?.channels ?? track.audio?.channels ?? 2,
    codecDelayUs: Math.round(delayUs),
    seekPreRollUs: Math.round(Number(track.seekPreRollNs) / 1000),
  };
}

const OUTPUT_RATE = 48_000;

function decoderConfig(config: OpusTrackConfig): AudioDecoderConfig {
  const out: AudioDecoderConfig = { codec: 'opus', sampleRate: OUTPUT_RATE, numberOfChannels: config.channels };
  if (config.head && parseOpusHead(config.head)) {
    const description = new Uint8Array(config.head); // a copy: the pre-skip is dropped here, by time
    description[10] = 0;
    description[11] = 0;
    out.description = description.buffer;
  }
  return out;
}

/**
 * Opens a WebCodecs decoder for an Opus track. Rejects with UnsupportedCodecError (CODING_OPUS) when the browser has no
 * WebCodecs audio (`api` null) or does not support the configuration. `nowMs` is the wall clock owed packets are timed on.
 */
export async function createOpusDecoder(api: AudioDecoderApi | null, config: OpusTrackConfig, nowMs: () => number = () => performance.now()): Promise<OpusDecoder> {
  if (!api) throw new UnsupportedCodecError(CODING_OPUS, OPUS_UNSUPPORTED_MESSAGE);
  const cfg = decoderConfig(config);
  let supported = false;
  try {
    supported = (await api.isConfigSupported(cfg)).supported === true;
  } catch {
    supported = false;
  }
  if (!supported) throw new UnsupportedCodecError(CODING_OPUS, OPUS_UNSUPPORTED_MESSAGE);
  return new OpusDecoder(api, cfg, config.codecDelayUs, nowMs);
}

/** A packet whose PCM has not come out this long after it was submitted is no longer waited for (a hung decoder). */
export const OPUS_OWED_TIMEOUT_MS = 1000;

// Vorbis channel order (RFC 7845 §5.1.1.2), per channel count: the weight of each channel in the left and right mix.
const S = Math.SQRT1_2;
const DOWNMIX: Readonly<Record<number, readonly (readonly [number, number])[]>> = {
  3: [[1, 0], [S, S], [0, 1]], // L C R
  4: [[1, 0], [0, 1], [S, 0], [0, S]], // FL FR RL RR
  5: [[1, 0], [S, S], [0, 1], [S, 0], [0, S]], // FL C FR RL RR
  6: [[1, 0], [S, S], [0, 1], [S, 0], [0, S], [0, 0]], // FL C FR RL RR LFE
  7: [[1, 0], [S, S], [0, 1], [S, 0], [0, S], [0.5, 0.5], [0, 0]], // FL C FR SL SR RC LFE
  8: [[1, 0], [S, S], [0, 1], [S, 0], [0, S], [S, 0], [0, S], [0, 0]], // FL C FR SL SR RL RR LFE
};

/** Interleaved stereo from planar channels: mono doubled, two kept, more mixed down (scaled so a full mix cannot clip). */
function toStereo(planes: readonly Float32Array[], frames: number): Float32Array {
  const out = new Float32Array(frames * 2);
  const n = planes.length;
  if (n === 1) {
    const m = planes[0]!;
    for (let i = 0; i < frames; i++) out[2 * i] = out[2 * i + 1] = m[i]!;
    return out;
  }
  if (n === 2 || !DOWNMIX[n]) {
    const l = planes[0]!;
    const r = planes[1]!;
    for (let i = 0; i < frames; i++) {
      out[2 * i] = l[i]!;
      out[2 * i + 1] = r[i]!;
    }
    return out;
  }
  const weights = DOWNMIX[n]!;
  const scale = 1 / weights.reduce((sum, [wl]) => sum + wl, 0);
  for (let c = 0; c < n; c++) {
    const [wl, wr] = weights[c]!;
    if (wl === 0 && wr === 0) continue;
    const p = planes[c]!;
    for (let i = 0; i < frames; i++) {
      out[2 * i] += p[i]! * wl * scale;
      out[2 * i + 1] += p[i]! * wr * scale;
    }
  }
  return out;
}

/**
 * One Opus track's WebCodecs decoder as an engine AudioDecoder. decode() submits a packet and returns the PCM that came
 * out since the last call; takeOutput() returns what came out since, and flush() makes the decoder give up what it holds
 * (at the end of input). reset() starts a fresh WebCodecs decoder, so nothing the old one held comes out afterwards.
 * A decoder error turns the next decode() into an UnsupportedCodecError.
 */
export class OpusDecoder implements AudioDecoder {
  private decoder: AudioDecoderLike;
  private queue: PcmChunk[] = [];
  private failure: string | null = null;
  /** Packets submitted whose output has not come yet, in order: their timestamps, DiscardPadding (48 kHz samples) and when they went in. */
  private pending: { readonly timestamp: number; readonly discardFrames: number; readonly submittedMs: number }[] = [];

  constructor(
    private readonly api: AudioDecoderApi,
    private readonly config: AudioDecoderConfig,
    private readonly codecDelayUs: number,
    private readonly nowMs: () => number = () => performance.now(),
  ) {
    this.decoder = this.open();
  }

  private open(): AudioDecoderLike {
    const decoder: AudioDecoderLike = this.api.create({
      output: (data) => {
        try {
          if (decoder === this.decoder) this.accept(data);
        } finally {
          data.close();
        }
      },
      error: (e) => {
        if (decoder === this.decoder) this.failure = e.message || String(e);
      },
    });
    this.failure = null;
    decoder.configure(this.config);
    return decoder;
  }

  private accept(data: AudioDataLike): void {
    // output comes in submission order: this one's packet and any before it (a packet that gave nothing) are done. This
    // relies on an AudioData's timestamp being its chunk's, as the WebCodecs spec has it for audio decoders; the
    // DiscardPadding is matched by that timestamp too.
    let discardFrames = 0;
    while (this.pending.length > 0 && this.pending[0]!.timestamp <= data.timestamp) {
      const done = this.pending.shift()!;
      if (done.timestamp === data.timestamp) discardFrames = done.discardFrames;
    }
    const total = data.numberOfFrames;
    if (total === 0) return;
    const planes: Float32Array[] = [];
    for (let c = 0; c < data.numberOfChannels; c++) {
      const plane = new Float32Array(total);
      data.copyTo(plane, { planeIndex: c, format: 'f32-planar' });
      planes.push(plane);
    }
    // DiscardPadding (the last packet's end padding) comes off the end
    let count = total - Math.min(total, Math.round((discardFrames * data.sampleRate) / OUTPUT_RATE));
    if (count <= 0) return;
    let stereo = toStereo(planes, total).subarray(0, count * 2);
    let ptsUs = data.timestamp - this.codecDelayUs;
    if (ptsUs < 0) {
      // the pre-skip: samples before the episode's time 0
      const skip = Math.min(count, Math.round((-ptsUs * data.sampleRate) / 1e6));
      if (skip >= count) return;
      stereo = stereo.subarray(skip * 2);
      count -= skip;
      ptsUs = 0;
    }
    this.queue.push({ ptsUs, sampleRate: data.sampleRate, frames: count, stereo: stereo.slice() });
  }

  private throwFailure(): void {
    if (this.failure !== null) throw new UnsupportedCodecError(CODING_OPUS, `The Opus audio could not be decoded (${this.failure}), so the episode will play without sound.`);
  }

  decode(unit: AudioUnit): AudioDecodeResult {
    this.throwFailure();
    if (this.decoder.state === 'configured') {
      const discardFrames = unit.discardPaddingUs ? Math.round((unit.discardPaddingUs * OUTPUT_RATE) / 1e6) : 0;
      this.pending.push({ timestamp: unit.ptsUs, discardFrames, submittedMs: this.nowMs() });
      this.decoder.decode(this.api.makeChunk({ type: 'key', timestamp: unit.ptsUs, data: unit.data }));
    }
    return this.takeOutput();
  }

  /**
   * Episode time of the oldest packet submitted whose PCM has not come out yet, or null when none is waiting: the
   * player fills no silence from there on, or the late PCM would land on it and be dropped. Nothing is owed by a decoder
   * that failed or closed, nor by a packet submitted over OPUS_OWED_TIMEOUT_MS ago (a hung decoder): its PCM, if it
   * ever comes, lands only where the ring has already passed.
   */
  pendingFromUs(): number | null {
    if (this.failure !== null || this.decoder.state === 'closed') return null;
    const cutoff = this.nowMs() - OPUS_OWED_TIMEOUT_MS;
    const first = this.pending.find((p) => p.submittedMs > cutoff);
    return first ? first.timestamp - this.codecDelayUs : null;
  }

  /**
   * The PCM that came out since the last decode() or takeOutput(). Throws the decoder's failure (UnsupportedCodecError),
   * so the player turns audio off without waiting for another unit.
   */
  takeOutput(): AudioDecodeResult {
    this.throwFailure();
    if (this.queue.length === 0) return { chunks: [], failedFrames: 0 };
    const chunks = this.queue;
    this.queue = [];
    return { chunks, failedFrames: 0 };
  }

  /** At the end of input: the decoder outputs what it holds (handed on by takeOutput). */
  async flush(): Promise<void> {
    const decoder = this.decoder;
    if (decoder.state !== 'configured') return;
    try {
      await decoder.flush();
    } catch {
      // reset or closed meanwhile: nothing to hand on
    }
    // what the flush did not give will not come
    if (decoder === this.decoder) this.pending = [];
  }

  reset(): void {
    this.queue = [];
    this.pending = [];
    if (this.decoder.state !== 'closed') this.decoder.close(); // after a decoder error it is closed already
    this.decoder = this.open();
  }

  close(): void {
    this.queue = [];
    this.pending = [];
    if (this.decoder.state !== 'closed') this.decoder.close();
  }
}
