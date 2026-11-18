// SPDX-License-Identifier: LGPL-3.0-or-later
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { CodingType } from '@seikou/bdmv/stream-types';
import { CLIP_START_PTS, buildSyntheticDisc, type SyntheticClipSpec } from '../tests/helpers/synthetic-disc';
import { writeFixture } from './fixture-dir';
import { splitVc1Frames } from './vc1-frames';

const outDir = process.argv[2];
if (!outDir) {
  console.error('usage: tsx scripts/make-vc1-disc.ts <outDir>  (fixtures/synthetic/disc-vc1)');
  process.exit(1);
}

// A disc whose one 6 s playlist (00000) is VC-1 Advanced Profile, 1920x1080 interlaced at 29.97, top field first: all
// 180 frames of fixtures/vc1-sample/interlaced.vc1 (CC BY 2.5, see its README), which carries no timing and is given
// 29.97. ffmpeg can't encode VC-1 and the sample has no progressive counterpart, so this is the only playlist.
// The sample has one sequence and entry point header, at its start, but a new group of pictures (an I/P field pair) every
// 60 frames. Those headers are repeated in front of frames 60 and 120, so each group is an entry point with an EP map
// entry, as a disc's would be; the headers are the only change to the sample's bytes (see NOTICE.txt).
// On Blu-ray VC-1 is stream type 0xEA, carried in PES packets with stream_id 0xFD and the stream_id_extension 0x55.

const FRAMES = 180;
const GROUP = 60;
const FRAME_TICKS = 3003;
const source = new Uint8Array(readFileSync(new URL('../fixtures/vc1-sample/interlaced.vc1', import.meta.url)));
const frames = splitVc1Frames(source);
if (frames.length !== FRAMES) throw new Error(`the sample has ${frames.length} frames, not ${FRAMES}`);
const first = frames[0]!.bytes;
/** The sequence and entry point headers at the start of the sample: everything before its first frame start code. */
const headers = first.subarray(0, first.findIndex((b, i) => i > 3 && b === 0x0d && first[i - 1] === 1 && first[i - 2] === 0 && first[i - 3] === 0) - 3);
const units = frames.map((f, i) => (i > 0 && i % GROUP === 0 ? Buffer.concat([headers, f.bytes]) : f.bytes));

const NOTICE = `The video of this disc is third-party material.
"Stumpy Lake forest in HD" by Microdac, 2008
https://archive.org/details/MicrodacStumpyLakeforestinHD
Licensed under Creative Commons Attribution 2.5 Generic (CC BY 2.5), https://creativecommons.org/licenses/by/2.5/
Changed for Seikou (2026): the video was cut without re-encoding into a VC-1 elementary stream (audio removed; see
fixtures/vc1-sample/README.md), carried in an M2TS clip of this disc with LPCM audio added, and its sequence and entry
point headers are repeated before frames ${GROUP} and ${GROUP * 2}.
`;

const clip: SyntheticClipSpec = {
  clipId: '00001',
  videoAus: units,
  keyIndices: units.flatMap((_, i) => (i % GROUP === 0 ? [i] : [])),
  startPts: CLIP_START_PTS,
  frameTicks: FRAME_TICKS,
  videoCodingType: CodingType.VC1,
  videoFormat: 4,
  videoRate: 4,
  videoStreamId: 0xfd,
  videoStreamIdExtension: 0x55,
  audio: CodingType.LPCM,
};
const files = buildSyntheticDisc({
  clips: [clip],
  playlists: [{ id: '00000', clipIds: ['00001'], chapterEverySeconds: 2, videoCodingType: CodingType.VC1 }],
});

files.set('NOTICE.txt', new TextEncoder().encode(NOTICE));
writeFixture(outDir, files);
console.log(`wrote ${files.size} files to ${outDir}`);

// The speed probe's VC-1 clip (packages/engine/wasm/video/bench/): the first half second of the sample, from its only
// sequence and entry point headers through the 15th frame, cut with no re-encode.
const BENCH = new URL('../packages/engine/wasm/video/bench/', import.meta.url).pathname;
mkdirSync(BENCH, { recursive: true });
writeFileSync(join(BENCH, 'vc1-1080i.vc1'), Buffer.concat(units.slice(0, 15)));
console.log('wrote the bench clip vc1-1080i.vc1');
