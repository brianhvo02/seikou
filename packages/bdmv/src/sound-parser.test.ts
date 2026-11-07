import { describe, expect, it } from 'vitest';
import { buildSoundBdmv } from '../../../tests/helpers/bdmv-builders';
import { ParseError } from './byte-reader';
import { parseSoundBdmv } from './sound-parser';

describe('parseSoundBdmv', () => {
  it('round-trips clips', () => {
    const bytes = buildSoundBdmv([
      { channels: 2, samples: Int16Array.of(1, -1, 2, -2) },
      { channels: 1, samples: Int16Array.of(5) },
    ]);
    const { clips } = parseSoundBdmv(bytes);
    expect(clips).toHaveLength(2);
    expect(clips[0].channels).toBe(2);
    expect(clips[0].sampleRate).toBe(48000);
    expect([...clips[0].samples]).toEqual([1, -1, 2, -2]);
    expect(clips[1].channels).toBe(1);
    expect([...clips[1].samples]).toEqual([5]);
  });

  it('rejects a bad signature', () => {
    const bytes = buildSoundBdmv([{ channels: 1, samples: Int16Array.of(5) }]);
    bytes[0] = 0x58;
    expect(() => parseSoundBdmv(bytes)).toThrow(ParseError);
  });

  it('rejects an out-of-range data offset', () => {
    const bytes = buildSoundBdmv([{ channels: 1, samples: Int16Array.of(1, 2) }]);
    new DataView(bytes.buffer).setUint32(40 + 6 + 2, 0x10000); // data offset of sound 0
    expect(() => parseSoundBdmv(bytes)).toThrow(ParseError);
  });

  it('rejects truncated sample data', () => {
    const bytes = buildSoundBdmv([{ channels: 1, samples: Int16Array.of(1, 2, 3, 4) }]);
    expect(() => parseSoundBdmv(bytes.subarray(0, bytes.length - 2))).toThrow(ParseError);
  });
});
