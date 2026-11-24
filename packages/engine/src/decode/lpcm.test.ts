import { describe, expect, it } from 'vitest';
import { UnsupportedCodecError } from './decoder';
import { STEREO, applyMix, mixMatrix } from '../audio/channel-map';
import { decodeLpcm, parseLpcmHeader, type PcmChunk } from './lpcm';

/** The chunk folded to stereo as the ring of a stereo output would get it. */
function stereo(c: PcmChunk): Float32Array {
  return applyMix(c.samples, c.frames, c.channels.length, mixMatrix(c.channels, STEREO), 2);
}

function lpcm(assignment: number, rateCode: number, bitsCode: number, frames: number[][]): Uint8Array {
  const bytesPerSample = bitsCode === 1 ? 2 : 3;
  const bytes: number[] = [0, 0, (assignment << 4) | rateCode, bitsCode << 6];
  for (const frame of frames) {
    for (const sample of frame) {
      const v = sample < 0 ? sample + (bytesPerSample === 2 ? 0x10000 : 0x1000000) : sample;
      if (bytesPerSample === 3) bytes.push((v >> 16) & 0xff);
      bytes.push((v >> 8) & 0xff, v & 0xff);
    }
  }
  const size = bytes.length - 4;
  bytes[0] = size >> 8;
  bytes[1] = size & 0xff;
  return new Uint8Array(bytes);
}

describe('LPCM', () => {
  it('parses the header, padding odd channel counts', () => {
    expect(parseLpcmHeader(lpcm(9, 4, 3, []))).toEqual({ channelAssignment: 9, sampleRate: 96_000, bitsPerSample: 24, codedChannels: 6, storedChannels: 6 });
    expect(parseLpcmHeader(lpcm(1, 5, 1, []))).toMatchObject({ sampleRate: 192_000, codedChannels: 1, storedChannels: 2 });
    expect(parseLpcmHeader(lpcm(8, 1, 1, []))).toMatchObject({ codedChannels: 5, storedChannels: 6 });
  });

  it('decodes 16-bit stereo', () => {
    const chunk = decodeLpcm(lpcm(3, 1, 1, [[16384, -16384], [32767, -32768]]), 1_000);
    expect(chunk).toMatchObject({ ptsUs: 1_000, sampleRate: 48_000, frames: 2 });
    expect(chunk.channels).toEqual(['FL', 'FR']);
    expect(Array.from(chunk.samples)).toEqual([0.5, -0.5, 32767 / 32768, -1]);
  });

  it('feeds mono to both sides and ignores the padding channel', () => {
    const chunk = decodeLpcm(lpcm(1, 1, 1, [[8192, 999]]), 0);
    expect(Array.from(chunk.samples)).toEqual([0.25]);
    expect(Array.from(stereo(chunk))).toEqual([0.25, 0.25]);
  });

  it('keeps 24-bit 5.1 whole, and its stereo fold drops LFE', () => {
    const chunk = decodeLpcm(lpcm(9, 1, 3, [[0x400000, 0, 0, 0, 0, 0x7fffff]]), 0);
    const norm = 1 / (1 + 2 * Math.SQRT1_2);
    expect(chunk.channels).toEqual(['FL', 'FR', 'FC', 'SL', 'SR', 'LFE']);
    expect(chunk.samples[5]).toBeCloseTo(1, 6);
    expect(stereo(chunk)[0]).toBeCloseTo(0.5 * norm, 6);
    expect(stereo(chunk)[1]).toBe(0);
  });

  it('rejects 20-bit samples as unsupported', () => {
    expect(() => decodeLpcm(lpcm(3, 1, 2, []), 0)).toThrow(UnsupportedCodecError);
  });

  it('rejects reserved sample rates', () => {
    expect(() => parseLpcmHeader(lpcm(3, 2, 1, []))).toThrow(/sample rate/);
  });

  it('puts each surround of a 3/4 (7.1) layout on its own side and drops LFE', () => {
    // Coded order: L R C Ls Lb Rb Rs LFE. Only the left surrounds carry signal.
    const left = stereo(decodeLpcm(lpcm(11, 1, 3, [[0, 0, 0, 0x400000, 0x400000, 0, 0, 0x7fffff]]), 0));
    expect(left[0]).toBeGreaterThan(0);
    expect(left[1]).toBe(0);
    // Only the right surrounds carry signal.
    const right = stereo(decodeLpcm(lpcm(11, 1, 3, [[0, 0, 0, 0, 0, 0x400000, 0x400000, 0]]), 0));
    expect(right[0]).toBe(0);
    expect(right[1]).toBeCloseTo(left[0], 6);
  });
});
