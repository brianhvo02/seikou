// SPDX-License-Identifier: LGPL-3.0-or-later
import { Readable } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { readWav } from '../../src/audio/wav';

/** Bytes 2..15 of the KSDATAFORMAT_SUBTYPE GUIDs; bytes 0..1 hold the format tag. */
const SUBTYPE_GUID_TAIL = [0x00, 0x00, 0x00, 0x00, 0x10, 0x00, 0x80, 0x00, 0x00, 0xaa, 0x00, 0x38, 0x9b, 0x71];

/** A canonical WAV header: RIFF, a fmt chunk built from `fmt`, then the data chunk header. */
function header(fmt: Buffer, dataSize: number, riffSize = 0xffffffff): Buffer {
  const riff = Buffer.alloc(12);
  riff.write('RIFF', 0, 'latin1');
  riff.writeUInt32LE(riffSize, 4);
  riff.write('WAVE', 8, 'latin1');
  const fmtHead = Buffer.alloc(8);
  fmtHead.write('fmt ', 0, 'latin1');
  fmtHead.writeUInt32LE(fmt.length, 4);
  const data = Buffer.alloc(8);
  data.write('data', 0, 'latin1');
  data.writeUInt32LE(dataSize, 4);
  return Buffer.concat([riff, fmtHead, fmt, data]);
}

function basicFmt(tag: number, channels: number, rate: number, bits: number): Buffer {
  const b = Buffer.alloc(16);
  b.writeUInt16LE(tag, 0);
  b.writeUInt16LE(channels, 2);
  b.writeUInt32LE(rate, 4);
  b.writeUInt32LE((rate * channels * bits) / 8, 8);
  b.writeUInt16LE((channels * bits) / 8, 12);
  b.writeUInt16LE(bits, 14);
  return b;
}

function extensibleFmt(subTag: number, channels: number, rate: number, bits: number, mask: number): Buffer {
  const ext = Buffer.alloc(24);
  ext.writeUInt16LE(22, 0);
  ext.writeUInt16LE(bits, 2);
  ext.writeUInt32LE(mask, 4);
  ext.writeUInt16LE(subTag, 8);
  Buffer.from(SUBTYPE_GUID_TAIL).copy(ext, 10);
  return Buffer.concat([basicFmt(0xfffe, channels, rate, bits), ext]);
}

/** Feeds `bytes` in pieces of `size`, so headers and frames straddle reads. */
function streamOf(bytes: Buffer, size = 7): Readable {
  const pieces: Buffer[] = [];
  for (let i = 0; i < bytes.length; i += size) pieces.push(bytes.subarray(i, i + size));
  return Readable.from(pieces);
}

async function planes(frames: AsyncIterable<Float32Array[]>): Promise<number[][]> {
  const out: number[][] = [];
  for await (const chunk of frames) {
    chunk.forEach((plane, ch) => {
      out[ch] ??= [];
      out[ch].push(...plane);
    });
  }
  return out;
}

describe('readWav', () => {
  it('reads streamed 16-bit stereo PCM (data size 0xFFFFFFFF) to the end, scaled to [-1, 1)', async () => {
    const samples = Buffer.alloc(4 * 4);
    [[0, 16384], [-32768, 32767], [-16384, 1], [100, -100]].forEach(([l, r], i) => {
      samples.writeInt16LE(l, i * 4);
      samples.writeInt16LE(r, i * 4 + 2);
    });
    const { format, frames } = await readWav(streamOf(Buffer.concat([header(basicFmt(1, 2, 48000, 16), 0xffffffff), samples])));
    expect(format).toEqual({ channels: 2, sampleRate: 48000, bitsPerSample: 16, float: false });
    const [left, right] = await planes(frames);
    expect(left).toEqual([0, -1, -0.5, 100 / 32768]);
    expect(right).toEqual([0.5, 32767 / 32768, 1 / 32768, -100 / 32768]);
  });

  it('reads a data size of 0 as streamed too', async () => {
    const samples = Buffer.alloc(4);
    samples.writeInt16LE(-32768, 0);
    samples.writeInt16LE(8192, 2);
    const { frames } = await readWav(streamOf(Buffer.concat([header(basicFmt(1, 1, 16000, 16), 0), samples])));
    expect(await planes(frames)).toEqual([[-1, 0.25]]);
  });

  it('reads 6-channel float32 in WAVE_FORMAT_EXTENSIBLE into 6 planes', async () => {
    const frameCount = 5;
    const samples = Buffer.alloc(frameCount * 6 * 4);
    for (let f = 0; f < frameCount; f++) for (let ch = 0; ch < 6; ch++) samples.writeFloatLE(ch / 8 + f / 64, (f * 6 + ch) * 4);
    const bytes = Buffer.concat([header(extensibleFmt(3, 6, 48000, 32, 0x3f), 0xffffffff), samples]);
    const { format, frames } = await readWav(streamOf(bytes));
    expect(format).toEqual({ channels: 6, sampleRate: 48000, bitsPerSample: 32, float: true });
    const got = await planes(frames);
    expect(got).toHaveLength(6);
    for (let ch = 0; ch < 6; ch++) expect(got[ch]).toEqual(Array.from({ length: frameCount }, (_, f) => ch / 8 + f / 64));
  });

  it('reads the header vspipe writes for AC-3: EXTENSIBLE float32 stereo with a known data size, stopping at its end', async () => {
    const samples = Buffer.alloc(3 * 2 * 4);
    [0.25, -0.25, 0.5, -0.5, 0.75, -0.75].forEach((v, i) => samples.writeFloatLE(v, i * 4));
    const trailing = Buffer.from('LIST\x04\x00\x00\x00abcd', 'latin1');
    const fmt = extensibleFmt(3, 2, 48000, 32, 3);
    const bytes = Buffer.concat([header(fmt, samples.length, 4 + 8 + fmt.length + 8 + samples.length), samples, trailing]);
    const { format, frames } = await readWav(streamOf(bytes, 5));
    expect(format).toEqual({ channels: 2, sampleRate: 48000, bitsPerSample: 32, float: true });
    expect(await planes(frames)).toEqual([[0.25, 0.5, 0.75], [-0.25, -0.5, -0.75]]);
  });

  it('reads 24-bit integer PCM in WAVE_FORMAT_EXTENSIBLE and skips other chunks before data', async () => {
    const samples = Buffer.alloc(6);
    samples.writeIntLE(-8388608, 0, 3);
    samples.writeIntLE(4194304, 3, 3);
    const full = header(extensibleFmt(1, 1, 96000, 24, 4), 0xffffffff);
    // An odd-sized chunk, padded to an even length, between fmt and data.
    const extra = Buffer.from('junk\x03\x00\x00\x00xyz\x00', 'latin1');
    const dataAt = full.length - 8;
    const bytes = Buffer.concat([full.subarray(0, dataAt), extra, full.subarray(dataAt), samples]);
    const { format, frames } = await readWav(streamOf(bytes, 3));
    expect(format).toEqual({ channels: 1, sampleRate: 96000, bitsPerSample: 24, float: false });
    expect(await planes(frames)).toEqual([[-1, 0.5]]);
  });

  it('rejects an unknown format tag, naming it', async () => {
    await expect(readWav(streamOf(header(basicFmt(0x55, 2, 48000, 16), 0)))).rejects.toThrow(/0x0055/);
  });

  it('rejects input that is not RIFF/WAVE', async () => {
    await expect(readWav(streamOf(Buffer.from('OggS not a wave file at all')))).rejects.toThrow(/RIFF/);
  });
});
