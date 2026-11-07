import { readFileSync } from 'node:fs';
import { CodingType } from '@seikou/bdmv/stream-types';
import { buildIndex } from '../tests/helpers/bdmv-builders';
import { buildBdjo } from '../tests/helpers/bdjo-builder';
import { CLIP_START_PTS, buildSyntheticDisc } from '../tests/helpers/synthetic-disc';
import { writeFixture } from './fixture-dir';
import { encodeTestVideo } from './x264';

const outDir = process.argv[2];
if (!outDir) {
  console.error('usage: tsx scripts/make-bdj-disc.ts <outDir>');
  process.exit(1);
}

// The xlets' jar is built by tools/bdj-classlib (npm run bdj-classlib:build) from tests/bdj/xlets/src.
const jar = new Uint8Array(readFileSync(new URL('../tests/bdj/xlets/00000.jar', import.meta.url)));

const ORG_ID = 0x7fff0001;
const KEY_PLAY = 0x80000000; // VK_PLAY in the key interest table
const BDJ_INTERACTIVE = 3;

// Real H.264 (x264, IDR every second) so the disc also plays in Chrome (tests/e2e/bdj.spec.ts).
const files = buildSyntheticDisc({
  clips: [{ clipId: '00000', videoAus: encodeTestVideo(2 * 24), keyIndices: [0, 24], startPts: CLIP_START_PTS, audio: CodingType.LPCM }],
  playlists: [{ id: '00000', clipIds: ['00000'] }],
});

files.set(
  'BDMV/index.bdmv',
  buildIndex({
    firstPlay: { kind: 'bdj', name: '00000', playbackType: BDJ_INTERACTIVE },
    topMenu: { kind: 'bdj', name: '00000', playbackType: BDJ_INTERACTIVE },
    titles: [
      { kind: 'bdj', name: '00001', playbackType: BDJ_INTERACTIVE },
    ],
  }),
);
files.set(
  'BDMV/BDJO/00000.bdjo',
  buildBdjo({
    jars: ['00000'],
    keyInterest: KEY_PLAY,
    apps: [{ controlCode: 1, orgId: ORG_ID, appId: 0x4001, name: 'FirstPlayXlet', baseDir: '00000', initialClass: 'bdjweb.test.FirstPlayXlet' }],
  }),
);
files.set(
  'BDMV/BDJO/00001.bdjo',
  buildBdjo({
    jars: ['00000'],
    keyInterest: KEY_PLAY,
    apps: [{ controlCode: 1, orgId: ORG_ID, appId: 0x4002, name: 'TitleXlet', baseDir: '00000', initialClass: 'bdjweb.test.TitleXlet' }],
  }),
);
files.set('BDMV/JAR/00000.jar', jar);
files.set('CERTIFICATE/app.discroot.crt', new Uint8Array(0));
files.set('CERTIFICATE/bu.discroot.crt', new Uint8Array(0));

writeFixture(outDir, files);
console.log(`wrote ${files.size} files to ${outDir}`);
