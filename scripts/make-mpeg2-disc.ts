import { CodingType } from '@seikou/bdmv/stream-types';
import { asm, buildMovieObjects, imm } from '../tests/helpers/hdmv-builders';
import { simpleMenuSegments } from '../tests/helpers/ig-builders';
import { clearSegments, subtitleSegments } from '../tests/helpers/pg-builders';
import { CLIP_START_PTS, buildSyntheticDisc, type SyntheticClipSpec } from '../tests/helpers/synthetic-disc';
import { writeFixture } from './fixture-dir';
import { encodeMpeg2TestVideo } from './mpeg2-video';

const outDir = process.argv[2];
if (!outDir) {
  console.error('usage: tsx scripts/make-mpeg2-disc.ts <outDir>  (fixtures/synthetic/disc-mpeg2-menu)');
  process.exit(1);
}

// An HDMV disc whose video is MPEG-2 (which browsers can't decode), so it plays without a picture
// (tests/e2e/unsupported-video.spec.ts). First Play loops the top menu (playlist 00001, an always-on IG menu with two
// buttons, 8x4 at (100, 100) and (100, 200), both carrying the one command JumpTitle 1); title 1 plays 00000 with
// English PG subtitles on.

const MENU_SECONDS = 6;
const FEATURE_SECONDS = 8;
const at = (seconds: number, segments: Uint8Array[]) => segments.map((payload) => ({ pts: CLIP_START_PTS + seconds * 90_000, payload }));

/** SET_STREAM dst: 0x8000 sets the PG stream number, 0x4000 the display flag (hdmv_vm.c _set_stream). */
const pgOn = (stream: number): Uint8Array => asm.setStream(imm(0x8000 | 0x4000 | stream), imm(0));

const movieObjects = buildMovieObjects([
  { cmds: [asm.playPl(imm(1)), asm.goto(0)] }, // 0: First Play and top menu, the menu playlist over and over
  { cmds: [pgOn(1), asm.playPl(imm(0))] }, // 1: title 1, subtitles on
]);

const aus = encodeMpeg2TestVideo((FEATURE_SECONDS + MENU_SECONDS) * 24, '320x180');
const clip = (clipId: string, from: number, seconds: number, extra: Partial<SyntheticClipSpec>): SyntheticClipSpec => ({
  clipId,
  videoAus: aus.slice(from * 24, (from + seconds) * 24),
  keyIndices: Array.from({ length: seconds }, (_, i) => i * 24),
  startPts: CLIP_START_PTS,
  videoCodingType: CodingType.MPEG2_VIDEO,
  audio: CodingType.LPCM,
  ...extra,
});

const INTERACTIVE = 1;
const files = buildSyntheticDisc({
  clips: [
    clip('00001', 0, FEATURE_SECONDS, {
      pgStreams: [{ pid: 0x1200, lang: 'eng', units: [...at(1, subtitleSegments({ x: 400, y: 900, w: 120, h: 40 })), ...at(5, clearSegments(1))] }],
    }),
    clip('00002', FEATURE_SECONDS, MENU_SECONDS, { igUnits: at(0, simpleMenuSegments({ cmds: [asm.jumpTitle(imm(1))] })) }),
  ],
  playlists: [
    { id: '00000', clipIds: ['00001'], chapterEverySeconds: 2, videoCodingType: CodingType.MPEG2_VIDEO },
    { id: '00001', clipIds: ['00002'], videoCodingType: CodingType.MPEG2_VIDEO },
  ],
  movieObjects,
  index: {
    firstPlay: { kind: 'hdmv', movieObjectId: 0, playbackType: INTERACTIVE },
    topMenu: { kind: 'hdmv', movieObjectId: 0, playbackType: INTERACTIVE },
    titles: [{ kind: 'hdmv', movieObjectId: 1, playbackType: 0 }],
  },
});

writeFixture(outDir, files);
console.log(`wrote ${files.size} files to ${outDir}`);
