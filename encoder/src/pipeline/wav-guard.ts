// SPDX-License-Identifier: LGPL-3.0-or-later
import { Transform, type Readable, type TransformCallback } from 'node:stream';
import { parseWavHeader } from '../audio/wav';
import { pidHex } from '../disc/pmt';

// BestSource picks an audio stream by its position among the streams libavformat finds in a clip
// (`AudioSource(track=-n)`), and the planner works that position out from the clip's PMT. Were the
// two to disagree, BestSource would decode another stream without complaint and the episode would
// carry the wrong language under the right label. The guard compares the decoded WAV's header with
// what the playlist says about the stream it asked for, before any sample reaches the encoder.

/** What the playlist says about the audio stream a WAV should hold. */
export interface WavExpectation {
  /** The stream's PID, named in the error. */
  pid: number;
  /**
   * The channel count the playlist gives the stream. Above two it stands for any multi-channel layout,
   * because the disc's layout code only says "multi-channel" (5.1 and 7.1 share it).
   */
  channels: number;
  /** The sample rate the playlist gives the stream, in Hz. */
  sampleRate: number;
}

/** A WAV header that does not match its stream, or no readable header at all. */
export class WavGuardError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'WavGuardError';
  }
}

/** A WAV header larger than this (skipped chunks included) is refused rather than buffered. */
const MAX_HEADER_BYTES = 64 * 1024;

function channelsMatch(expected: number, actual: number): boolean {
  return expected > 2 ? actual > 2 : actual === expected;
}

/**
 * A pass-through for a WAV stream that checks its header against the stream the playlist describes. The bytes come
 * out unchanged; nothing is emitted until the header (up to the `data` chunk's header) has been read and checked. The
 * returned stream errors with a `WavGuardError` when the channel count or sample rate differs, for example
 * `PID 0x1101: BestSource gave 2 channels at 48000 Hz; the disc says 6 channels at 48000 Hz`, and when the input is
 * not a WAV stream, its header is longer than 64 KiB, or it ends inside the header. An error on `stream` is passed on.
 */
export function guardWav(stream: Readable, expected: WavExpectation): Readable {
  const pid = pidHex(expected.pid);
  let head: Buffer = Buffer.alloc(0);
  let checked = false;
  const guard = new Transform({
    transform(chunk: Buffer, _encoding: BufferEncoding, done: TransformCallback): void {
      if (checked) return done(null, chunk);
      head = Buffer.concat([head, chunk]);
      let header;
      try {
        header = parseWavHeader(head);
      } catch (e) {
        return done(new WavGuardError(`PID ${pid}: ${(e as Error).message}`));
      }
      if (header === null) {
        if (head.length > MAX_HEADER_BYTES) return done(new WavGuardError(`PID ${pid}: the WAV header is longer than ${MAX_HEADER_BYTES} bytes`));
        return done();
      }
      const { channels, sampleRate } = header.format;
      if (!channelsMatch(expected.channels, channels) || sampleRate !== expected.sampleRate) {
        return done(
          new WavGuardError(
            `PID ${pid}: BestSource gave ${channels} channels at ${sampleRate} Hz; the disc says ${expected.channels} channels at ${expected.sampleRate} Hz`,
          ),
        );
      }
      checked = true;
      const all = head;
      head = Buffer.alloc(0);
      done(null, all);
    },
    flush(done: TransformCallback): void {
      done(checked ? null : new WavGuardError(`PID ${pid}: the WAV stream ended inside its header`));
    },
  });
  stream.once('error', (e: Error) => guard.destroy(e));
  return stream.pipe(guard);
}
