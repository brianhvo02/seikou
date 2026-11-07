import { CodingType } from '@seikou/bdmv/stream-types';
import { asm, buildMovieObjects, imm } from '../tests/helpers/hdmv-builders';
import { clearSegments, subtitleSegments } from '../tests/helpers/pg-builders';
import { CLIP_START_PTS, buildSyntheticDisc, type SyntheticPgStream } from '../tests/helpers/synthetic-disc';
import { writeFixture } from './fixture-dir';
import { encodeTestVideo } from './x264';

const outDir = process.argv[2];
if (!outDir) {
  console.error('usage: tsx scripts/make-subs-disc.ts <outDir>');
  process.exit(1);
}

const SECONDS = 12;
const at = (seconds: number, segments: Uint8Array[]) => segments.map((payload) => ({ pts: CLIP_START_PTS + seconds * 90_000, payload }));

/** One subtitle from `from` to `to` seconds: an epoch-start set, then a clear set. Positions differ so every plane hash does. */
function line(from: number, to: number, opts: { x: number; y: number; w: number; h: number; forced?: boolean; objectId: number; n: number }) {
  return [
    ...at(from, subtitleSegments({ objectId: opts.objectId, x: opts.x, y: opts.y, w: opts.w, h: opts.h, forced: opts.forced, compositionNumber: opts.n })),
    ...at(to, clearSegments(opts.n + 1)),
  ];
}

const pgStreams: SyntheticPgStream[] = [
  {
    pid: 0x1200,
    lang: 'eng',
    units: [
      ...line(1, 3, { x: 400, y: 900, w: 120, h: 40, objectId: 0, n: 0 }),
      ...line(4, 6, { x: 600, y: 120, w: 200, h: 24, objectId: 1, n: 2, forced: true }), // a sign caption
      ...line(8, 10, { x: 420, y: 880, w: 160, h: 48, objectId: 2, n: 4 }),
    ],
  },
  {
    pid: 0x1201,
    lang: 'jpn',
    units: [
      ...line(2, 5, { x: 700, y: 940, w: 96, h: 32, objectId: 0, n: 0 }),
      ...line(7, 9, { x: 760, y: 920, w: 64, h: 56, objectId: 1, n: 2 }),
    ],
  },
];

/** SET_STREAM dst: 0x8000 sets the PG stream number, 0x4000 the display flag (hdmv_vm.c _set_stream). */
const pgOn = (stream: number): Uint8Array => asm.setStream(imm(0x8000 | 0x4000 | stream), imm(0));

const movieObjects = buildMovieObjects([
  { cmds: [pgOn(1), asm.playPl(imm(0))] }, // 0: First Play, English subtitles on
  { cmds: [] }, // 1: top menu
  { cmds: [pgOn(2), asm.playPl(imm(0))] }, // 2: title 1, Japanese subtitles on
  { cmds: [asm.playPl(imm(1))] }, // 3: title 2, the feature with subtitle stream changes masked
]);

/** Real H.264 (x264, IDR every second) so the disc also plays in Chrome (tests/e2e/subtitles.spec.ts). */
const aus = encodeTestVideo(SECONDS * 24);
const files = buildSyntheticDisc({
  clips: [{
    clipId: '00001',
    videoAus: aus,
    keyIndices: Array.from({ length: SECONDS }, (_, i) => i * 24),
    startPts: CLIP_START_PTS,
    audio: CodingType.LPCM,
    pgStreams,
  }],
  playlists: [
    { id: '00000', clipIds: ['00001'], chapterEverySeconds: 4 },
    { id: '00001', clipIds: ['00001'], chapterEverySeconds: 4, uoMask: [0, 0, 0, 0x10, 0, 0, 0, 0] }, // pgChange (bit 27)
  ],
  movieObjects,
  index: {
    firstPlay: { kind: 'hdmv', movieObjectId: 0 },
    topMenu: { kind: 'hdmv', movieObjectId: 1 },
    titles: [{ kind: 'hdmv', movieObjectId: 2 }, { kind: 'hdmv', movieObjectId: 3 }],
  },
});

writeFixture(outDir, files);
console.log(`wrote ${files.size} files to ${outDir}`);
