import { CodingType } from '@seikou/bdmv/stream-types';
import { CLIP_START_PTS, buildSyntheticDisc, lpcmPayload, type SyntheticAudioStream } from '../tests/helpers/synthetic-disc';
import { encodeAudio, framed, truehdUnits } from './audio-units';
import { writeFixture } from './fixture-dir';
import { encodeTestVideo } from './x264';

const outDir = process.argv[2];
if (!outDir) {
  console.error('usage: tsx scripts/make-audio-disc.ts <outDir>');
  process.exit(1);
}
const SECONDS = 12;

const ac3 = encodeAudio(['-c:a', 'ac3', '-b:a', '448k', '-f', 'ac3'], '5.1', SECONDS);
const core = encodeAudio(['-c:a', 'ac3', '-b:a', '192k', '-f', 'ac3'], 'stereo', SECONDS);
const mlp = encodeAudio(['-c:a', 'truehd', '-strict', '-2', '-f', 'truehd'], 'stereo', SECONDS);
const dts = encodeAudio(['-c:a', 'dca', '-strict', '-2', '-b:a', '768k', '-f', 'dts'], '5.1', SECONDS);

const lpcmCount = Math.ceil((SECONDS * 90_000) / 450);
const streams: SyntheticAudioStream[] = [
  { pid: 0x1100, codingType: CodingType.LPCM, lang: 'jpn', format: 3, units: Array.from({ length: lpcmCount }, (_, j) => ({ pts: CLIP_START_PTS + j * 450, payload: lpcmPayload(240, j * 240) })) },
  { pid: 0x1101, codingType: CodingType.AC3, lang: 'eng', format: 6, units: framed(ac3, 'ac3') },
  {
    pid: 0x1102,
    codingType: CodingType.TRUEHD,
    lang: 'eng',
    format: 3,
    units: [...framed(core, 'ac3', 0x76), ...truehdUnits(mlp)].sort((a, b) => a.pts - b.pts || (a.streamIdExtension === 0x76 ? -1 : 1)),
  },
  { pid: 0x1103, codingType: CodingType.DTS, lang: 'fra', format: 6, units: framed(dts, 'dts') },
];

const frames = SECONDS * 24;
const files = buildSyntheticDisc({
  clips: [{ clipId: '00001', videoAus: encodeTestVideo(frames), keyIndices: Array.from({ length: SECONDS }, (_, i) => i * 24), startPts: CLIP_START_PTS, audioStreams: streams }],
  playlists: [{ id: '00000', clipIds: ['00001'], chapterEverySeconds: 4 }],
});
writeFixture(outDir, files);
console.log(`wrote ${files.size} files to ${outDir}`);
