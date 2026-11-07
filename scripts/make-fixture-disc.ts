import { CodingType } from '@seikou/bdmv/stream-types';
import { CLIP_START_PTS, buildSyntheticDisc, type SyntheticClipSpec } from '../tests/helpers/synthetic-disc';
import { writeFixture } from './fixture-dir';
import { encodeTestVideo } from './x264';

const [outDir, ...args] = process.argv.slice(2);
if (!outDir) {
  console.error('usage: tsx scripts/make-fixture-disc.ts <outDir> [--seconds-per-clip N]');
  process.exit(1);
}
const flag = args.indexOf('--seconds-per-clip');
const secondsPerClip = flag >= 0 ? Number(args[flag + 1]) : 4;
if (!Number.isInteger(secondsPerClip) || secondsPerClip <= 0) {
  console.error(`--seconds-per-clip must be a positive whole number of seconds (got ${args[flag + 1]})`);
  process.exit(1);
}
const framesPerClip = secondsPerClip * 24;

const aus = encodeTestVideo(framesPerClip * 2);

const keyIndices = Array.from({ length: framesPerClip / 24 }, (_, i) => i * 24);
const clip = (clipId: string, from: number): SyntheticClipSpec => ({
  clipId,
  videoAus: aus.slice(from, from + framesPerClip),
  keyIndices,
  startPts: CLIP_START_PTS,
  audio: CodingType.LPCM,
});

const files = buildSyntheticDisc({
  clips: [clip('00001', 0), clip('00002', framesPerClip)],
  playlists: [
    { id: '00000', clipIds: ['00001', '00002'], chapterEverySeconds: 2 },
    { id: '00001', clipIds: ['00002'] },
  ],
});

writeFixture(outDir, files);
console.log(`wrote ${files.size} files to ${outDir}`);
