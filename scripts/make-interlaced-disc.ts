// SPDX-License-Identifier: LGPL-3.0-or-later
import { CodingType } from '@seikou/bdmv/stream-types';
import { CLIP_START_PTS, buildSyntheticDisc, type SyntheticClipSpec } from '../tests/helpers/synthetic-disc';
import { writeFixture } from './fixture-dir';
import { execFileSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { gzipSync } from 'node:zlib';
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

// The deinterlacing references beside the disc (fixtures/synthetic/deinterlace-ref): cropped 8-bit luma, frames one
// after another, gzipped, for the CPU references' tests. Frames are decoded from the access units above with ffmpeg and
// kept as yuv420p until the luma is taken, so no conversion touches the values; the crop keeps even rows on top.
//   video.y.gz         playlist 00000's frames 0-5 (top field first video, its bar crossing the crop)
//   video-bwdif.y.gz   ffmpeg bwdif=mode=send_field:parity=tff:deint=all over those frames (cropped first): the
//                      pictures of frames 0-4, top field's then bottom field's for each (frame 0's top field is
//                      the stream's first, which has no previous frame)
//   telecine.y.gz      playlist 00002's frames 0-10 (hard 3:2, two cycles and the frame after)
//   telecine-film.y.gz the 24p film frames 0-7 that 00002 telecines (its first two cycles), before encoding
// refs.json gives each file's size and frame count.
const VIDEO_CROP = { width: 1920, height: 320, x: 0, y: 160 };
const TELECINE_CROP = { width: 512, height: 256, x: 0, y: 256 };

/** The luma of each yuv420p frame ffmpeg writes for `args` (input options first), `width` x `height` a frame. */
function lumaFrames(args: string[], width: number, height: number, frames: number, input?: Uint8Array): Uint8Array {
  const raw = execFileSync('ffmpeg', ['-v', 'error', ...args, '-frames:v', String(frames), '-pix_fmt', 'yuv420p', '-f', 'rawvideo', '-'], {
    input,
    maxBuffer: 1 << 30,
  });
  const frameBytes = (width * height * 3) / 2;
  if (raw.length !== frames * frameBytes) throw new Error(`expected ${frames} frames of ${width}x${height}, got ${raw.length} bytes`);
  const out = new Uint8Array(frames * width * height);
  for (let i = 0; i < frames; i++) out.set(raw.subarray(i * frameBytes, i * frameBytes + width * height), i * width * height);
  return out;
}

const elementary = (aus: readonly Uint8Array[]): Uint8Array => Buffer.concat(aus);
const cropOf = (c: typeof VIDEO_CROP): string => `crop=${c.width}:${c.height}:${c.x}:${c.y}`;
const fromH264 = ['-f', 'h264', '-i', '-'];
const BWDIF = 'bwdif=mode=send_field:parity=tff:deint=all';
const v = VIDEO_CROP;
const t = TELECINE_CROP;
const videoFrames = lumaFrames([...fromH264, '-vf', cropOf(v)], v.width, v.height, 6, elementary(tff.slice(0, 7)));
const bwdif = lumaFrames([...fromH264, '-vf', `${cropOf(v)},${BWDIF}`], v.width, v.height, 10, elementary(tff.slice(0, 7)));
const telecineFrames = lumaFrames([...fromH264, '-vf', cropOf(t)], t.width, t.height, 11, elementary(hard.slice(0, 12)));
const film = lumaFrames(
  ['-f', 'lavfi', '-i', `testsrc2=size=${SIZE}:rate=${FILM_RATE}`, ...graph(700, cropOf(t))],
  t.width,
  t.height,
  8,
);
const refs = {
  video: { file: 'video.y.gz', playlist: '00000', ...v, frames: 6 },
  videoBwdif: { file: 'video-bwdif.y.gz', playlist: '00000', ...v, frames: 10, of: 'frames 0-4, top field then bottom field' },
  telecine: { file: 'telecine.y.gz', playlist: '00002', ...t, frames: 11 },
  telecineFilm: { file: 'telecine-film.y.gz', playlist: '00002', ...t, frames: 8 },
};
const refDir = join(dirname(outDir), 'deinterlace-ref');
writeFixture(refDir, new Map([
  ['refs.json', new TextEncoder().encode(`${JSON.stringify(refs, null, 2)}\n`)],
  ['video.y.gz', gzipSync(videoFrames, { level: 9 })],
  ['video-bwdif.y.gz', gzipSync(bwdif, { level: 9 })],
  ['telecine.y.gz', gzipSync(telecineFrames, { level: 9 })],
  ['telecine-film.y.gz', gzipSync(film, { level: 9 })],
]));
console.log(`wrote the deinterlacing references to ${refDir}`);
