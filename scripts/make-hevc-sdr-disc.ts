// SPDX-License-Identifier: LGPL-3.0-or-later
import { CodingType } from '@seikou/bdmv/stream-types';
import { asm, buildMovieObjects, imm } from '../tests/helpers/hdmv-builders';
import { CLIP_START_PTS, buildSyntheticDisc } from '../tests/helpers/synthetic-disc';
import { writeFixture } from './fixture-dir';
import { encodeHevcTestVideo } from './x265';

const outDir = process.argv[2];
if (!outDir) {
  console.error('usage: tsx scripts/make-hevc-sdr-disc.ts <outDir>  (fixtures/synthetic/disc-hevc-sdr)');
  process.exit(1);
}

// An HDMV disc whose one 3 s clip is SDR HEVC (Main10 with no colour signalling), 640x360 at 24 fps, with LPCM audio and
// chapters every 2 s: a stream the element path takes only when the browser's WebCodecs can't decode HEVC.

const SECONDS = 3;
const movieObjects = buildMovieObjects([{ cmds: [asm.playPl(imm(0))] }]);

const aus = encodeHevcTestVideo(SECONDS * 24, '640x360', false);

const INTERACTIVE = 1;
const files = buildSyntheticDisc({
  clips: [
    {
      clipId: '00001',
      videoAus: aus,
      keyIndices: Array.from({ length: SECONDS }, (_, i) => i * 24),
      startPts: CLIP_START_PTS,
      videoCodingType: CodingType.HEVC,
      audio: CodingType.LPCM,
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
