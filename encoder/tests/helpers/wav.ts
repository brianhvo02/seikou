// SPDX-License-Identifier: LGPL-3.0-or-later

/**
 * A streamed 16-bit PCM WAV (`data` size 0xFFFFFFFF, as a pipe writes it) of `frames` frames of
 * silence: a RIFF/WAVE header, a 16-byte `fmt ` chunk and the `data` chunk.
 */
export function wavBytes(channels: number, sampleRate: number, frames = 0): Buffer {
  const head = Buffer.alloc(44);
  head.write('RIFF', 0, 'latin1');
  head.writeUInt32LE(0xffffffff, 4);
  head.write('WAVE', 8, 'latin1');
  head.write('fmt ', 12, 'latin1');
  head.writeUInt32LE(16, 16);
  head.writeUInt16LE(1, 20);
  head.writeUInt16LE(channels, 22);
  head.writeUInt32LE(sampleRate, 24);
  head.writeUInt32LE(sampleRate * channels * 2, 28);
  head.writeUInt16LE(channels * 2, 32);
  head.writeUInt16LE(16, 34);
  head.write('data', 36, 'latin1');
  head.writeUInt32LE(0xffffffff, 40);
  return Buffer.concat([head, Buffer.alloc(frames * channels * 2)]);
}
