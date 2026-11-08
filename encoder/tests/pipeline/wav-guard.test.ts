// SPDX-License-Identifier: LGPL-3.0-or-later
import { Readable } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { parseWavHeader } from '../../src/audio/wav';
import { guardWav } from '../../src/pipeline/wav-guard';
import { collect } from '../helpers/streams';
import { wavBytes } from '../helpers/wav';

/** Feeds `bytes` in pieces of `size`, so the header straddles reads. */
function streamOf(bytes: Buffer, size = 5): Readable {
  const pieces: Buffer[] = [];
  for (let i = 0; i < bytes.length; i += size) pieces.push(bytes.subarray(i, i + size));
  return Readable.from(pieces);
}

describe('parseWavHeader', () => {
  it('needs more bytes until the data chunk header, then gives the format and where the samples start', () => {
    const bytes = wavBytes(6, 48000, 2);
    expect(parseWavHeader(bytes.subarray(0, 43))).toBeNull();
    expect(parseWavHeader(bytes)).toEqual({
      format: { channels: 6, sampleRate: 48000, bitsPerSample: 16, float: false },
      blockAlign: 12,
      dataOffset: 44,
      dataSize: null,
    });
  });

  it('refuses bytes that are not RIFF/WAVE', () => {
    expect(() => parseWavHeader(Buffer.from('OggS not a wave file at all'))).toThrow(/RIFF/);
  });
});

describe('guardWav', () => {
  it('guardWav passes a matching header through unchanged', async () => {
    const bytes = wavBytes(6, 48000, 100);
    const out = Buffer.concat(await collect(guardWav(streamOf(bytes), { pid: 0x1101, channels: 6, sampleRate: 48000 })));
    expect(out.equals(bytes)).toBe(true);
  });

  it('guardWav fails on a channel mismatch naming the PID', async () => {
    const guarded = guardWav(streamOf(wavBytes(2, 48000, 10)), { pid: 0x1101, channels: 6, sampleRate: 48000 });
    await expect(collect(guarded)).rejects.toThrow('PID 0x1101: BestSource gave 2 channels at 48000 Hz; the disc says 6 channels at 48000 Hz');
  });

  it('fails on a sample rate mismatch', async () => {
    const guarded = guardWav(streamOf(wavBytes(2, 96000)), { pid: 0x1100, channels: 2, sampleRate: 48000 });
    await expect(collect(guarded)).rejects.toThrow('PID 0x1100: BestSource gave 2 channels at 96000 Hz; the disc says 2 channels at 48000 Hz');
  });

  it("takes any count above two for the disc's multi-channel layout, and only that", async () => {
    const bytes = wavBytes(8, 48000, 3);
    const out = Buffer.concat(await collect(guardWav(streamOf(bytes), { pid: 0x1102, channels: 6, sampleRate: 48000 })));
    expect(out.equals(bytes)).toBe(true);
    await expect(collect(guardWav(streamOf(wavBytes(1, 48000)), { pid: 0x1102, channels: 2, sampleRate: 48000 }))).rejects.toThrow(/gave 1 channels/);
  });

  it('fails naming the PID when the stream ends inside the header or is not a WAV', async () => {
    const expected = { pid: 0x1100, channels: 2, sampleRate: 48000 };
    await expect(collect(guardWav(streamOf(wavBytes(2, 48000).subarray(0, 30)), expected))).rejects.toThrow(/PID 0x1100: .*header/);
    await expect(collect(guardWav(streamOf(Buffer.from('OggS not a wave file at all')), expected))).rejects.toThrow(/PID 0x1100: .*RIFF/);
  });
});
