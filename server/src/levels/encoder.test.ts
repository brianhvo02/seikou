import { execFileSync, spawn as nodeSpawn, spawnSync, type ChildProcess } from 'node:child_process';
import { createReadStream, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { EventEmitter } from 'node:events';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { afterAll, describe, expect, it } from 'vitest';
import { parseClpi } from '@seikou/bdmv/clpi-parser';
import { CodingType } from '@seikou/bdmv/stream-types';
import { analyzeAvc, avcIsInterlaced } from '@seikou/bdmv/codecs/h264';
import { PesAssembler, readTimestamp, type PesPacket } from '@seikou/bdmv/demux/pes-assembler';
import { parseSourcePacket } from '@seikou/bdmv/demux/ts-packet';
import { CLIP_START_PTS, buildSyntheticDisc } from '../../../tests/helpers/synthetic-disc';
import { KeptStreams, PesCoreFilter } from './audio-core';
import {
  ClipEncoder,
  MAX_INTERVALS_PER_RUN,
  PROBE_TIMEOUT_MS,
  deinterlaces,
  IntervalDoesNotFit,
  encodeIntervalAt,
  encodedFrameDts,
  epFramePts,
  frameTicks,
  probeScan,
  qsvBackend,
  SourceFrames,
  runWindow,
  x264Backend,
  type ClipEncoderOptions,
  type EncoderArgsInput,
  type EncoderBackend,
} from './encoder';
import { levelDefFor, planClip, type IntervalPlan, type LevelDef } from './levels';
import { IntervalCollector, remuxInterval, type EncodedPes, type IntervalSource } from './remux';
import { distortingBackend, flooredTo, shiftedBy } from './test-backends';

/** The fixtures' EP intervals as they are: their GOPs are shorter than the plan's merge threshold. */
const RAW_PLAN = { minInterval45: 0 };

const VIDEO = 0x1011;
const fixture = (disc: string): string => join(import.meta.dirname, '../../../fixtures/synthetic', disc, 'BDMV');
const clipPath = (disc: string): string => join(fixture(disc), 'STREAM/00001.m2ts');
const intervalsOf = (disc: string): IntervalPlan[] =>
  planClip(parseClpi(readFileSync(join(fixture(disc), 'CLIPINF/00001.clpi'))), levelDefFor('h264-1080', { height: 1080 }), 192_000, RAW_PLAN).intervals;

const hasX264 = spawnSync('ffmpeg', ['-hide_banner', '-encoders'], { encoding: 'utf8' }).stdout?.includes('libx264') ?? false;
/** CI installs ffmpeg: there, a missing libx264 fails these tests instead of skipping them. */
const runFfmpegTests = hasX264 || Boolean(process.env.CI);

const scratch = mkdtempSync(join(tmpdir(), 'encoder-test-'));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

function argsInput(level: LevelDef, extra: Partial<EncoderArgsInput> = {}): EncoderArgsInput {
  return {
    file: '/discs/Starfall Wanderer/BDMV/STREAM/00001.m2ts',
    startByte: 1157 * 192,
    endByte: 2326 * 192,
    keyframesPts90: [989_696, 1_079_808, 1_169_920],
    frameTicks: 3753,
    videoPid: VIDEO,
    sourceCoding: CodingType.AVC,
    level,
    interlaced: false,
    hdr: false,
    rateBps: level.targetBps,
    ...extra,
  };
}

/** One microsecond after a 23.976 frame (3753 ticks) before each EP entry. */
const KEYS = '10.954923,11.956167,12.957412';
const OUT = ['-fps_mode', 'passthrough', '-enc_time_base', '1/90000', '-mpegts_copyts', '1', '-f', 'mpegts', 'pipe:1'];
const TAIL = ['-forced_idr', '1', '-force_key_frames', KEYS, '-g', '1000', ...OUT];
const QSV_HEAD = ['-hide_banner', '-nostats', '-loglevel', 'error', '-hwaccel', 'qsv', '-hwaccel_output_format', 'qsv', '-copyts', '-c:v', 'h264_qsv'];
const FILE_IN = ['-nostdin', '-i', 'subfile,,start,222144,end,446592,,:/discs/Starfall Wanderer/BDMV/STREAM/00001.m2ts'];
const MAP = ['-map', '0:#0x1011', '-an', '-sn', '-dn'];

describe('qsvBackend arguments', () => {
  it('h264-1080', () => {
    expect(qsvBackend.binary).toBe('ffmpeg');
    expect(qsvBackend.args(argsInput(levelDefFor('h264-1080', { height: 1080 })))).toEqual([
      ...QSV_HEAD, ...FILE_IN, ...MAP,
      '-vf', 'scale_qsv=w=1920:h=1080',
      '-c:v', 'h264_qsv', '-preset', 'medium', '-b:v', '8000000', '-maxrate', '10000000', '-bufsize', '16000000',
      ...TAIL,
    ]);
  });

  it('hevc-1080', () => {
    expect(qsvBackend.args(argsInput(levelDefFor('hevc-1080', { height: 1080 })))).toEqual([
      ...QSV_HEAD, ...FILE_IN, ...MAP,
      '-vf', 'scale_qsv=w=1920:h=1080',
      '-c:v', 'hevc_qsv', '-preset', 'veryfast', '-b:v', '5000000', '-maxrate', '6250000', '-bufsize', '10000000',
      ...TAIL,
    ]);
  });

  it('a VC-1 source is decoded in software and uploaded, since the QSV VC-1 decoder drops frames, at a lower priority', () => {
    const input = argsInput(levelDefFor('phone-720', { height: 1080 }), { sourceCoding: CodingType.VC1 });
    expect(qsvBackend.args(input)).toEqual([
      '-hide_banner', '-nostats', '-loglevel', 'error', '-init_hw_device', 'qsv=hw', '-filter_hw_device', 'hw', '-copyts', '-c:v', 'vc1',
      ...FILE_IN, ...MAP,
      '-vf', 'format=nv12,hwupload=extra_hw_frames=64,scale_qsv=w=1280:h=720',
      '-c:v', 'h264_qsv', '-preset', 'medium', '-b:v', '3000000', '-maxrate', '3750000', '-bufsize', '6000000',
      ...TAIL,
    ]);
    expect(qsvBackend.nice?.(input)).toBe(10);
    expect(qsvBackend.nice?.(argsInput(levelDefFor('phone-720', { height: 1080 })))).toBe(0);
    // an interlaced VC-1 source is deinterlaced on the GPU after the upload
    expect(qsvBackend.args({ ...input, interlaced: true })).toContain('format=nv12,hwupload=extra_hw_frames=64,vpp_qsv=deinterlace=2:w=1280:h=720');
  });

  it('phone-720, and the standard-definition size for a 576-line source', () => {
    expect(qsvBackend.args(argsInput(levelDefFor('phone-720', { height: 1080 })))).toEqual([
      ...QSV_HEAD, ...FILE_IN, ...MAP,
      '-vf', 'scale_qsv=w=1280:h=720',
      '-c:v', 'h264_qsv', '-preset', 'medium', '-b:v', '3000000', '-maxrate', '3750000', '-bufsize', '6000000',
      ...TAIL,
    ]);
    expect(qsvBackend.args(argsInput(levelDefFor('phone-720', { height: 576 })))).toContain('scale_qsv=w=720:h=576');
  });

  it('hevc-1080-hdr: Main10, P010, HDR10 colour tags', () => {
    expect(qsvBackend.args(argsInput(levelDefFor('hevc-1080-hdr', { height: 2160 }), { hdr: true, sourceCoding: CodingType.HEVC }))).toEqual([
      ...QSV_HEAD.slice(0, -1), 'hevc_qsv', ...FILE_IN, ...MAP,
      '-vf', 'scale_qsv=w=1920:h=1080:format=p010',
      '-c:v', 'hevc_qsv', '-profile:v', 'main10', '-preset', 'veryfast', '-b:v', '5000000', '-maxrate', '6250000', '-bufsize', '10000000',
      '-color_primaries', 'bt2020', '-color_trc', 'smpte2084', '-colorspace', 'bt2020nc',
      ...TAIL,
    ]);
  });

  it('h264-1080-sdr: tone-mapped by vpp_qsv and tagged BT.709', () => {
    expect(qsvBackend.args(argsInput(levelDefFor('h264-1080-sdr', { height: 2160 }), { hdr: true, sourceCoding: CodingType.HEVC }))).toEqual([
      ...QSV_HEAD.slice(0, -1), 'hevc_qsv', ...FILE_IN, ...MAP,
      '-vf', 'vpp_qsv=w=1920:h=1080:format=nv12:tonemap=1:out_color_matrix=bt709:out_color_primaries=bt709:out_color_transfer=bt709',
      '-c:v', 'h264_qsv', '-preset', 'medium', '-b:v', '8000000', '-maxrate', '10000000', '-bufsize', '16000000',
      '-color_primaries', 'bt709', '-color_trc', 'bt709', '-colorspace', 'bt709',
      ...TAIL,
    ]);
  });

  it('tone-maps an HDR clip at any SDR level (one of a disc whose main clip is SDR), and tags it BT.709', () => {
    const args = qsvBackend.args(argsInput(levelDefFor('h264-1080', { height: 1080 }), { hdr: true, sourceCoding: CodingType.HEVC }));
    expect(args).toContain('vpp_qsv=w=1920:h=1080:format=nv12:tonemap=1:out_color_matrix=bt709:out_color_primaries=bt709:out_color_transfer=bt709');
    expect(args.join(' ')).toContain('-color_primaries bt709 -color_trc bt709 -colorspace bt709');
    expect(qsvBackend.args(argsInput(levelDefFor('hevc-1080', { height: 1080 }), { hdr: true, sourceCoding: CodingType.HEVC }))).toContain(
      'vpp_qsv=w=1920:h=1080:format=nv12:tonemap=1:out_color_matrix=bt709:out_color_primaries=bt709:out_color_transfer=bt709',
    );
  });

  it('asks for NV12 from an SDR HEVC source to H.264 (a 10-bit source would hand h264_qsv P010)', () => {
    expect(qsvBackend.args(argsInput(levelDefFor('h264-1080', { height: 1080 }), { sourceCoding: CodingType.HEVC }))).toContain('scale_qsv=w=1920:h=1080:format=nv12');
    expect(qsvBackend.args(argsInput(levelDefFor('h264-1080', { height: 1080 }), { sourceCoding: CodingType.HEVC, interlaced: true }))).toContain(
      'vpp_qsv=deinterlace=2:w=1920:h=1080:format=nv12',
    );
    expect(qsvBackend.args(argsInput(levelDefFor('hevc-1080', { height: 1080 }), { sourceCoding: CodingType.HEVC }))).toContain('scale_qsv=w=1920:h=1080');
  });

  it('names the QSV decoder of the source before the input', () => {
    const level = levelDefFor('h264-1080', { height: 1080 });
    const decoderOf = (sourceCoding: number): string | undefined => {
      const args = qsvBackend.args(argsInput(level, { sourceCoding }));
      return args.indexOf('-c:v') < args.indexOf('-i') ? args[args.indexOf('-c:v') + 1] : undefined;
    };
    expect(decoderOf(CodingType.AVC)).toBe('h264_qsv');
    expect(decoderOf(CodingType.HEVC)).toBe('hevc_qsv');
    expect(decoderOf(CodingType.MPEG2_VIDEO)).toBe('mpeg2_qsv');
    // VC-1 is decoded in software: the QSV VC-1 decoder drops frames
    expect(decoderOf(CodingType.VC1)).toBe('vc1');
    expect(() => qsvBackend.args(argsInput(level, { sourceCoding: CodingType.MPEG1_VIDEO }))).toThrow(/QSV decoder/);
  });

  it('deinterlaces an interlaced source with vpp_qsv (advanced, to the frame rate)', () => {
    expect(qsvBackend.args(argsInput(levelDefFor('h264-1080', { height: 1080 }), { interlaced: true }))).toContain('vpp_qsv=deinterlace=2:w=1920:h=1080');
    expect(qsvBackend.args(argsInput(levelDefFor('h264-1080-sdr', { height: 2160 }), { interlaced: true, hdr: true }))).toContain(
      'vpp_qsv=deinterlace=2:w=1920:h=1080:format=nv12:tonemap=1:out_color_matrix=bt709:out_color_primaries=bt709:out_color_transfer=bt709',
    );
  });

  it('reads stdin for a piped clip, and uses the retry rate', () => {
    const args = qsvBackend.args(argsInput(levelDefFor('h264-1080', { height: 1080 }), { file: 'pipe:0', rateBps: 6_400_000 }));
    expect(args.slice(QSV_HEAD.length, QSV_HEAD.length + 2)).toEqual(['-i', 'pipe:0']);
    expect(args).not.toContain('-nostdin');
    expect(args.slice(args.indexOf('-b:v'), args.indexOf('-b:v') + 6)).toEqual(['-b:v', '6400000', '-maxrate', '8000000', '-bufsize', '12800000']);
  });

  it('forces each keyframe one microsecond after the shortest frame time before its EP entry, never before 0', () => {
    const args = qsvBackend.args(argsInput(levelDefFor('h264-1080', { height: 1080 }), { keyframesPts90: [899_584, 90_000 * 3 + 1, 3000], frameTicks: 3003 }));
    // 896 581 and 266 998 ticks, plus a microsecond.
    expect(args[args.indexOf('-force_key_frames') + 1]).toBe('9.962012,2.966645,0.000001');
    expect(frameTicks(24_000 / 1001)).toBe(3753);
    expect(frameTicks(24)).toBe(3750);
    expect(frameTicks(30_000 / 1001)).toBe(3003);
    expect(frameTicks(60_000 / 1001)).toBe(1501);
  });
});

describe('x264Backend arguments', () => {
  it('libx264 with keyint, forced IDRs and the same rates', () => {
    expect(x264Backend.binary).toBe('ffmpeg');
    expect(x264Backend.args(argsInput(levelDefFor('h264-1080', { height: 1080 }), { interlaced: true }))).toEqual([
      '-hide_banner', '-nostats', '-loglevel', 'error', '-copyts', ...FILE_IN, ...MAP,
      '-vf', 'bwdif=mode=send_frame,scale=1920:1080',
      '-c:v', 'libx264', '-preset', 'veryfast', '-pix_fmt', 'yuv420p', '-b:v', '8000000', '-maxrate', '10000000', '-bufsize', '16000000',
      '-x264-params', 'keyint=1000', '-forced-idr', '1', '-force_key_frames', KEYS, ...OUT,
    ]);
  });

  it('refuses HEVC levels', () => {
    expect(() => x264Backend.args(argsInput(levelDefFor('hevc-1080', { height: 1080 })))).toThrow(/H\.264/);
  });
});

/** A made-up clip plan: `count` intervals of one second, 1000 source packets each. */
function fakePlan(count: number, ptsAt: (i: number) => number = (i) => 450_000 + i * 45_000): IntervalPlan[] {
  return Array.from({ length: count }, (_, i) => ({
    index: i,
    startPts45: ptsAt(i),
    endPts45: ptsAt(i) + 45_000,
    srcSpnStart: i * 1000,
    srcSpnEnd: (i + 1) * 1000,
    budgetBytes: 6144,
    spnStart: i * 32,
  }));
}

describe('runWindow', () => {
  it('bounds a run of a long clip to 300 intervals (its keyframe list stays far below the argument limit)', () => {
    const plan = fakePlan(9000); // two and a half hours
    expect(MAX_INTERVALS_PER_RUN).toBe(300);
    const { window, overrun, endSpn } = runWindow(plan, 0, [], MAX_INTERVALS_PER_RUN);
    expect(window.map((iv) => iv.index)).toEqual(Array.from({ length: 300 }, (_, i) => i));
    // The run reads one interval more, for the leading pictures of an open GOP.
    expect(overrun?.index).toBe(300);
    expect(endSpn).toBe(301_000);
    const args = x264Backend.args(argsInput(levelDefFor('h264-1080', { height: 1080 }), { keyframesPts90: window.map((iv) => iv.startPts45 * 2) }));
    expect(args.join(' ').length).toBeLessThan(8192);
    expect(runWindow(plan, 8900, [], MAX_INTERVALS_PER_RUN)).toMatchObject({ overrun: null, endSpn: 9_000_000 });
    expect(runWindow(plan, 8900, [], MAX_INTERVALS_PER_RUN).window.length).toBe(100);
    expect(runWindow(plan, 5, [], 1)).toMatchObject({ window: [plan[5]], overrun: plan[6], endSpn: 7_000 });
  });

  it('stops at the next STC sequence, its bytes ending where that sequence starts', () => {
    const plan = fakePlan(20, (i) => (i < 10 ? 450_000 + i * 45_000 : 90_000 + i * 45_000));
    const { window, overrun, endSpn } = runWindow(plan, 3, [0, 9_990], MAX_INTERVALS_PER_RUN);
    expect(window.map((iv) => iv.index)).toEqual([3, 4, 5, 6, 7, 8, 9]);
    expect(overrun).toBeNull();
    expect(endSpn).toBe(9_990);
    // A size-bounded run whose over-run interval holds the next STC's start reads only up to it.
    expect(runWindow(plan, 3, [0, 9_990], 6)).toMatchObject({ overrun: plan[9], endSpn: 9_990 });
    expect(runWindow(plan, 10, [0, 9_990], MAX_INTERVALS_PER_RUN).window.map((iv) => iv.index)).toEqual([10, 11, 12, 13, 14, 15, 16, 17, 18, 19]);
  });

  it('stops before a 33-bit PTS wrap', () => {
    const plan = fakePlan(6, (i) => (2 ** 32 - 3 * 45_000 + i * 45_000) % 2 ** 32);
    expect(runWindow(plan, 0, [], MAX_INTERVALS_PER_RUN).window.map((iv) => iv.index)).toEqual([0, 1, 2]);
    expect(runWindow(plan, 3, [], MAX_INTERVALS_PER_RUN).window.map((iv) => iv.index)).toEqual([3, 4, 5]);
  });
});

/** The payload of a whole video PES (after its optional header). */
const esOf = (pes: Uint8Array): Uint8Array => pes.subarray(9 + pes[8]!);
const ptsOf = (pes: Uint8Array): number => readTimestamp(pes, 9);

/** The PTS of the source's video PES. */
function sourceVideoPts(disc: string): number[] {
  const bytes = readFileSync(clipPath(disc));
  const out: number[] = [];
  for (let spn = 0; (spn + 1) * 192 <= bytes.length; spn++) {
    const ts = parseSourcePacket(bytes, spn * 192);
    if (!ts || ts.pid !== VIDEO || !ts.payloadUnitStart) continue;
    out.push(readTimestamp(ts.payload, 9));
  }
  return out;
}

interface Run {
  readonly intervals: Map<number, EncodedPes[]>;
  readonly lastIndex: number;
}

function encodeFrom(options: ClipEncoderOptions, from: number, backend: EncoderBackend = x264Backend): Promise<Run> {
  return new Promise((resolve, reject) => {
    const encoder = new ClipEncoder(backend, options);
    const intervals = new Map<number, EncodedPes[]>();
    encoder.on('interval', (index, video) => intervals.set(index, video));
    encoder.on('error', reject);
    encoder.on('end', (lastIndex) => resolve({ intervals, lastIndex }));
    encoder.start(from);
  });
}

/** Checks each interval against the source: an IDR at T_k, then exactly the source's frames of [T_k, T_k+1). */
function expectIntervals(disc: string, intervals: readonly IntervalPlan[], run: Run): void {
  const source = sourceVideoPts(disc).sort((a, b) => a - b);
  const frameAt = (pts45: number): number => source.find((p) => Math.floor(p / 512) * 256 === pts45)!;
  for (const [index, video] of run.intervals) {
    const plan = intervals[index]!;
    const start = frameAt(plan.startPts45);
    const next = intervals[index + 1];
    const end = next ? frameAt(next.startPts45) : plan.endPts45 * 2;
    expect(start).toBeDefined();
    const first = video[0]!.pes;
    expect(ptsOf(first)).toBe(start);
    expect(analyzeAvc(esOf(first)).idr).toBe(true);
    expect(video.slice(1).some((v) => analyzeAvc(esOf(v.pes)).idr)).toBe(false);
    expect(video.map((v) => ptsOf(v.pes)).sort((a, b) => a - b)).toEqual(source.filter((p) => p >= start && p < end));
    for (let i = 1; i < video.length; i++) expect(video[i]!.dts90).toBeGreaterThan(video[i - 1]!.dts90);
  }
}

/** A spawn that records the children it starts. */
function recordingSpawn(children: ChildProcess[], replace?: { binary: string; args: string[] }): typeof nodeSpawn {
  return ((binary: string, args: string[], options: object) => {
    const child = replace ? nodeSpawn(replace.binary, replace.args, options) : nodeSpawn(binary, args, options);
    children.push(child);
    return child;
  }) as unknown as typeof nodeSpawn;
}

describe.skipIf(!runFfmpegTests)('ClipEncoder (libx264)', () => {
  const level = levelDefFor('h264-1080', { height: 1080 });
  const base = { videoPid: VIDEO, sourceCoding: CodingType.AVC, level, interlaced: false, hdr: false, frameTicks: 3750 };

  for (const input of ['path', 'reader'] as const) {
    it(`encodes disc-levels from interval 3: intervals 3…9, each opening with an IDR at its EP entry (${input})`, async () => {
      const intervals = intervalsOf('disc-levels');
      expect(intervals.length).toBe(10);
      const path = clipPath('disc-levels');
      const run = await encodeFrom(
        { ...base, input: input === 'path' ? { path } : { read: (from, to) => createReadStream(path, { start: from, end: to === undefined ? undefined : to - 1 }) }, intervals },
        3,
      );
      expect([...run.intervals.keys()]).toEqual([3, 4, 5, 6, 7, 8, 9]);
      expect(run.lastIndex).toBe(9);
      expectIntervals('disc-levels', intervals, run);
    }, 60_000);
  }

  it('ends a run at the end of its STC sequence; the next run starts in the next one', async () => {
    const intervals = intervalsOf('disc-levels');
    // A made-up second STC sequence from interval 5's EP entry on.
    const options = { ...base, input: { path: clipPath('disc-levels') }, intervals, stcStarts: [0, intervals[5]!.srcSpnStart] };
    const first = await encodeFrom(options, 3);
    expect([...first.intervals.keys()]).toEqual([3, 4]);
    expect(first.lastIndex).toBe(4);
    const second = await encodeFrom(options, first.lastIndex + 1);
    expect([...second.intervals.keys()]).toEqual([5, 6, 7, 8, 9]);
    expectIntervals('disc-levels', intervals, first);
    expectIntervals('disc-levels', intervals, second);
  }, 60_000);

  it('ends a run after its window of intervals', async () => {
    const intervals = intervalsOf('disc-levels');
    const run = await encodeFrom({ ...base, input: { path: clipPath('disc-levels') }, intervals, maxIntervalsPerRun: 3 }, 0);
    expect([...run.intervals.keys()]).toEqual([0, 1, 2]);
    expect(run.lastIndex).toBe(2);
    expectIntervals('disc-levels', intervals, run);
  }, 60_000);

  it('deinterlaces disc-mpeg2 (1080i29.97) to progressive frames at 29.97 fps', async () => {
    const intervals = intervalsOf('disc-mpeg2');
    const run = await encodeFrom({ ...base, sourceCoding: CodingType.MPEG2_VIDEO, frameTicks: 3003, input: { path: clipPath('disc-mpeg2') }, intervals, interlaced: true }, 0);
    expect([...run.intervals.keys()]).toEqual(intervals.map((iv) => iv.index));
    for (const video of run.intervals.values()) {
      const sps = analyzeAvc(esOf(video[0]!.pes)).sps;
      expect(sps).not.toBeNull();
      expect(avcIsInterlaced(sps!)).toBe(false);
      const pts = video.map((v) => ptsOf(v.pes)).sort((a, b) => a - b);
      expect(pts.length).toBe(30); // one frame per source frame, not per field
      for (let i = 1; i < pts.length; i++) expect(pts[i]! - pts[i - 1]!).toBe(3003);
    }
  }, 60_000);

  it('stop() kills ffmpeg, and nothing is emitted after it', async () => {
    const children: ChildProcess[] = [];
    const encoder = new ClipEncoder(x264Backend, {
      ...base,
      input: { path: clipPath('disc-levels') },
      intervals: intervalsOf('disc-levels'),
      spawn: recordingSpawn(children),
    });
    const seen: number[] = [];
    let ended = false;
    await new Promise<void>((resolve, reject) => {
      encoder.on('error', reject);
      encoder.on('end', () => (ended = true));
      encoder.on('interval', (index) => {
        seen.push(index);
        if (index === 1) {
          encoder.stop();
          setTimeout(resolve, 500);
        }
      });
      encoder.start(0);
    });
    expect(seen).toEqual([0, 1]);
    expect(ended).toBe(false);
    expect(children.length).toBe(1);
    expect(children[0]!.signalCode).toBe('SIGKILL');
  }, 60_000);

  it('fails a run whose ffmpeg exits 0 before the window’s last interval', async () => {
    const intervals = intervalsOf('disc-levels');
    // ffmpeg's real output for intervals 3…9, cut in the middle, played back by a stand-in that reads its input and exits 0.
    const window = intervals.slice(3);
    const full = spawnSync(
      'ffmpeg',
      x264Backend.args({
        ...argsInput(level),
        file: clipPath('disc-levels'),
        startByte: window[0]!.srcSpnStart * 192,
        endByte: window.at(-1)!.srcSpnEnd * 192,
        keyframesPts90: await epFramePts({ path: clipPath('disc-levels') }, VIDEO, window),
        frameTicks: 3750,
      }),
      { maxBuffer: 1 << 28 },
    ).stdout;
    const cut = join(scratch, 'cut.ts');
    writeFileSync(cut, full.subarray(0, Math.floor(full.length / 2 / 188) * 188));
    for (const stand of [cut, '/dev/null']) {
      const seen: number[] = [];
      const err = await new Promise<Error>((resolve, reject) => {
        const encoder = new ClipEncoder(x264Backend, { ...base, input: { path: clipPath('disc-levels') }, intervals, spawn: recordingSpawn([], { binary: 'sh', args: ['-c', 'cat > /dev/null; cat "$0"', stand] }) });
        encoder.on('interval', (index) => seen.push(index));
        encoder.on('error', resolve);
        encoder.on('end', () => reject(new Error('ended')));
        encoder.start(3);
      });
      expect(err.message).toMatch(/ended after interval -?\d+ of a run to 9/);
      expect(seen.every((i) => i < 9)).toBe(true);
    }
  }, 60_000);
});

describe.skipIf(!runFfmpegTests)('probeScan', () => {
  it('finds disc-mpeg2 interlaced, without soft pulldown, its frames 3003 ticks apart', async () => {
    const plan = intervalsOf('disc-mpeg2');
    expect(await probeScan({ path: clipPath('disc-mpeg2') }, { startByte: plan[0]!.srcSpnStart * 192, videoPid: VIDEO })).toEqual({ interlaced: true, softPulldown: false, frameTicks: 3003 });
  });

  it('finds disc-levels progressive at 24 fps, though its CLPI says 23.976 (read through a reader)', async () => {
    const path = clipPath('disc-levels');
    expect(await probeScan({ read: (from) => createReadStream(path, { start: from }) }, { startByte: 0, videoPid: VIDEO })).toEqual({ interlaced: false, softPulldown: false, frameTicks: 3750 });
  });

  it('deinterlaces interlaced video, not soft-pulldown film', () => {
    expect(deinterlaces({ interlaced: true, softPulldown: false })).toBe(true);
    expect(deinterlaces({ interlaced: true, softPulldown: true })).toBe(false);
    expect(deinterlaces({ interlaced: false, softPulldown: true })).toBe(false);
    expect(deinterlaces({ interlaced: false, softPulldown: false })).toBe(false);
  });
});

describe.skipIf(!runFfmpegTests)('encodeIntervalAt (libx264)', () => {
  const level = levelDefFor('h264-1080', { height: 1080 });
  const intervals = intervalsOf('disc-levels');
  const bytes = readFileSync(clipPath('disc-levels'));
  /** Interval 3's source for the re-muxer. */
  const source = ((): IntervalSource => {
    const streams = new KeptStreams(new Set([0x1200, 0x1201]), new Map([[0x1100, new PesCoreFilter(CodingType.TRUEHD)]]), {
      video: { pid: VIDEO, streamType: CodingType.AVC },
    });
    const collector = new IntervalCollector(streams, { videoPid: VIDEO, pcrPid: 0x1001, intervals });
    for (let spn = 0; (spn + 1) * 192 <= bytes.length; spn++) {
      collector.push(bytes.subarray(spn * 192, (spn + 1) * 192), spn);
      if (spn >= intervals[3]!.srcSpnEnd && collector.ready(intervals[3]!)) break;
    }
    for (const plan of intervals.slice(0, 3)) collector.take(plan);
    return collector.take(intervals[3]!);
  })();

  /** The options with interval 3's budget set to `budgetBytes`, a backend that records its rates, and a counting re-muxer. */
  function setup(budgetBytes: number) {
    const plan = { ...intervals[3]!, budgetBytes };
    const rates: number[] = [];
    const backend: EncoderBackend = { id: 'x264', binary: 'ffmpeg', args: (input) => (rates.push(input.rateBps), x264Backend.args(input)) };
    const options: ClipEncoderOptions = {
      input: { path: clipPath('disc-levels') },
      intervals: intervals.map((iv) => (iv.index === 3 ? plan : iv)),
      videoPid: VIDEO,
      sourceCoding: CodingType.AVC,
      level,
      interlaced: false,
      hdr: false,
      frameTicks: 3750,
    };
    const remux = (video: readonly EncodedPes[]) =>
      remuxInterval({ plan, kept: source.kept, video, videoPid: VIDEO, videoTimeline: source.videoTimeline, pcr: null, endAts: source.endAts });
    return { options, rates, backend, remux };
  }

  it('lowers the rate by budget ÷ actual × 0.95 per try until the interval fits its budget', async () => {
    // About 2.4 Mbps for the second: 8 Mbps overflows it.
    const budget = 50 * 6144;
    const { options, rates, backend, remux } = setup(budget);
    const live = remux((await encodeFrom({ ...options, maxIntervalsPerRun: 1 }, 3)).intervals.get(3)!);
    expect('overflow' in live).toBe(true);
    const overflowBytes = (live as { overflow: number }).overflow;
    const result = await encodeIntervalAt(backend, options, 3, { rateBps: level.targetBps, overflowBytes }, remux);
    expect(rates[0]).toBe(Math.round(((level.targetBps * budget) / (budget + overflowBytes)) * 0.95));
    for (let i = 1; i < rates.length; i++) expect(rates[i]).toBeLessThan(rates[i - 1]!);
    expect(result.rateBps).toBe(rates.at(-1));
    expect(result.rateBps).toBeGreaterThanOrEqual(1_000_000);
    expect(result.bytes.length).toBe(budget);
  }, 120_000);

  it('tries once at the 1 Mbps floor and once at 250 kbps, then gives up rather than serve an oversized interval', async () => {
    const { options, rates, backend, remux } = setup(6144);
    await expect(encodeIntervalAt(backend, options, 3, { rateBps: 900_000, overflowBytes: 100_000 }, remux)).rejects.toThrow(IntervalDoesNotFit);
    expect(rates).toEqual([1_000_000, 250_000]);
  }, 60_000);

  it('hands the floor’s video to the last resort when it still overflows, and serves what that gives', async () => {
    const { options, rates, backend, remux } = setup(6144);
    const seen: number[] = [];
    const result = await encodeIntervalAt(backend, options, 3, { rateBps: 900_000, overflowBytes: 100_000 }, remux, undefined, (video) => {
      seen.push(video.length);
      return { bytes: new Uint8Array(6144) };
    });
    expect(rates).toEqual([1_000_000]);
    expect(seen).toHaveLength(1);
    expect(seen[0]).toBeGreaterThan(0);
    expect(result).toEqual({ bytes: new Uint8Array(6144), rateBps: 1_000_000 });
    // A last resort that can't fit it either: one try at 250 kbps, through the last resort too, then never served.
    const tries: number[] = [];
    rates.length = 0;
    await expect(
      encodeIntervalAt(backend, options, 3, { rateBps: 900_000, overflowBytes: 100_000 }, remux, undefined, (video) => (tries.push(video.length), null)),
    ).rejects.toThrow(/250 kbps/);
    expect(rates).toEqual([1_000_000, 250_000]);
    expect(tries).toHaveLength(2);
  }, 60_000);
});

/**
 * A clip with open GOPs: libx264 with two B-frames per P and `open-gop`, a recovery-point I-frame every 24 frames (an EP
 * entry every second). The B-frames after each I-frame in decode order are the previous GOP's last pictures in display.
 */
function openGopClip(): { path: string; intervals: IntervalPlan[]; frames: Array<{ spn: number; pts: number }> } {
  const ts = execFileSync('ffmpeg', [
    '-v', 'error', '-f', 'lavfi', '-i', 'testsrc2=size=640x360:rate=24', '-frames:v', '120',
    '-c:v', 'libx264', '-pix_fmt', 'yuv420p',
    '-x264-params', 'keyint=24:min-keyint=24:scenecut=0:bframes=2:b-adapt=0:open-gop=1:aud=1:repeat-headers=1',
    '-f', 'mpegts', '-',
  ], { maxBuffer: 1 << 28 });
  const pes: PesPacket[] = [];
  const assembler = new PesAssembler((p) => pes.push(p));
  for (let at = 0; at + 188 <= ts.length; at += 188) {
    const packet = parseSourcePacket(ts, at - 4);
    if (packet && packet.pid === 0x100) assembler.push(packet);
  }
  assembler.flush();
  const shift = CLIP_START_PTS - Math.min(...pes.map((p) => p.pts!));
  const videoAus = pes.map((p) => p.payload.slice());
  const files = buildSyntheticDisc({
    clips: [{
      clipId: '00001',
      videoAus,
      keyIndices: videoAus.flatMap((au, i) => (analyzeAvc(au).key ? [i] : [])),
      startPts: CLIP_START_PTS,
      pts: pes.map((p) => p.pts! + shift),
      dts: pes.map((p) => (p.dts ?? p.pts!) + shift),
    }],
    playlists: [{ id: '00000', clipIds: ['00001'] }],
  });
  const root = join(scratch, 'open-gop');
  for (const [name, bytes] of files) {
    mkdirSync(join(root, name, '..'), { recursive: true });
    writeFileSync(join(root, name), bytes);
  }
  const path = join(root, 'BDMV/STREAM/00001.m2ts');
  const clip = readFileSync(path);
  const frames: Array<{ spn: number; pts: number }> = [];
  for (let spn = 0; (spn + 1) * 192 <= clip.length; spn++) {
    const packet = parseSourcePacket(clip, spn * 192);
    if (packet?.pid === VIDEO && packet.payloadUnitStart) frames.push({ spn, pts: readTimestamp(packet.payload, 9) });
  }
  const clpi = parseClpi(readFileSync(join(root, 'BDMV/CLIPINF/00001.clpi')));
  return { path, intervals: planClip(clpi, levelDefFor('phone-720', { height: 360 }), 0, RAW_PLAN).intervals, frames };
}

describe.skipIf(!runFfmpegTests)('open GOPs (libx264)', () => {
  const level = levelDefFor('phone-720', { height: 360 });
  const { path, intervals, frames } = openGopClip();
  const k = 2;
  /** T_k and T_k+1: the PTS of the frames at the EP entries. */
  const at = (pts45: number): number => frames.find((f) => Math.floor(f.pts / 512) * 256 === pts45)!.pts;
  const [tk, tNext] = [at(intervals[k]!.startPts45), at(intervals[k + 1]!.startPts45)];
  const want = frames.map((f) => f.pts).filter((p) => p >= tk && p < tNext).sort((a, b) => a - b);
  const options: ClipEncoderOptions = { input: { path }, intervals, videoPid: VIDEO, sourceCoding: CodingType.AVC, level, interlaced: false, hdr: false, frameTicks: 3750 };
  const shown = (video: readonly EncodedPes[]): number[] => video.map((v) => ptsOf(v.pes)).sort((a, b) => a - b);

  it('has leading pictures: frames of interval k that lie after EP entry k+1', () => {
    expect(intervals.length).toBe(5);
    expect(want.length).toBe(24);
    expect(frames.some((f) => f.spn >= intervals[k + 1]!.srcSpnStart && f.pts < tNext)).toBe(true);
  });

  it('a window that ends at interval k keeps every frame of [T_k, T_k+1)', async () => {
    const run = await encodeFrom({ ...options, maxIntervalsPerRun: k + 1 }, 0);
    expect([...run.intervals.keys()]).toEqual([0, 1, 2]);
    expect(run.lastIndex).toBe(k);
    expect(shown(run.intervals.get(k)!)).toEqual(want);
    expect(analyzeAvc(esOf(run.intervals.get(k)![0]!.pes)).idr).toBe(true);
  }, 60_000);

  it('a retry of interval k keeps every frame of [T_k, T_k+1)', async () => {
    let video: readonly EncodedPes[] = [];
    await encodeIntervalAt(x264Backend, options, k, { rateBps: 3_000_000, overflowBytes: 1 }, (v) => {
      video = v;
      return { bytes: new Uint8Array(0) };
    });
    expect(shown(video)).toEqual(want);
    expect(analyzeAvc(esOf(video[0]!.pes)).idr).toBe(true);
  }, 60_000);
});

describe('probeScan: a stuck ffprobe', () => {
  /** A child that never answers; `kill` records its signal and then closes it, as a killed process does. */
  function stuckChild(): { spawn: typeof nodeSpawn; signals: (string | undefined)[] } {
    const signals: (string | undefined)[] = [];
    const spawn = (() => {
      const child = Object.assign(new EventEmitter(), {
        stdout: new PassThrough(),
        stderr: new PassThrough(),
        stdin: null,
        kill: (signal?: string): boolean => {
          signals.push(signal);
          setImmediate(() => child.emit('close', null, signal));
          return true;
        },
      });
      return child;
    }) as unknown as typeof nodeSpawn;
    return { spawn, signals };
  }

  it('is killed with SIGKILL after its timeout (20 s by default), and the probe fails', async () => {
    expect(PROBE_TIMEOUT_MS).toBe(20_000);
    const { spawn, signals } = stuckChild();
    const probing = probeScan({ path: '/nowhere.m2ts' }, { startByte: 0, videoPid: VIDEO, spawn, timeoutMs: 30 });
    await expect(probing).rejects.toThrow(/timed out/);
    expect(signals).toEqual(['SIGKILL']);
  });

  it('is killed when its signal aborts (the service closes)', async () => {
    const { spawn, signals } = stuckChild();
    const controller = new AbortController();
    const probing = probeScan({ path: '/nowhere.m2ts' }, { startByte: 0, videoPid: VIDEO, spawn, signal: controller.signal });
    controller.abort();
    await expect(probing).rejects.toThrow();
    expect(signals).toEqual(['SIGKILL']);
  });
});

describe('encodeIntervalAt: tied to its run', () => {
  it('kills its ffmpeg and rejects when the run’s signal aborts', async () => {
    const signals: (string | undefined)[] = [];
    let spawned!: () => void;
    const started = new Promise<void>((resolve) => (spawned = resolve));
    const spawn = (() => {
      spawned();
      const child = Object.assign(new EventEmitter(), {
        stdout: new PassThrough(),
        stderr: new PassThrough(),
        stdin: new PassThrough().resume(),
        kill: (signal?: string): boolean => {
          signals.push(signal);
          setImmediate(() => child.emit('close', null, signal));
          return true;
        },
      });
      return child;
    }) as unknown as typeof nodeSpawn;
    const intervals = intervalsOf('disc-levels');
    const level = levelDefFor('h264-1080', { height: 1080 });
    const options: ClipEncoderOptions = { input: { path: clipPath('disc-levels') }, intervals, videoPid: VIDEO, sourceCoding: CodingType.AVC, level, interlaced: false, hdr: false, frameTicks: 3750, spawn };
    const controller = new AbortController();
    const encoding = encodeIntervalAt(x264Backend, options, 3, { rateBps: level.targetBps, overflowBytes: 1000 }, () => ({ overflow: 1 }), controller.signal);
    const settled = encoding.catch((e: unknown) => e);
    await started;
    controller.abort();
    expect(await settled).toBeInstanceOf(Error);
    expect(signals).toContain('SIGKILL');
  });
});

describe('ClipEncoder: the encoder process priority', () => {
  it("lowers its ffmpeg's priority by the backend's nice value, and leaves it alone at 0", async () => {
    const reniced: Array<[number, number]> = [];
    let spawned: () => void = () => undefined;
    const spawn = (() => {
      setImmediate(() => spawned());
      const child = Object.assign(new EventEmitter(), {
        pid: 4242,
        stdout: new PassThrough(),
        stderr: new PassThrough(),
        stdin: new PassThrough().resume(),
        kill: (): boolean => {
          setImmediate(() => child.emit('close', null, 'SIGKILL'));
          return true;
        },
      });
      return child;
    }) as unknown as typeof nodeSpawn;
    const intervals = intervalsOf('disc-levels');
    const level = levelDefFor('h264-1080', { height: 1080 });
    const base: ClipEncoderOptions = { input: { path: clipPath('disc-levels') }, intervals, videoPid: VIDEO, sourceCoding: CodingType.AVC, level, interlaced: false, hdr: false, frameTicks: 3750, spawn, setPriority: (pid, nice) => reniced.push([pid, nice]) };
    const niced: EncoderBackend = { ...x264Backend, nice: () => 10 };
    for (const [backend, expected] of [[niced, [[4242, 10]]], [x264Backend, []]] as const) {
      reniced.length = 0;
      const encoder = new ClipEncoder(backend, base);
      encoder.on('error', () => undefined);
      const started = new Promise<void>((resolve) => (spawned = resolve));
      encoder.start(0);
      await started;
      expect(reniced).toEqual(expected);
      encoder.stop();
    }
  });
});

describe('encodedFrameDts', () => {
  it("keeps the encoder's own DTS, which stays at or before the restored PTS, where per-frame shifts would cross them", () => {
    // A VC-1 film at 23.976p through jellyfin-ffmpeg's QSV (a real disc's numbers): the decoder dropped two source frames,
    // the encoder squeezed its DTS to 1-tick steps there, and the frames' PTS restore by 1263, 1263 and 1261 ticks.
    const frames = [
      { encPts: 1133633, encDts: 1114864, sourcePts: 1134896 },
      { encPts: 1118618, encDts: 1114865, sourcePts: 1119881 },
      { encPts: 1114866, encDts: 1114866, sourcePts: 1116127 },
      { encPts: 1122371, encDts: 1118617, sourcePts: 1123635 },
    ];
    let last = -Infinity;
    const out = frames.map((f) => (last = encodedFrameDts(f.encDts, f.sourcePts, last)));
    expect(out).toEqual([1114864, 1114865, 1114866, 1118617]);
    out.forEach((dts, i) => expect(dts).toBeLessThanOrEqual(frames[i]!.sourcePts));
  });

  it('decodes a frame whose PES has no DTS at its restored PTS', () => {
    expect(encodedFrameDts(null, 1059159, 1050000)).toBe(1059159);
  });

  it('moves a DTS that would repeat the last one a tick on, and refuses one that would pass its PTS', () => {
    expect(encodedFrameDts(100, 200, 100)).toBe(101);
    expect(() => encodedFrameDts(100, 100, 100)).toThrow(/at most its PTS/);
  });
});

describe('SourceFrames', () => {
  const G = 90_000 / (24_000 / 1001); // 3753.75
  /** 23.976 film from PTS 378 000 000, I P B B P B B …: [pts, dts] in decode order, decoded a frame ahead. */
  function film(count: number): Array<[number, number]> {
    const pts = (k: number): number => 378_000_000 + Math.round(k * G);
    const order: number[] = [0];
    for (let k = 3; k < count; k += 3) order.push(k, k - 2, k - 1);
    return order.map((k, i) => [pts(k), pts(i - 1)]);
  }
  const all = (frames: SourceFrames, list: Array<[number, number]>): void => list.forEach(([p, d]) => frames.add(p, d));

  for (const [name, move] of [
    ['unmoved', (p: number) => p],
    ['1129 ticks earlier', (p: number) => p - 1129],
    ['a frame less a tick earlier (3752)', (p: number) => p - 3752],
    ['down to the 23.976 grid', (p: number) => Math.floor(p / G) * G],
  ] as const) {
    it(`gives encoded frames ${name} their source PTS, whatever order they come in`, () => {
      const source = film(30);
      const frames = new SourceFrames(VIDEO, 3753);
      all(frames, source);
      frames.end();
      const encoded = source.map(([p]) => p).sort((a, b) => b - a); // any order: here the reverse
      expect(encoded.map((p) => frames.match(Math.floor(move(p))))).toEqual(encoded);
    });
  }

  it('waits until a source PES decodes after the frame (no later one can show before it), or the source ends', () => {
    const source = film(9);
    const frames = new SourceFrames(VIDEO, 3753);
    const [i0, p3, b1] = source;
    frames.add(...i0!);
    frames.add(...p3!);
    // B1 shows before P3 and isn't in yet: an encoded frame between I0 and P3 can't be placed.
    expect(frames.match(b1![0] - 1129)).toBeNull();
    frames.add(...b1!);
    expect(frames.match(i0![0] - 1129)).toBe(i0![0]); // B1's DTS is past I0
    expect(frames.match(b1![0] - 1129)).toBeNull(); // nothing yet decodes after B1
    for (const pes of source.slice(3)) frames.add(...pes);
    expect(frames.match(b1![0] - 1129)).toBe(b1![0]);
    const last = Math.max(...source.map(([p]) => p));
    expect(frames.match(last)).toBeNull();
    frames.end();
    expect(frames.match(last)).toBe(last);
  });

  it('takes a field pair (two PES half a frame apart) as one frame, at its first field', () => {
    const frames = new SourceFrames(VIDEO, 3003);
    for (let k = 0; k < 6; k++) {
      frames.add(900_000 + k * 3003, 900_000 + k * 3003 - 1501);
      frames.add(900_000 + k * 3003 + 1501, 900_000 + k * 3003);
    }
    frames.end();
    // 2000 ticks earlier: past the previous pair's second field, still on this pair.
    expect([0, 1, 2, 3, 4, 5].map((k) => frames.match(900_000 + k * 3003 - 2000))).toEqual([0, 1, 2, 3, 4, 5].map((k) => 900_000 + k * 3003));
  });

  it('fails when two encoded frames are one source frame, or one has no source frame', () => {
    const frames = new SourceFrames(VIDEO, 3753);
    all(frames, film(6));
    frames.end();
    expect(frames.match(378_000_000)).toBe(378_000_000);
    expect(() => frames.match(378_000_000 - 100)).toThrow(/two encoded frames/);
    expect(() => frames.match(379_000_000)).toThrow(/no source frame/);
  });
});

describe.skipIf(!runFfmpegTests)('a build that moves PTS before the encoder (libx264 behind setpts)', () => {
  const level = levelDefFor('h264-1080', { height: 1080 });
  const discs = [
    { disc: 'disc-levels', sourceCoding: CodingType.AVC, interlaced: false, frameTicks: 3750, moves: [shiftedBy(0), shiftedBy(1129), shiftedBy(3749)] },
    { disc: 'disc-mpeg2', sourceCoding: CodingType.MPEG2_VIDEO, interlaced: true, frameTicks: 3003, moves: [shiftedBy(0), shiftedBy(1129), shiftedBy(3002), flooredTo('30000/1001')] },
  ];
  const optionsFor = (d: (typeof discs)[number]): ClipEncoderOptions => ({
    input: { path: clipPath(d.disc) },
    intervals: intervalsOf(d.disc),
    videoPid: VIDEO,
    sourceCoding: d.sourceCoding,
    level,
    interlaced: d.interlaced,
    hdr: false,
    frameTicks: d.frameTicks,
  });
  const decodeOrderOk = (video: readonly EncodedPes[]): void => {
    for (const v of video) expect(v.dts90).toBeLessThanOrEqual(ptsOf(v.pes));
  };

  it('really moves them: ffmpeg’s output is off the source by the shift, its first frame 1129 ticks early', async () => {
    const intervals = intervalsOf('disc-levels');
    const window = intervals.slice(3, 5);
    const keys = await epFramePts({ path: clipPath('disc-levels') }, VIDEO, window);
    const input = { ...argsInput(level), file: clipPath('disc-levels'), startByte: window[0]!.srcSpnStart * 192, endByte: window[1]!.srcSpnEnd * 192, keyframesPts90: keys, frameTicks: 3750 };
    const out = spawnSync('ffmpeg', distortingBackend(shiftedBy(1129)).args(input), { maxBuffer: 1 << 28 }).stdout;
    const pts: number[] = [];
    for (let at = 0; at + 188 <= out.length; at += 188) {
      const ts = parseSourcePacket(out, at - 4);
      if (ts?.payloadUnitStart && ts.payload[0] === 0 && ts.payload[3] === 0xe0) pts.push(readTimestamp(ts.payload, 9));
    }
    expect(Math.min(...pts)).toBe(keys[0]! - 1129);
  }, 60_000);

  for (const d of discs) {
    for (const move of d.moves) {
      it(`ClipEncoder on ${d.disc} (${move}): every interval opens with an IDR at its EP entry, and its PTS are the source's`, async () => {
        const options = optionsFor(d);
        const run = await encodeFrom(options, 0, distortingBackend(move));
        expect([...run.intervals.keys()]).toEqual(options.intervals.map((iv) => iv.index));
        expectIntervals(d.disc, options.intervals, run);
        for (const video of run.intervals.values()) decodeOrderOk(video);
      }, 60_000);
    }

    it(`encodeIntervalAt on ${d.disc}: the retry's PTS are the source's too`, async () => {
      const options = optionsFor(d);
      for (const move of d.moves.slice(1, 3)) {
        let video: EncodedPes[] = [];
        await encodeIntervalAt(distortingBackend(move), options, 1, { rateBps: 3_000_000, overflowBytes: 1 }, (v) => {
          video = [...v];
          return { bytes: new Uint8Array(0) };
        });
        expectIntervals(d.disc, options.intervals, { intervals: new Map([[1, video]]), lastIndex: 1 });
        decodeOrderOk(video);
      }
    }, 60_000);
  }

  it('keeps an open GOP’s leading pictures, B-frames reordered, 1129 ticks early', async () => {
    const { path, intervals, frames } = openGopClip();
    const k = 2;
    const at = (pts45: number): number => frames.find((f) => Math.floor(f.pts / 512) * 256 === pts45)!.pts;
    const want = frames.map((f) => f.pts).filter((p) => p >= at(intervals[k]!.startPts45) && p < at(intervals[k + 1]!.startPts45)).sort((a, b) => a - b);
    const options: ClipEncoderOptions = { input: { path }, intervals, videoPid: VIDEO, sourceCoding: CodingType.AVC, level: levelDefFor('phone-720', { height: 360 }), interlaced: false, hdr: false, frameTicks: 3750 };
    const run = await encodeFrom({ ...options, maxIntervalsPerRun: k + 1 }, 0, distortingBackend(shiftedBy(1129)));
    const video = run.intervals.get(k)!;
    expect(video.map((v) => ptsOf(v.pes)).sort((a, b) => a - b)).toEqual(want);
    expect(analyzeAvc(esOf(video[0]!.pes)).idr).toBe(true);
    decodeOrderOk(video);
  }, 60_000);
});
