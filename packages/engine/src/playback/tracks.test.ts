import { describe, expect, it } from 'vitest';
import type { StreamEntry } from '@seikou/bdmv/mpls-parser';
import { CodingType } from '@seikou/bdmv/stream-types';
import { audioTracks, channelsLabel } from './tracks';

const entry = (codingType: number, format: number, lang: string, subPath = false): StreamEntry => ({ pid: 0x1100, codingType, format, rate: 1, lang, subPath, streamType: subPath ? 2 : 1, charCode: 0, subPathId: 0, subClipId: 0 });

describe('audioTracks', () => {
  it('lists every STN audio entry with its 1-based number and playability', () => {
    const tracks = audioTracks({
      video: [],
      audio: [entry(CodingType.LPCM, 3, 'jpn'), entry(CodingType.DTSHD_MASTER, 6, 'eng'), entry(CodingType.DTSHD_SECONDARY, 3, 'eng'), entry(CodingType.AC3, 6, 'fra', true)],
      pg: [],
      ig: [],
      pipPg: [],
      secondaryAudio: [],
      secondaryVideo: [],
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
