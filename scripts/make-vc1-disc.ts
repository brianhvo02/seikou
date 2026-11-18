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

// A disc whose one 4 s playlist (00000) is VC-1 Advanced Profile, 1920x1080 interlaced at 29.97, top field first: the
// first 120 frames of fixtures/vc1-sample/interlaced.vc1 (CC BY 2.5, see its README), which carries no timing and is
// given 29.97. ffmpeg can't encode VC-1 and the sample has no progressive counterpart, so this is the only playlist.
// On Blu-ray VC-1 is stream type 0xEA, carried in PES packets with stream_id 0xFD and the stream_id_extension 0x55.

const FRAMES = 120;
const FRAME_TICKS = 3003;
const source = new Uint8Array(readFileSync(new URL('../fixtures/vc1-sample/interlaced.vc1', import.meta.url)));
const frames = splitVc1Frames(source).slice(0, FRAMES);
if (frames.length !== FRAMES) throw new Error(`the sample has ${frames.length} frames, not ${FRAMES}`);

const clip: SyntheticClipSpec = {
  clipId: '00001',
  videoAus: frames.map((f) => f.bytes),
  // The sample has one entry point, at its start: the only place a decode can begin.
  keyIndices: frames.flatMap((f, i) => (f.entryPoint ? [i] : [])),
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

writeFixture(outDir, files);
console.log(`wrote ${files.size} files to ${outDir}`);

// The speed probe's VC-1 clip (packages/engine/wasm/video/bench/): the first half second of the sample, from its only
// sequence and entry point headers through the 15th frame, cut with no re-encode.
const BENCH = new URL('../packages/engine/wasm/video/bench/', import.meta.url).pathname;
mkdirSync(BENCH, { recursive: true });
writeFileSync(join(BENCH, 'vc1-1080i.vc1'), Buffer.concat(frames.slice(0, 15).map((f) => f.bytes)));
console.log('wrote the bench clip vc1-1080i.vc1');
