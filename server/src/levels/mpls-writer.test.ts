import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseMpls } from '@seikou/bdmv/mpls-parser';
import { buildMpls } from '../../../tests/helpers/bdmv-builders';
import type { PlayItemSpec } from '../../../tests/helpers/bdmv-builders';
import { rewriteMpls } from './mpls-writer';

const FIXTURES = join(import.meta.dirname, '../../../fixtures/synthetic');
const read = (path: string): Uint8Array => new Uint8Array(readFileSync(join(FIXTURES, path)));
const H264_1080P = { newCoding: 0x1b, newFormat: 6, newRate: 1 };

describe('rewriteMpls', () => {
  it('keeps the chosen audio, both PG streams and no secondary video (Review Focus 4)', () => {
    const bytes = read('disc-levels/BDMV/PLAYLIST/00000.mpls');
    const before = parseMpls(bytes);
    const out = parseMpls(rewriteMpls(bytes, { audioStreamNumber: 2 }, H264_1080P));
    const stn = out.playItems[0]!.stn;
    expect(stn.audio).toEqual([before.playItems[0]!.stn.audio[1]]);
    expect(stn.audio[0]!.pid).toBe(0x1101);
    expect(stn.secondaryVideo).toEqual([]);
    expect(stn.secondaryAudio).toEqual([]);
    expect(stn.pg).toEqual(before.playItems[0]!.stn.pg);
    expect(stn.pg).toHaveLength(2);
    expect(stn.video).toHaveLength(1);
    expect(stn.video[0]).toMatchObject({ pid: 0x1011, codingType: 0x1b, format: 6, rate: 1 });
    expect(out.marks).toEqual(before.marks);
    expect(out.uoMask).toEqual(before.uoMask);
  });

  it('carries the TrueHD track as its AC-3 core, keeping its channel layout and language', () => {
    const bytes = read('disc-levels/BDMV/PLAYLIST/00000.mpls');
    const truehd = parseMpls(bytes).playItems[0]!.stn.audio[0]!;
    expect(truehd.codingType).toBe(0x83);
    const out = parseMpls(rewriteMpls(bytes, { audioStreamNumber: 1 }, H264_1080P));
    expect(out.playItems[0]!.stn.audio).toEqual([{ ...truehd, codingType: 0x81, rate: 1 }]);
  });

  it('rewrites MPEG-2 1080i as H.264 1080p 29.97 (Review Focus 3)', () => {
    const bytes = read('disc-mpeg2/BDMV/PLAYLIST/00000.mpls');
    const before = parseMpls(bytes);
    const after = parseMpls(rewriteMpls(bytes, { audioStreamNumber: 1 }, { newCoding: 0x1b, newFormat: 6, newRate: 4 }));
    expect(before.playItems[0]!.stn.video[0]).toMatchObject({ codingType: 0x02, format: 4, rate: 4 });
    expect(after.playItems[0]!.stn.video[0]).toMatchObject({ codingType: 0x1b, format: 6, rate: 4 });
    expect(after.playItems[0]!.stn.audio).toEqual(before.playItems[0]!.stn.audio);
    expect(after.marks).toEqual(before.marks);
  });

  it('takes the video attributes per play item when given a function (clips of different heights)', () => {
    const item = (clipId: string): PlayItemSpec => ({
      clipId,
      inTime: 0,
      outTime: 900_000,
      video: [{ pid: 0x1011, codingType: 0x02, format: clipId === '00001' ? 4 : 3, rate: 4 }],
      audio: [{ pid: 0x1100, codingType: 0x81, lang: 'eng' }],
    });
    const bytes = buildMpls({ playItems: [item('00001'), item('00002')] });
    const seen: string[] = [];
    const out = parseMpls(
      rewriteMpls(bytes, { audioStreamNumber: 1 }, (it, i) => {
        seen.push(`${i}:${it.clipId}`);
        return it.clipId === '00001' ? { newCoding: 0x1b, newFormat: 6, newRate: 4 } : { newCoding: 0x1b, newFormat: 3, newRate: 4 };
      }),
    );
    expect(seen).toEqual(['0:00001', '1:00002']);
    expect(out.playItems.map((p) => [p.stn.video[0]!.codingType, p.stn.video[0]!.format])).toEqual([
      [0x1b, 6],
      [0x1b, 3],
    ]);
  });

  it('rewrites every play item and keeps sub paths, IG, marks and the rest of each item', () => {
    const stream = (pid: number, codingType: number, lang = 'eng') => ({ pid, codingType, lang });
    const item = (clipId: string, inTime: number): PlayItemSpec => ({
      clipId,
      inTime,
      outTime: inTime + 900_000,
      stillMode: 1,
      stillTime: 5,
      angleClipIds: clipId === '00002' ? ['00003'] : undefined,
      video: [{ pid: 0x1011, codingType: 0xea, format: 6, rate: 1 }],
      audio: [stream(0x1100, 0x86), stream(0x1101, 0x81, 'jpn'), stream(0x1102, 0x81, 'fra')],
      pg: [stream(0x1200, 0x90), stream(0x1201, 0x90, 'jpn'), stream(0x1202, 0x90, 'fra')],
      pipPg: [stream(0x1a00, 0x90)],
      ig: [stream(0x1400, 0x91)],
      secondaryAudio: [{ stream: stream(0x1a00, 0xa1), primaryAudioRefs: [1, 2, 3] }],
      secondaryVideo: [{ stream: { pid: 0x1b00, codingType: 0x1b }, secondaryAudioRefs: [1], pipPgRefs: [1] }],
    });
    const bytes = buildMpls({
      playItems: [item('00001', 0), item('00002', 1_000_000)],
      subPaths: [{ type: 3, items: [{ clipId: '00009', inTime: 0, outTime: 9000 }] }],
      marks: [{ playItemRef: 0, time: 0 }, { playItemRef: 1, time: 1_000_000 }],
    });
    const before = parseMpls(bytes);
    const after = parseMpls(rewriteMpls(bytes, { audioStreamNumber: 1 }, H264_1080P));
    expect(after.playItems).toHaveLength(2);
    after.playItems.forEach((pi, i) => {
      const b = before.playItems[i]!;
      expect({ ...pi, stn: undefined }).toEqual({ ...b, stn: undefined });
      expect(pi.stn.video[0]).toMatchObject({ codingType: 0x1b, format: 6, rate: 1 });
      expect(pi.stn.audio).toEqual([{ ...b.stn.audio[0]!, codingType: 0x82, rate: 1 }]); // DTS-HD MA as its DTS core
      expect(pi.stn.pg).toEqual(b.stn.pg);
      expect(pi.stn.pipPg).toEqual(b.stn.pipPg);
      expect(pi.stn.ig).toEqual(b.stn.ig);
      expect(pi.stn.secondaryAudio).toEqual([]);
      expect(pi.stn.secondaryVideo).toEqual([]);
    });
    expect(after.subPaths).toEqual(before.subPaths);
    expect(after.marks).toEqual(before.marks);
  });

  it('clears the HEVC dynamic-range bits when the video becomes H.264, and keeps them for HEVC', () => {
    const bytes = buildMpls({ playItems: [{ clipId: '00001', inTime: 0, outTime: 9000, video: [{ pid: 0x1011, codingType: 0x24, format: 8, rate: 1 }], audio: [{ pid: 0x1100, codingType: 0x81 }] }] });
    // set dynamic_range_type and color_space on the HEVC entry (the byte after format/rate)
    const at = findVideoAttr(bytes);
    bytes[at + 2] = 0x12;
    const h264 = rewriteMpls(bytes, { audioStreamNumber: 1 }, H264_1080P);
    expect(h264[findVideoAttr(h264) + 2]).toBe(0);
    const hevc = rewriteMpls(bytes, { audioStreamNumber: 1 }, { newCoding: 0x24, newFormat: 6, newRate: 1 });
    expect(hevc[findVideoAttr(hevc) + 2]).toBe(0x12);
  });

  it('resolves the kept audio per play item: requested, else stream 1, else none (ruling L-R3)', () => {
    const a = (pid: number, codingType: number, streamType = 1) => ({ pid, codingType, streamType, subPathId: streamType === 1 ? 0 : 0 });
    const item = (clipId: string, audio: ReturnType<typeof a>[]): PlayItemSpec => ({ clipId, inTime: 0, outTime: 9000, video: [{ pid: 0x1011, codingType: 0x1b }], audio, pg: [{ pid: 0x1200, codingType: 0x90 }] });
    const bytes = buildMpls({
      playItems: [
        item('00001', [a(0x1100, 0x83), a(0x1101, 0x81)]), // has stream 2
        item('00002', []), // a silent logo
        item('00003', [a(0x1100, 0x81)]), // fewer tracks than requested
        item('00004', [a(0x1100, 0x81), a(0x1101, 0x81, 3)]), // stream 2 is in a sub path
      ],
      subPaths: [{ type: 3, items: [{ clipId: '00009', inTime: 0, outTime: 9000 }] }],
    });
    const after = parseMpls(rewriteMpls(bytes, { audioStreamNumber: 2 }, H264_1080P));
    expect(after.playItems.map((pi) => pi.stn.audio.map((s) => [s.pid, s.codingType]))).toEqual([[[0x1101, 0x81]], [], [[0x1100, 0x81]], [[0x1100, 0x81]]]);
    expect(after.playItems.every((pi) => pi.stn.pg.length === 1 && pi.stn.video[0]!.codingType === 0x1b)).toBe(true);
  });
});

/** Offset of the first play item's primary video coding type byte. */
function findVideoAttr(b: Uint8Array): number {
  const listPos = new DataView(b.buffer, b.byteOffset).getUint32(8);
  // list header 10, item length 2, 32 fixed bytes, STN length 2 + header 14, entry (1 + 9), attr length 1
  return listPos + 10 + 2 + 32 + 16 + 10 + 1;
}
