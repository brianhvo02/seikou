// SPDX-License-Identifier: LGPL-3.0-or-later
import { CodingType } from '@seikou/bdmv/stream-types';
import { CLIP_START_PTS, buildSyntheticDisc, type SyntheticClipSpec } from '../tests/helpers/synthetic-disc';
import { writeFixture } from './fixture-dir';
import { encodeTestVideo } from './x264';

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
// 24p coded frames at 90 kHz: 3753.75 ticks each, rounded cumulatively so the timeline doesn't drift.
const filmTicks = Array.from({ length: FILM_FRAMES }, (_, i) => Math.round(((i + 1) * 90000 * 1001) / 24000) - Math.round((i * 90000 * 1001) / 24000));

const tff = encodeTestVideo(FRAMES, SIZE, [...graph(900, 'interlace=scan=tff:lowpass=off'), '-crf', '30', '-x264-params', `interlaced=1:tff=1:${X264}`], FIELD_RATE);
const bff = encodeTestVideo(FRAMES, SIZE, [...graph(900, 'interlace=scan=bff:lowpass=off'), '-crf', '30', '-x264-params', `interlaced=1:bff=1:${X264}`], FIELD_RATE);
const hard = encodeTestVideo(FRAMES, SIZE, [...graph(700, 'telecine=pattern=23'), '-crf', '30', '-x264-params', `interlaced=1:tff=1:${X264}`], FILM_RATE);
const soft = encodeTestVideo(FILM_FRAMES, SIZE, [...graph(700, 'null'), '-crf', '30', '-x264-params', `pulldown=32:${X264}`], FILM_RATE);

const clips = [clip('00001', tff, even(tff.length)), clip('00002', bff, even(bff.length)), clip('00003', hard, even(hard.length)), clip('00004', soft, filmTicks)];
const files = buildSyntheticDisc({
  clips,
  playlists: clips.map((c, i) => ({ id: String(i).padStart(5, '0'), clipIds: [c.clipId], chapterEverySeconds: 2 })),
});

writeFixture(outDir, files);
console.log(`wrote ${files.size} files to ${outDir}`);
