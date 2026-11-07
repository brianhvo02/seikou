import { describe, expect, it } from 'vitest';
import type { PlayItem, StreamEntry } from '@seikou/bdmv/mpls-parser';
import { CodingType } from '@seikou/bdmv/stream-types';
import { audioEntryFor, chooseStreams, igEntryFor } from './stream-selection';

const entry = (pid: number, codingType: number, subPath = false): StreamEntry => ({ pid, codingType, format: 0, rate: 0, lang: 'eng', subPath, streamType: subPath ? 2 : 1, charCode: 0, subPathId: 0, subClipId: 0 });

describe('chooseStreams', () => {
  it('picks the first main-path video and the first playable audio, with its stream number', () => {
    const choice = chooseStreams({
      video: [entry(0x1b00, CodingType.AVC, true), entry(0x1011, CodingType.AVC)],
      audio: [entry(0x1100, CodingType.EAC3_SECONDARY), entry(0x1101, CodingType.AC3), entry(0x1102, CodingType.LPCM)],
      pg: [],
      ig: [],
      pipPg: [],
      secondaryAudio: [],
      secondaryVideo: [],
    });
    expect(choice.video?.pid).toBe(0x1011);
    expect(choice.audio?.pid).toBe(0x1101);
    expect(choice.audioIndex).toBe(2);
    expect(choice.unsupportedAudio).toEqual([]);
  });

  it('plays TrueHD and DTS-HD (through their cores)', () => {
    const choice = chooseStreams({ video: [], audio: [entry(0x1100, CodingType.TRUEHD), entry(0x1101, CodingType.DTSHD_MASTER)], pg: [], ig: [], pipPg: [], secondaryAudio: [], secondaryVideo: [] });
    expect(choice.audio?.codingType).toBe(CodingType.TRUEHD);
  });

  it('reports unsupported audio when nothing is playable', () => {
    const choice = chooseStreams({
      video: [entry(0x1011, CodingType.AVC)],
      audio: [entry(0x1100, CodingType.EAC3_SECONDARY), entry(0x1101, CodingType.DTSHD_SECONDARY)],
      pg: [],
      ig: [],
      pipPg: [],
      secondaryAudio: [],
      secondaryVideo: [],
    });
    expect(choice.audio).toBeNull();
    expect(choice.audioIndex).toBeNull();
    expect(choice.unsupportedAudio.map((a) => a.codingType)).toEqual([CodingType.EAC3_SECONDARY, CodingType.DTSHD_SECONDARY]);
  });

  it('handles playlists without audio or video', () => {
    expect(chooseStreams({ video: [], audio: [], pg: [], ig: [], pipPg: [], secondaryAudio: [], secondaryVideo: [] })).toEqual({ video: null, audio: null, audioIndex: null, unsupportedAudio: [] });
  });
});

describe('audioEntryFor', () => {
  const item = {
    stn: { video: [], audio: [entry(0x1100, CodingType.LPCM), entry(0x1101, CodingType.AC3), entry(0x1102, CodingType.AC3, true)], pg: [], ig: [], pipPg: [], secondaryAudio: [], secondaryVideo: [] },
  } as unknown as PlayItem;

  it('returns the main-path entry for a stream number, or null', () => {
    expect(audioEntryFor(item, 2)?.pid).toBe(0x1101);
    expect(audioEntryFor(item, 3)).toBeNull(); // sub-path
    expect(audioEntryFor(item, 4)).toBeNull();
    expect(audioEntryFor(item, null)).toBeNull();
  });
});

describe('igEntryFor', () => {
  const item = (ig: StreamEntry[]): PlayItem => ({ stn: { video: [], audio: [], pg: [], ig } }) as unknown as PlayItem;
  it('returns main-path IG entries and those of stream_type 3 and 4, but not sub-path clip IG (type 2), as _find_ig_stream', () => {
    const type = (streamType: number): StreamEntry => ({ ...entry(0x1400, CodingType.IG, streamType !== 1), streamType });
    expect(igEntryFor(item([type(1)]), 1)?.pid).toBe(0x1400);
    expect(igEntryFor(item([type(3)]), 1)?.pid).toBe(0x1400);
    expect(igEntryFor(item([type(4)]), 1)?.pid).toBe(0x1400);
    expect(igEntryFor(item([type(2)]), 1)).toBeNull();
    expect(igEntryFor(item([type(1)]), null)).toBeNull();
  });
});
