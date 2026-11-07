import type { Readable } from 'node:stream';

/** The sample rate of decoded audio, in Hz. */
export const SAMPLE_RATE_OUT = 16_000;

/** One audio PID of a byte range of an m2ts clip, for a decoder to turn into PCM. */
export interface AudioDecodeInput {
  /** The raw m2ts bytes (192-byte source packets, the range's first and last may be partial). */
  readonly read: Readable;
  readonly pid: number;
  /** The stream's coding type (`CodingType` of @seikou/bdmv/stream-types). */
  readonly coding: number;
  readonly signal?: AbortSignal;
}

/**
 * Decodes one audio PID of a byte range of a clip to 16 kHz mono PCM. `firstPts` is the 90 kHz PTS of the first audio PES
 * in the range, which is where `pcm[0]` sits. Throws when it can't decode, or when frames were lost. An error whose `syscall`
 * starts with `spawn` means the decoder could not be started at all (a broken setup): `align` passes it on instead of
 * skipping the window.
 */
export type AudioDecoder = (input: AudioDecodeInput) => Promise<{ firstPts: number; pcm: Int16Array }>;
