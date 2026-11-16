// SPDX-License-Identifier: LGPL-3.0-or-later
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PesAssembler } from '@seikou/bdmv/demux/pes-assembler';
import { parseSourcePacket } from '@seikou/bdmv/demux/ts-packet';
import { findParameterSets } from '@seikou/bdmv/codecs/param-sets';
import { describe, expect, it } from 'vitest';
import { fixtureDiscFiles } from '../../../../tests/helpers/fixture-disc';
import { VIDEO_PID } from '../../../../tests/helpers/synthetic-disc';
import { displaySize, initSegment, mediaSegment, toLengthPrefixed, TIMESCALE, videoTrack } from './fmp4';
import type { Fmp4Sample } from './fmp4';

interface Box { type: string; start: number; body: number; end: number }

function boxes(data: Uint8Array, from = 0, to = data.length): Box[] {
  const v = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const out: Box[] = [];
  for (let o = from; o < to; ) {
    const size = v.getUint32(o);
    out.push({ type: String.fromCharCode(...data.subarray(o + 4, o + 8)), start: o, body: o + 8, end: o + size });
    o += size;
  }
  return out;
}

function find(data: Uint8Array, path: string[], from = 0, to = data.length, skip: Record<string, number> = {}): Box {
  const b = boxes(data, from, to).find((x) => x.type === path[0]);
  if (!b) throw new Error(`no ${path[0]}`);
  if (path.length === 1) return b;
  return find(data, path.slice(1), b.body + (skip[b.type] ?? 0), b.end, skip);
}

function accessUnits(disc: string, count: number): Uint8Array[] {
  const m2ts = fixtureDiscFiles(disc).get('BDMV/STREAM/00001.m2ts')!;
  const out: Uint8Array[] = [];
  const asm = new PesAssembler((pes) => {
    if (pes.pid === VIDEO_PID && out.length < count) out.push(pes.payload);
  });
  for (let o = 0; o + 192 <= m2ts.length && out.length < count; o += 192) {
    const pkt = parseSourcePacket(m2ts, o);
    if (pkt && pkt.pid === VIDEO_PID) asm.push(pkt);
  }
  asm.flush();
  return out.slice(0, count);
}


describe('fragmented MP4 writer', () => {
  it('writes an HEVC init segment with hvcC', () => {
    const aus = accessUnits('disc-hdr', 1);
    const track = videoTrack('hevc', findParameterSets(aus[0], 'hevc'));
    expect(track).toMatchObject({ width: 1920, height: 1080 });
    expect(track.codec).toMatch(/^hvc1\.2\./);
    const init = initSegment(track);
    expect(boxes(init).map((b) => b.type)).toEqual(['ftyp', 'moov']);
    const hvcC = find(init, ['moov', 'trak', 'mdia', 'minf', 'stbl', 'stsd', 'hvc1', 'hvcC'], 0, init.length, { stsd: 8, hvc1: 78 });
    expect(init[hvcC.body]).toBe(1);
    expect(init[hvcC.body + 1] & 0x1f).toBe(2);
    expect(init[hvcC.body + 21] & 3).toBe(3); // lengthSizeMinusOne
    expect(find(init, ['moov', 'mvex', 'trex']).type).toBe('trex');
    const mdhd = find(init, ['moov', 'trak', 'mdia', 'mdhd']);
    expect(new DataView(init.buffer, init.byteOffset).getUint32(mdhd.body + 12)).toBe(TIMESCALE);
  });

  describe('colour, HDR metadata and aspect in the sample entry', () => {
    const entryBoxes = (init: Uint8Array): { type: string; payload: number[] }[] => {
      const entry = find(init, ['moov', 'trak', 'mdia', 'minf', 'stbl', 'stsd', 'hvc1'], 0, init.length, { stsd: 8 });
      return boxes(init, entry.body + 78, entry.end).map((b) => ({ type: b.type, payload: Array.from(init.subarray(b.body, b.end)) }));
    };
    const hdrTrack = () => {
      const aus = accessUnits('disc-hdr', 1);
      return videoTrack('hevc', findParameterSets(aus[0], 'hevc'), aus[0]);
    };

    it("reads the colour, aspect and HDR SEI of the stream's first access unit", () => {
      const track = hdrTrack();
      expect(track.colour).toEqual({ primaries: 9, transfer: 16, matrix: 9, fullRange: false });
      expect(track.sar).toEqual({ width: 1, height: 1 });
      expect(track.mastering).toEqual({
        primaries: [[13250, 34500], [7500, 3000], [34000, 16000]],
        whitePoint: [15635, 16450],
        maxLuminance: 10_000_000,
        minLuminance: 1,
      });
      expect(track.light).toEqual({ maxCll: 1000, maxFall: 400 });
    });

    it('writes colr, clli, mdcv and pasp after hvcC, in the order ffmpeg writes them', () => {
      const entry = entryBoxes(initSegment(hdrTrack()));
      expect(entry.map((b) => b.type)).toEqual(['hvcC', 'colr', 'clli', 'mdcv', 'pasp']);
      expect(entry[1].payload).toEqual([...'nclx'].map((c) => c.charCodeAt(0)).concat([0, 9, 0, 16, 0, 9, 0]));
      expect(entry[2].payload).toEqual([0x03, 0xe8, 0x01, 0x90]);
      // G, B, R, white point, then max and min luminance
      expect(entry[3].payload).toEqual([
        0x33, 0xc2, 0x86, 0xc4, 0x1d, 0x4c, 0x0b, 0xb8, 0x84, 0xd0, 0x3e, 0x80, 0x3d, 0x13, 0x40, 0x42,
        0x00, 0x98, 0x96, 0x80, 0x00, 0x00, 0x00, 0x01,
      ]);
      expect(entry[4].payload).toEqual([0, 0, 0, 1, 0, 0, 0, 1]);
    });

    it('sets the full range bit, and leaves out colr, mdcv and clli when the stream has none', () => {
      const track = hdrTrack();
      const full = entryBoxes(initSegment({ ...track, colour: { primaries: 1, transfer: 1, matrix: 1, fullRange: true } }));
      expect(full.find((b) => b.type === 'colr')!.payload.slice(4)).toEqual([0, 1, 0, 1, 0, 1, 0x80]);
      const bare = entryBoxes(initSegment({ ...track, colour: null, mastering: null, light: null }));
      expect(bare.map((b) => b.type)).toEqual(['hvcC', 'pasp']);
    });

    it('writes the sample aspect ratio in pasp and the display size in tkhd', () => {
      const init = initSegment({ ...hdrTrack(), sar: { width: 4, height: 3 } });
      expect(entryBoxes(init).find((b) => b.type === 'pasp')!.payload).toEqual([0, 0, 0, 4, 0, 0, 0, 3]);
      const tkhd = find(init, ['moov', 'trak', 'tkhd']);
      const v = new DataView(init.buffer, init.byteOffset);
      expect([v.getUint32(tkhd.end - 8) / 65536, v.getUint32(tkhd.end - 4) / 65536]).toEqual([2560, 1080]);
    });

    it('gives the display size: the coded width scaled by the sample aspect ratio', () => {
      expect(displaySize({ ...hdrTrack(), sar: { width: 4, height: 3 } })).toEqual({ width: 2560, height: 1080 });
      expect(displaySize(hdrTrack())).toEqual({ width: 1920, height: 1080 });
    });
  });

  it('writes an H.264 init segment with avcC', () => {
    const aus = accessUnits('disc1', 1);
    const track = videoTrack('avc', findParameterSets(aus[0], 'avc'));
    expect(track).toMatchObject({ width: 640, height: 360 });
    expect(track.codec).toMatch(/^avc1\.64/);
    const init = initSegment(track);
    const avcC = find(init, ['moov', 'trak', 'mdia', 'minf', 'stbl', 'stsd', 'avc1', 'avcC'], 0, init.length, { stsd: 8, avc1: 78 });
    expect(Array.from(init.subarray(avcC.body, avcC.body + 2))).toEqual([1, 100]);
    expect(init[avcC.end - 4] & 3).toBe(1); // chroma_format 4:2:0
    expect(init[avcC.end - 3] & 7).toBe(0);
    expect(init[avcC.end - 1]).toBe(0);
  });

  it('writes a media segment', () => {
    const samples: Fmp4Sample[] = [
      { data: new Uint8Array([1, 2, 3]), durationTicks: 3750, ctsOffsetTicks: 7500, sync: true },
      { data: new Uint8Array([4, 5]), durationTicks: 3750, ctsOffsetTicks: -3750, sync: false },
    ];
    const seg = mediaSegment(3, 900_000, samples);
    const v = new DataView(seg.buffer, seg.byteOffset);
    const moof = find(seg, ['moof']);
    expect(find(seg, ['moof', 'mfhd']).type).toBe('mfhd');
    expect(v.getUint32(find(seg, ['moof', 'mfhd']).body + 4)).toBe(3);
    const tfdt = find(seg, ['moof', 'traf', 'tfdt']);
    expect(v.getUint32(tfdt.body + 4)).toBe(0);
    expect(v.getUint32(tfdt.body + 8)).toBe(900_000);
    const trun = find(seg, ['moof', 'traf', 'trun']);
    expect(v.getUint32(trun.body + 4)).toBe(2);
    const offset = v.getInt32(trun.body + 8);
    const mdat = boxes(seg).find((b) => b.type === 'mdat')!;
    expect(moof.start + offset).toBe(mdat.body);
    expect(Array.from(seg.subarray(mdat.body))).toEqual([1, 2, 3, 4, 5]);
    expect([v.getUint32(trun.body + 12), v.getUint32(trun.body + 16), v.getUint32(trun.body + 20), v.getInt32(trun.body + 24)]).toEqual([3750, 3, 0x02000000, 7500]);
    expect(v.getInt32(trun.body + 40)).toBe(-3750);
  });

  it('length-prefixes NAL units and drops the AUD', () => {
    const au = new Uint8Array([0, 0, 0, 1, 0x09, 0xf0, 0, 0, 1, 0x65, 0xaa, 0, 0, 1, 0x41, 0xbb]);
    expect(Array.from(toLengthPrefixed(au))).toEqual([0, 0, 0, 2, 0x65, 0xaa, 0, 0, 0, 2, 0x41, 0xbb]);
  });

  const ffprobe = spawnSync('ffprobe', ['-version']).status === 0;
  it.skipIf(!ffprobe)('is read by ffprobe as 48 HEVC frames in PQ with its mastering display and light level', () => {
    const aus = accessUnits('disc-hdr', 48);
    expect(aus.length).toBe(48);
    const track = videoTrack('hevc', findParameterSets(aus[0], 'hevc'), aus[0]);
    const samples = aus.map((au): Fmp4Sample => ({ data: toLengthPrefixed(au), durationTicks: 3750, ctsOffsetTicks: 0, sync: false }));
    samples[0].sync = true;
    samples[24].sync = true;
    const file = Uint8Array.from([
      ...initSegment(track),
      ...mediaSegment(1, 0, samples.slice(0, 24)),
      ...mediaSegment(2, 24 * 3750, samples.slice(24)),
    ]);
    const dir = mkdtempSync(join(tmpdir(), 'fmp4-'));
    try {
      writeFileSync(join(dir, 'a.mp4'), file);
      const r = spawnSync('ffprobe', ['-v', 'error', '-count_frames', '-select_streams', 'v:0', '-show_streams', '-of', 'json', join(dir, 'a.mp4')], { encoding: 'utf8' });
      const s = JSON.parse(r.stdout).streams[0];
      expect(s).toMatchObject({
        codec_name: 'hevc', width: 1920, height: 1080, pix_fmt: 'yuv420p10le', nb_read_frames: '48',
        color_range: 'tv', color_space: 'bt2020nc', color_transfer: 'smpte2084', color_primaries: 'bt2020', sample_aspect_ratio: '1:1',
      });
      const side = (type: string): Record<string, unknown> | undefined => s.side_data_list?.find((d: { side_data_type: string }) => d.side_data_type === type);
      expect(side('Mastering display metadata')).toMatchObject({ green_x: '13250/50000', red_x: '34000/50000', max_luminance: '10000000/10000', min_luminance: '1/10000' });
      expect(side('Content light level metadata')).toMatchObject({ max_content: 1000, max_average: 400 });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
