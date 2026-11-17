// SPDX-License-Identifier: LGPL-3.0-or-later
import { CodingType } from '@seikou/bdmv/stream-types';
import { asm, buildMovieObjects, imm } from '../tests/helpers/hdmv-builders';
import { clearSegments, subtitleSegments } from '../tests/helpers/pg-builders';
import { CLIP_START_PTS, buildSyntheticDisc } from '../tests/helpers/synthetic-disc';
import { writeFixture } from './fixture-dir';
import { encodeHevcTestVideo } from './x265';

const outDir = process.argv[2];
if (!outDir) {
  console.error('usage: tsx scripts/make-hdr-disc.ts <outDir>  (fixtures/synthetic/disc-hdr)');
  process.exit(1);
}

// An HDMV disc whose one 8 s clip is HDR10: HEVC Main10, 1920x1080 at 24 fps, BT.2020 and PQ, with the CLPI marking
// dynamic_range_type 1 (HDR10) and color_space 2 (BT.2020). Title 1 plays 00000 with English PG subtitles on (a subtitle
// at 1 s, cleared at 5 s), LPCM audio and chapters every 2 s.

const SECONDS = 8;
const at = (seconds: number, segments: Uint8Array[]) => segments.map((payload) => ({ pts: CLIP_START_PTS + seconds * 90_000, payload }));

/** SET_STREAM dst: 0x8000 sets the PG stream number, 0x4000 the display flag (hdmv_vm.c _set_stream). */
const pgOn = (stream: number): Uint8Array => asm.setStream(imm(0x8000 | 0x4000 | stream), imm(0));

const movieObjects = buildMovieObjects([{ cmds: [pgOn(1), asm.playPl(imm(0))] }]);

const aus = encodeHevcTestVideo(SECONDS * 24, '1920x1080', true);

const INTERACTIVE = 1;
const files = buildSyntheticDisc({
  clips: [
    {
      clipId: '00001',
      videoAus: aus,
      keyIndices: Array.from({ length: SECONDS }, (_, i) => i * 24),
      startPts: CLIP_START_PTS,
      videoCodingType: CodingType.HEVC,
      videoDynamicRange: 1,
      videoColorSpace: 2,
      audio: CodingType.LPCM,
      pgStreams: [{ pid: 0x1200, lang: 'eng', units: [...at(1, subtitleSegments({ x: 400, y: 900, w: 120, h: 40 })), ...at(5, clearSegments(1))] }],
    },
  ],
  playlists: [{ id: '00000', clipIds: ['00001'], chapterEverySeconds: 2, videoCodingType: CodingType.HEVC }],
  movieObjects,
  index: {
    firstPlay: { kind: 'hdmv', movieObjectId: 0, playbackType: INTERACTIVE },
    topMenu: { kind: 'hdmv', movieObjectId: 0, playbackType: INTERACTIVE },
    titles: [{ kind: 'hdmv', movieObjectId: 0, playbackType: 0 }],
  },
});

writeFixture(outDir, files);
console.log(`wrote ${files.size} files to ${outDir}`);
