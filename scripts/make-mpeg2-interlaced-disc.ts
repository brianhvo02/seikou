// SPDX-License-Identifier: LGPL-3.0-or-later
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { CodingType } from '@seikou/bdmv/stream-types';
import { CLIP_START_PTS, buildSyntheticDisc, type SyntheticClipSpec } from '../tests/helpers/synthetic-disc';
import { writeFixture } from './fixture-dir';
import { splitPictures } from './mpeg2-video';
import { PULLDOWN_CYCLE, softPulldown } from './mpeg2-pulldown';

const outDir = process.argv[2];
if (!outDir) {
  console.error('usage: tsx scripts/make-mpeg2-interlaced-disc.ts <outDir>  (fixtures/synthetic/disc-mpeg2-interlaced)');
  process.exit(1);
}

// Five 4 s MPEG-2 playlists, each over its own clip (two B pictures between reference pictures, open GOPs of 12 frames, so decode order differs from presentation order and the PES headers carry DTS), with LPCM audio:
//   00000 1080i at 29.97, true interlaced, top field first (two moments woven into each frame), CLPI format 4
//   00001 1080i at 29.97, true interlaced, bottom field first
//   00002 1080i at 29.97, hard telecine of 23.976 film through a 2:3 cadence, coded interlaced, top field first
//   00003 480i at 29.97, soft pulldown: 23.976 progressive frames flagged for 3:2 pulldown (scripts/mpeg2-pulldown.ts), format 1
//   00004 1080p at 23.976, progressive, format 6
// The picture is testsrc2 plus a white bar scrolling horizontally, so combing shows on the bar's edges.

const SECONDS = 4;
const FIELD_RATE = '60000/1001';
const FILM_RATE = '24000/1001';
const FILM_FRAMES = 96;
const VIDEO_FRAMES = 120; // 4 s at 29.97
const FIELD_TICKS = 1501.5; // 90 kHz ticks per field at 29.97
const FILM_TICKS = 3753.75; // 90 kHz ticks per frame at 23.976
const GOP = 12;

/** ffmpeg's mpeg2video of `frames` frames of testsrc2 plus a scrolling bar, through `tail`; `field` marks interlaced coding. */
function encode(opts: { size: string; rate: string; px: number; tail: string; field: 'tff' | 'bff' | null; outFrames: number }): Uint8Array[] {
  const interlace = opts.field ? ['-flags', '+ilme+ildct'] : [];
  const graph =
    `color=c=white:s=40x420:r=${opts.rate}[bar];[0:v][bar]overlay=x='mod(t*${opts.px}\\,1880)':y=300:shortest=1[o];` +
    `[o]${opts.tail}[v]`;
  const es = execFileSync('ffmpeg', [
    '-v', 'error', '-f', 'lavfi', '-i', `testsrc2=size=${opts.size}:rate=${opts.rate}`, '-filter_complex', graph, '-map', '[v]',
    '-frames:v', String(opts.outFrames), ...interlace,
    '-c:v', 'mpeg2video', '-pix_fmt', 'yuv420p', '-g', String(GOP), '-bf', '2', '-q:v', '28', '-f', 'mpeg2video', '-',
  ], { maxBuffer: 1 << 30 });
  return splitInto(new Uint8Array(es), opts.outFrames);
}

function splitInto(es: Uint8Array, frames: number): Uint8Array[] {
  const aus = splitPictures(es);
  if (aus.length !== frames) throw new Error(`expected ${frames} pictures, got ${aus.length}`);
  return aus;
}

/** The picture of each unit in presentation order (counted from the clip's first), from its temporal_reference and GOP. */
function displayOrder(aus: readonly Uint8Array[]): number[] {
  let gopBase = 0;
  let inGop = 0;
  return aus.map((au) => {
    let tr = -1;
    for (let i = 0; i + 5 < au.length; i++) {
      if (au[i] !== 0 || au[i + 1] !== 0 || au[i + 2] !== 1) continue;
      if (au[i + 3] === 0xb8) {
        gopBase += inGop;
        inGop = 0;
      } else if (au[i + 3] === 0x00) {
        tr = (au[i + 4]! << 2) | (au[i + 5]! >> 6);
        break;
      }
    }
    inGop++;
    return gopBase + tr;
  });
}

/**
 * A clip of `aus` (in decode order) with the CLPI's video format and rate codes. `time(d)` is the 90 kHz time of the
 * picture shown d-th (d from -1: the slot before the first): a picture's PTS is its slot's, and its DTS the previous
 * slot's, since a picture is decoded one slot ahead of the slot it shows in at most (two B pictures between references).
 */
function clip(clipId: string, aus: Uint8Array[], time: (d: number) => number, format: number, rate: number, frameTicks: number): SyntheticClipSpec {
  const disp = displayOrder(aus);
  if (new Set(disp).size !== aus.length || Math.min(...disp) !== 0 || Math.max(...disp) !== aus.length - 1) throw new Error(`${clipId}: pictures are not a permutation of the display order`);
  return {
    clipId,
    videoAus: aus,
    keyIndices: aus.map((_, i) => i).filter((i) => aus[i]![3] === 0xb3),
    startPts: CLIP_START_PTS,
    pts: disp.map((d) => CLIP_START_PTS + time(d)),
    dts: aus.map((_, i) => CLIP_START_PTS + time(i - 1)),
    frameTicks,
    videoCodingType: CodingType.MPEG2_VIDEO,
    videoFormat: format,
    videoRate: rate,
    audio: CodingType.LPCM,
  };
}

const video = (size: string, scan: 'tff' | 'bff', px: number) =>
  encode({ size, rate: FIELD_RATE, px, tail: `interlace=scan=${scan}:lowpass=off,setfield=${scan}`, field: scan, outFrames: VIDEO_FRAMES });

const tff = video('1920x1080', 'tff', 900);
const bff = video('1920x1080', 'bff', 900);
const hard = encode({ size: '1920x1080', rate: FILM_RATE, px: 700, tail: 'telecine=pattern=23,setfield=tff', field: 'tff', outFrames: VIDEO_FRAMES });
const progressive = encode({ size: '1920x1080', rate: FILM_RATE, px: 700, tail: 'null', field: null, outFrames: FILM_FRAMES });

// Soft pulldown is coded progressive at 24000/1001 and flagged afterwards, like a DVD authoring tool does.
const softEs = execFileSync('ffmpeg', [
  '-v', 'error', '-f', 'lavfi', '-i', `testsrc2=size=720x480:rate=${FILM_RATE}`, '-frames:v', String(FILM_FRAMES),
  '-c:v', 'mpeg2video', '-pix_fmt', 'yuv420p', '-g', String(GOP), '-bf', '2', '-q:v', '20', '-f', 'mpeg2video', '-',
], { maxBuffer: 1 << 30 });
const soft = splitInto(softPulldown(new Uint8Array(softEs)), FILM_FRAMES);
// A frame shows for 2 fields, 3 with repeat_first_field (the cycle is in presentation order); times accumulate in fields
// so 4 frames span 5 x 3003 ticks.
const softTime = (d: number): number => {
  let fields = 0;
  for (let k = 0; k < d; k++) fields += PULLDOWN_CYCLE[k % PULLDOWN_CYCLE.length]!.rff ? 3 : 2;
  return Math.round((d < 0 ? -2 : fields) * FIELD_TICKS);
};

const frameTime = (d: number): number => Math.round(d * 2 * FIELD_TICKS);
const filmTime = (d: number): number => Math.round(d * FILM_TICKS);
const clips = [
  clip('00001', tff, frameTime, 4, 4, 3003),
  clip('00002', bff, frameTime, 4, 4, 3003),
  clip('00003', hard, frameTime, 4, 4, 3003),
  clip('00004', soft, softTime, 1, 4, 4505),
  clip('00005', progressive, filmTime, 6, 1, 3754),
];
const files = buildSyntheticDisc({
  clips,
  playlists: clips.map((c, i) => ({ id: String(i).padStart(5, '0'), clipIds: [c.clipId], chapterEverySeconds: 2, videoCodingType: CodingType.MPEG2_VIDEO })),
});
console.log(`${SECONDS} s playlists; picture counts ${clips.map((c) => c.videoAus.length).join(' ')}`);

writeFixture(outDir, files);
console.log(`wrote ${files.size} files to ${outDir}`);

// The speed probe's MPEG-2 clip (packages/engine/wasm/video/bench/): the first half second of playlist 00000's stream.
const BENCH = new URL('../packages/engine/wasm/video/bench/', import.meta.url).pathname;
mkdirSync(BENCH, { recursive: true });
writeFileSync(join(BENCH, 'mpeg2-1080i.m2v'), Buffer.concat(tff.slice(0, 15)));
console.log('wrote the bench clip mpeg2-1080i.m2v');
