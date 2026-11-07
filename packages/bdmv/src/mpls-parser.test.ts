import { describe, expect, it } from 'vitest';
import { buildMpls } from '../../../tests/helpers/bdmv-builders';
import { ParseError } from '@seikou/bdmv/byte-reader';
import { MarkType, parseMpls } from './mpls-parser';
import { CodingType } from './stream-types';

const VIDEO = { pid: 0x1011, codingType: CodingType.AVC, format: 6, rate: 1 };

describe('parseMpls', () => {
  it('parses play items, STN streams and marks', () => {
    const mpls = parseMpls(
      buildMpls({
        playItems: [
          {
            clipId: '00001',
            inTime: 900_000,
            outTime: 1_800_000,
            video: [VIDEO],
            audio: [
              { pid: 0x1100, codingType: CodingType.LPCM, lang: 'eng' },
              { pid: 0x1101, codingType: CodingType.AC3, lang: 'fra' },
            ],
            pg: [{ pid: 0x1200, codingType: CodingType.PG, lang: 'deu' }],
            ig: [{ pid: 0x1400, codingType: CodingType.IG, lang: 'eng' }],
          },
          { clipId: '00002', inTime: 450_000, outTime: 900_000, connectionCondition: 5, video: [VIDEO] },
        ],
        marks: [
          { playItemRef: 0, time: 900_000 },
          { playItemRef: 1, time: 450_000 },
          { playItemRef: 1, time: 500_000, type: MarkType.LINK },
        ],
      }),
    );
    expect(mpls.version).toBe('0200');
    expect(mpls.playItems).toHaveLength(2);
    const [first, second] = mpls.playItems;
    expect(first.clipId).toBe('00001');
    expect(first.codecId).toBe('M2TS');
    expect(first.inTime).toBe(900_000);
    expect(first.outTime).toBe(1_800_000);
    expect(first.stn.video).toEqual([{ pid: 0x1011, codingType: CodingType.AVC, format: 6, rate: 1, lang: '', charCode: 0, subPath: false, streamType: 1, subPathId: 0, subClipId: 0 }]);
    expect(first.stn.audio.map((a) => [a.pid, a.codingType, a.lang])).toEqual([
      [0x1100, CodingType.LPCM, 'eng'],
      [0x1101, CodingType.AC3, 'fra'],
    ]);
    expect(first.stn.pg[0].lang).toBe('deu');
    expect(first.stn.ig[0].pid).toBe(0x1400);
    expect(second.connectionCondition).toBe(5);
    expect(second.stn.audio).toEqual([]);
    expect(mpls.marks).toEqual([
      { type: MarkType.ENTRY, playItemRef: 0, time: 900_000, entryEsPid: 0xffff, duration: 0 },
      { type: MarkType.ENTRY, playItemRef: 1, time: 450_000, entryEsPid: 0xffff, duration: 0 },
      { type: MarkType.LINK, playItemRef: 1, time: 500_000, entryEsPid: 0xffff, duration: 0 },
    ]);
  });

  it('skips attribute blocks by their length and flags sub-path streams', () => {
    const mpls = parseMpls(
      buildMpls({
        playItems: [
          {
            clipId: '00001',
            inTime: 0,
            outTime: 100,
            video: [{ pid: 0x1011, codingType: CodingType.HEVC, extraAttrBytes: 4 }],
            audio: [
              { pid: 0x1100, codingType: CodingType.LPCM, streamType: 2 },
              { pid: 0x1101, codingType: CodingType.LPCM },
            ],
          },
        ],
      }),
    );
    const item = mpls.playItems[0];
    expect(item.stn.video[0].codingType).toBe(CodingType.HEVC);
    expect(item.stn.audio.map((a) => [a.pid, a.subPath])).toEqual([
      [0x1100, true],
      [0x1101, false],
    ]);
  });

  it('parses multi-angle play items', () => {
    const mpls = parseMpls(
      buildMpls({ playItems: [{ clipId: '00001', inTime: 0, outTime: 100, angleClipIds: ['00002', '00003'], video: [VIDEO] }] }),
    );
    expect(mpls.playItems[0].isMultiAngle).toBe(true);
    expect(mpls.playItems[0].angleClipIds).toEqual(['00002', '00003']);
    expect(mpls.playItems[0].angleCount).toBe(3);
    expect(mpls.playItems[0].stn.video).toHaveLength(1);
  });

  it('consumes PiP PG entries so IG streams are read correctly', () => {
    const mpls = parseMpls(
      buildMpls({
        playItems: [
          {
            clipId: '00001',
            inTime: 0,
            outTime: 100,
            video: [VIDEO],
            pg: [{ pid: 0x1200, codingType: CodingType.PG, lang: 'eng' }],
            pipPg: [{ pid: 0x1a00, codingType: CodingType.PG, lang: 'eng' }],
            ig: [{ pid: 0x1400, codingType: CodingType.IG, lang: 'eng' }],
          },
        ],
      }),
    );
    const item = mpls.playItems[0];
    expect(item.stn.pg.map((p) => p.pid)).toEqual([0x1200]);
    expect(item.stn.pipPg.map((p) => p.pid)).toEqual([0x1a00]);
    expect(item.stn.ig).toHaveLength(1);
    expect(item.stn.ig[0].pid).toBe(0x1400);
    expect(item.stn.ig[0].codingType).toBe(CodingType.IG);
  });

  it('reads secondary audio and video entries past their reference lists, odd counts padded', () => {
    const sa = (pid: number): { pid: number; codingType: number } => ({ pid, codingType: CodingType.EAC3_SECONDARY });
    const sv = (pid: number): { pid: number; codingType: number } => ({ pid, codingType: CodingType.AVC });
    const mpls = parseMpls(
      buildMpls({
        playItems: [
          {
            clipId: '00001',
            inTime: 0,
            outTime: 100,
            video: [VIDEO],
            audio: [{ pid: 0x1100, codingType: CodingType.AC3, lang: 'eng' }],
            secondaryAudio: [
              { stream: sa(0x1a00), primaryAudioRefs: [0, 1, 2] },
              { stream: sa(0x1a01), primaryAudioRefs: [0, 1] },
            ],
            secondaryVideo: [
              { stream: sv(0x1b00), secondaryAudioRefs: [0], pipPgRefs: [0, 1, 2] },
              { stream: sv(0x1b01), secondaryAudioRefs: [1], pipPgRefs: [] },
            ],
          },
        ],
      }),
    );
    const { stn } = mpls.playItems[0];
    expect(stn.secondaryAudio.map((s) => [s.pid, s.codingType])).toEqual([
      [0x1a00, CodingType.EAC3_SECONDARY],
      [0x1a01, CodingType.EAC3_SECONDARY],
    ]);
    expect(stn.secondaryVideo.map((s) => [s.pid, s.codingType])).toEqual([
      [0x1b00, CodingType.AVC],
      [0x1b01, CodingType.AVC],
    ]);
    expect(stn.audio.map((s) => s.pid)).toEqual([0x1100]);
  });

  it('rejects a bad signature', () => {
    const bytes = buildMpls({ playItems: [] });
    bytes[1] = 0x41;
    expect(() => parseMpls(bytes)).toThrow(ParseError);
  });

  it('rejects a play item shorter than 18 bytes (as libbluray does)', () => {
    const bytes = buildMpls({ playItems: [{ clipId: '00001', inTime: 0, outTime: 100, video: [VIDEO] }] });
    const listPos = new DataView(bytes.buffer).getUint32(8);
    new DataView(bytes.buffer).setUint16(listPos + 10, 10); // first play item's length field
    expect(() => parseMpls(bytes)).toThrow(ParseError);
  });

  it('reads PIDs of sub-path stream types 3 and 4 and flags them', () => {
    const mpls = parseMpls(
      buildMpls({
        playItems: [
          {
            clipId: '00001',
            inTime: 0,
            outTime: 100,
            video: [VIDEO],
            audio: [
              { pid: 0x1100, codingType: CodingType.LPCM, streamType: 3 },
              { pid: 0x1101, codingType: CodingType.LPCM, streamType: 4 },
            ],
          },
        ],
      }),
    );
    expect(mpls.playItems[0].stn.audio.map((a) => [a.pid, a.subPath])).toEqual([
      [0x1100, true],
      [0x1101, true],
    ]);
  });

  it('parses sub-paths and sub play items, and the sub-path reference of STN entries', () => {
    const mpls = parseMpls(
      buildMpls({
        playItems: [
          {
            clipId: '00001',
            inTime: 0,
            outTime: 100,
            video: [VIDEO],
            ig: [
              { pid: 0x1400, codingType: CodingType.IG, streamType: 2, subPathId: 1, subClipId: 2 },
              { pid: 0x1401, codingType: CodingType.IG, streamType: 3, subPathId: 4 },
              { pid: 0x1402, codingType: CodingType.IG },
            ],
          },
        ],
        subPaths: [
          { type: 3, isRepeat: false, items: [{ clipId: '00010', inTime: 10, outTime: 90, syncPlayItemId: 0, syncPts: 5 }] },
          {
            type: 8,
            isRepeat: true,
            items: [
              { clipId: '00011', inTime: 1, outTime: 2, connectionCondition: 5, stcId: 3, extraClipIds: ['00012', '00013'] },
              { clipId: '00014', inTime: 3, outTime: 4, syncPlayItemId: 7, syncPts: 99 },
            ],
          },
        ],
      }),
    );
    expect(mpls.subPaths).toHaveLength(2);
    expect(mpls.subPaths[0]).toEqual({
      type: 3,
      isRepeat: false,
      items: [{ clipId: '00010', codecId: 'M2TS', connectionCondition: 1, isMultiClip: false, stcId: 0, inTime: 10, outTime: 90, syncPlayItemId: 0, syncPts: 5 }],
    });
    expect(mpls.subPaths[1]!.type).toBe(8);
    expect(mpls.subPaths[1]!.isRepeat).toBe(true);
    expect(mpls.subPaths[1]!.items[0]).toMatchObject({ clipId: '00011', connectionCondition: 5, isMultiClip: true, stcId: 3, inTime: 1, outTime: 2 });
    expect(mpls.subPaths[1]!.items[1]).toMatchObject({ clipId: '00014', syncPlayItemId: 7, syncPts: 99 });
    expect(mpls.playItems[0]!.stn.ig.map((e) => [e.pid, e.subPath, e.streamType, e.subPathId, e.subClipId])).toEqual([
      [0x1400, true, 2, 1, 2],
      [0x1401, true, 3, 4, 0],
      [0x1402, false, 1, 0, 0],
    ]);
  });

  it('reports no sub-paths for a playlist without any', () => {
    expect(parseMpls(buildMpls({ playItems: [{ clipId: '00001', inTime: 0, outTime: 100, video: [VIDEO] }] })).subPaths).toEqual([]);
  });

  it('accepts the file versions libbluray accepts (0100, 0200, 0240, 0300) and rejects others', () => {
    const make = (v: string): Uint8Array => {
      const bytes = buildMpls({ playItems: [{ clipId: '00001', inTime: 0, outTime: 100, video: [VIDEO] }] });
      bytes.set([...v].map((c) => c.charCodeAt(0)), 4);
      return bytes;
    };
    for (const v of ['0100', '0200', '0240', '0300']) expect(parseMpls(make(v)).version).toBe(v);
    expect(() => parseMpls(make('9999'))).toThrow(ParseError);
  });
});
