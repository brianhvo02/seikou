import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { parseClpi } from '@seikou/bdmv/clpi-parser';
import { parseMpls } from '@seikou/bdmv/mpls-parser';
import { CodingType } from '@seikou/bdmv/stream-types';

const read = (disc: string, path: string): Uint8Array => new Uint8Array(readFileSync(`fixtures/synthetic/${disc}/BDMV/${path}`));

describe('disc-mpeg2', () => {
  const clpi = parseClpi(read('disc-mpeg2', 'CLIPINF/00001.clpi'));
  const mpls = parseMpls(read('disc-mpeg2', 'PLAYLIST/00000.mpls'));

  it('lists MPEG-2 video and one AC-3 track', () => {
    expect(clpi.programs[0].streams.map((s) => s.codingType)).toEqual([CodingType.MPEG2_VIDEO, CodingType.AC3]);
    expect(clpi.programs[0].streams[0]).toMatchObject({ format: 4, rate: 4 });
  });

  it('has an EP entry about every 1.001 s', () => {
    const entries = clpi.epMaps[0].entries;
    expect(Math.abs(entries.length - 10)).toBeLessThanOrEqual(1);
    for (let i = 1; i < entries.length; i++) expect((entries[i].pts - entries[i - 1].pts) / 45_000).toBeCloseTo(1.001, 2);
  });

  it('lists the same streams in the STN', () => {
    const stn = mpls.playItems[0].stn;
    expect(stn.video.map((s) => s.codingType)).toEqual([CodingType.MPEG2_VIDEO]);
    expect(stn.audio.map((s) => s.codingType)).toEqual([CodingType.AC3]);
  });
});

describe('disc-levels', () => {
  const clpi = parseClpi(read('disc-levels', 'CLIPINF/00001.clpi'));
  const mpls = parseMpls(read('disc-levels', 'PLAYLIST/00000.mpls'));

  it('lists every stream in the CLPI', () => {
    expect(clpi.programs[0].streams.map((s) => [s.pid, s.codingType])).toEqual([
      [0x1011, CodingType.AVC],
      [0x1b00, CodingType.AVC],
      [0x1100, CodingType.TRUEHD],
      [0x1101, CodingType.AC3],
      [0x1200, CodingType.PG],
      [0x1201, CodingType.PG],
    ]);
  });

  it('carries packets on the secondary video PID', () => {
    const m2ts = read('disc-levels', 'STREAM/00001.m2ts');
    let packets = 0;
    for (let at = 0; at + 192 <= m2ts.length; at += 192) if (((m2ts[at + 5] & 0x1f) << 8 | m2ts[at + 6]) === 0x1b00) packets++;
    expect(packets).toBeGreaterThan(10);
  });

  it('has an EP entry per second', () => {
    expect(Math.abs(clpi.epMaps[0].entries.length - 10)).toBeLessThanOrEqual(1);
  });

  it('lists the STN entries', () => {
    const stn = mpls.playItems[0].stn;
    expect(stn.video.map((s) => s.codingType)).toEqual([CodingType.AVC]);
    expect(stn.audio.map((s) => [s.pid, s.codingType, s.lang])).toEqual([[0x1100, CodingType.TRUEHD, 'eng'], [0x1101, CodingType.AC3, 'eng']]);
    expect(stn.secondaryVideo.map((s) => s.pid)).toEqual([0x1b00]);
    expect(stn.pg.map((s) => [s.pid, s.lang])).toEqual([[0x1200, 'eng'], [0x1201, 'jpn']]);
  });
});
