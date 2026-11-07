import { readFileSync } from 'node:fs';
import { CodingType } from '@seikou/bdmv/stream-types';
import { buildIndex } from '../tests/helpers/bdmv-builders';
import { buildBdjo } from '../tests/helpers/bdjo-builder';
import { CLIP_START_PTS, buildSyntheticDisc } from '../tests/helpers/synthetic-disc';
import { writeFixture } from './fixture-dir';
import { encodeTestVideo } from './x264';

const outDir = process.argv[2];
if (!outDir) {
  console.error('usage: tsx scripts/make-bdj-background-disc.ts <outDir>');
  process.exit(1);
}

// The xlet's jar (BackgroundXlet and the still it shows, bg.png) is built by tools/bdj-classlib (npm run
// bdj-classlib:build) from tests/bdj/xlets/src/bdjweb/background.
const jar = new Uint8Array(readFileSync(new URL('../tests/bdj/xlets/background.jar', import.meta.url)));

const ORG_ID = 0x7fff0001;
const BDJ_INTERACTIVE = 3;

// First Play is the BD-J title: it shows its background still, then plays playlist 00000 (real H.264, as disc-bdj).
// The video is 4:3, so it is pillarboxed in the 16:9 screen and the still's left edge stays visible beside it (the
// browser E2E, bdj-menu.spec.ts, looks for it there).
const files = buildSyntheticDisc({
  clips: [{ clipId: '00000', videoAus: encodeTestVideo(2 * 24, '480x360'), keyIndices: [0, 24], startPts: CLIP_START_PTS, audio: CodingType.LPCM }],
  playlists: [{ id: '00000', clipIds: ['00000'] }],
});

files.set(
  'BDMV/index.bdmv',
  buildIndex({
    firstPlay: { kind: 'bdj', name: '00000', playbackType: BDJ_INTERACTIVE },
    topMenu: { kind: 'bdj', name: '00000', playbackType: BDJ_INTERACTIVE },
    titles: [{ kind: 'bdj', name: '00000', playbackType: BDJ_INTERACTIVE }],
  }),
);
files.set(
  'BDMV/BDJO/00000.bdjo',
  buildBdjo({
    jars: ['00000'],
    apps: [{ controlCode: 1, orgId: ORG_ID, appId: 0x4001, name: 'BackgroundXlet', baseDir: '00000', initialClass: 'bdjweb.background.BackgroundXlet' }],
  }),
);
files.set('BDMV/JAR/00000.jar', jar);
files.set('CERTIFICATE/app.discroot.crt', new Uint8Array(0));
files.set('CERTIFICATE/bu.discroot.crt', new Uint8Array(0));

writeFixture(outDir, files);
console.log(`wrote ${files.size} files to ${outDir}`);
