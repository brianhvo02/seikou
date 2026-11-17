// SPDX-License-Identifier: LGPL-3.0-or-later
import { CodingType } from '@seikou/bdmv/stream-types';
import { CLIP_START_PTS, buildSyntheticDisc, type SyntheticClipSpec } from '../tests/helpers/synthetic-disc';
import { writeFixture } from './fixture-dir';
import { execFileSync } from 'node:child_process';
import { analyzeAvc, avcPicStruct, avcTiming } from '@seikou/bdmv/codecs/h264';
import { encodeTestVideo, splitAccessUnits } from './x264';

const outDir = process.argv[2];
if (!outDir) {
  console.error('usage: tsx scripts/make-interlaced-disc.ts <outDir>  (fixtures/synthetic/disc-interlaced)');
  process.exit(1);
}

// Four 4 s playlists of 1920x1080i H.264 at 29.97, each over its own clip, with picture timing SEI on every unit and
// CLPI format 4 (1080i) and rate code 4 (29.97):
//   00000 true interlaced, top field first (two moments woven into each frame)
//   00001 true interlaced, bottom field first
//   00002 hard telecine: 23.976 progressive film through a 2:3 cadence, encoded 1080i top field first
//   00003 soft pulldown: 23.976 progressive frames flagged for 3:2 pulldown (the stream's picture timing asks for it)
// The picture is testsrc2 plus a white bar scrolling horizontally, so combing shows on the bar's edges.

const SECONDS = 4;
const SIZE = '1920x1080';
const FIELD_RATE = '60000/1001';
const FILM_RATE = '24000/1001';
const FRAME_TICKS = 3003; // 90 kHz ticks per frame at 29.97
const FILM_FRAMES = Math.round((SECONDS * 24000) / 1001);
const FRAMES = Math.round((SECONDS * 30000) / 1001);
const X264 = 'pic-struct=1';

/** A filter graph that draws the scrolling bar on the source at its own rate (`px` pixels per second), then applies `tail`. */
function graph(px: number, tail: string): string[] {
  return [
    '-filter_complex',
    `color=c=white:s=40x420:r=${tail.startsWith('interlace') ? FIELD_RATE : FILM_RATE}[bar];[0:v][bar]overlay=x='mod(t*${px}\\,1880)':y=300:shortest=1[o];[o]${tail}[v]`,
    '-map', '[v]',
  ];
}

function clip(clipId: string, videoAus: Uint8Array[], frameTicks: number[]): SyntheticClipSpec {
  const pts = frameTicks.reduce<number[]>((all, ticks, i) => (all.push(i === 0 ? CLIP_START_PTS : all[i - 1] + ticks), all), []);
  return {
    clipId,
    videoAus,
    keyIndices: videoAus.map((_, i) => i).filter((i) => i % 24 === 0),
    startPts: CLIP_START_PTS,
    pts,
    frameTicks: Math.max(...frameTicks),
    videoFormat: 4,
    videoRate: 4,
    audio: CodingType.LPCM,
  };
}

const even = (frames: number): number[] => Array.from({ length: frames }, () => FRAME_TICKS);
const tff = encodeTestVideo(FRAMES, SIZE, [...graph(900, 'interlace=scan=tff:lowpass=off'), '-crf', '30', '-x264-params', `interlaced=1:tff=1:${X264}`], FIELD_RATE);
const bff = encodeTestVideo(FRAMES, SIZE, [...graph(900, 'interlace=scan=bff:lowpass=off'), '-crf', '30', '-x264-params', `interlaced=1:bff=1:${X264}`], FIELD_RATE);
const hard = encodeTestVideo(FRAMES, SIZE, [...graph(700, 'telecine=pattern=23'), '-crf', '30', '-x264-params', `interlaced=1:tff=1:${X264}`], FILM_RATE);

/**
 * Soft pulldown needs the x264 command line, which flags each 24p frame for 3:2 pulldown (libx264 through ffmpeg
 * ignores `pulldown`): the frames stay progressive and picture timing SEI's pic_struct asks for 3, 2, 3, 2 fields.
 */
function encodeSoftPulldown(): Uint8Array[] {
  const y4m = execFileSync('ffmpeg', [
    '-v', 'error', '-f', 'lavfi', '-i', `testsrc2=size=${SIZE}:rate=${FILM_RATE}`, ...graph(700, 'null'),
    '-frames:v', String(FILM_FRAMES), '-pix_fmt', 'yuv420p', '-f', 'yuv4mpegpipe', '-',
  ], { maxBuffer: 1 << 30 });
  const h264 = execFileSync('x264', [
    '--demuxer', 'y4m', '--profile', 'high', '--level', '4.1', '--crf', '30', '--keyint', '24', '--min-keyint', '24',
    '--no-scenecut', '--bframes', '0', '--aud', '--pulldown', '32', '--pic-struct', '--output', '-', '-',
  ], { input: y4m, maxBuffer: 1 << 30, stdio: ['pipe', 'pipe', 'ignore'] });
  const aus = splitAccessUnits(new Uint8Array(h264));
  if (aus.length !== FILM_FRAMES) throw new Error(`expected ${FILM_FRAMES} access units, got ${aus.length}`);
  return aus;
}

/** Fields each pic_struct shows (H.264 table D-1). */
const FIELDS = [2, 1, 1, 2, 2, 3, 3, 4, 6];
const soft = encodeSoftPulldown();
// Each frame lasts as many fields as its pic_struct shows, accumulated and rounded so 4 frames span exactly 5 x 3003 ticks.
const softTiming = avcTiming(analyzeAvc(soft[0]).sps as Uint8Array);
const softFields = soft.map((au) => FIELDS[avcPicStruct(au, softTiming) as number]);
let acc = 0;
const filmTicks = softFields.map((f) => {
  const before = Math.round((acc * FRAME_TICKS) / 2);
  acc += f;
  return Math.round((acc * FRAME_TICKS) / 2) - before;
});
console.log(`soft pulldown pic_struct: ${soft.slice(0, 8).map((au) => avcPicStruct(au, softTiming)).join(' ')} ...; ticks: ${filmTicks.slice(0, 8).join(' ')}`);

const clips = [clip('00001', tff, even(tff.length)), clip('00002', bff, even(bff.length)), clip('00003', hard, even(hard.length)), clip('00004', soft, filmTicks)];
const files = buildSyntheticDisc({
  clips,
  playlists: clips.map((c, i) => ({ id: String(i).padStart(5, '0'), clipIds: [c.clipId], chapterEverySeconds: 2 })),
});

writeFixture(outDir, files);
console.log(`wrote ${files.size} files to ${outDir}`);
