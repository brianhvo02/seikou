import { readFileSync } from 'node:fs';
import { CodingType } from '@seikou/bdmv/stream-types';
import { buildIndex } from '../tests/helpers/bdmv-builders';
import { buildBdjo } from '../tests/helpers/bdjo-builder';
import { CLIP_START_PTS, buildSyntheticDisc } from '../tests/helpers/synthetic-disc';
import { writeFixture } from './fixture-dir';
import { encodeTestVideo } from './x264';

const outDir = process.argv[2];
if (!outDir) {
  console.error('usage: tsx scripts/make-bdj-store-disc.ts <outDir>');
  process.exit(1);
}

// The xlet's jar (StoreXlet) is built by tools/bdj-classlib (npm run bdj-classlib:build) from tests/bdj/xlets/src/bdjweb/store.
const jar = new Uint8Array(readFileSync(new URL('../tests/bdj/xlets/store.jar', import.meta.url)));

// Its own organisation, so its saved data (persistent/7fff0002, buda/7fff0002) is apart from the other synthetic discs'.
const ORG_ID = 0x7fff0002;
const BDJ_INTERACTIVE = 3;
/** The count is drawn in a full-HD graphics plane. */
const HAVI_1920_1080 = 1;

// StoreXlet draws its count, saves the next one and then plays playlist 00000: the clip 30 times (60 s), so a test sees
// the playlist start (the save has happened) and the plane settle, with the video still running under it.
const REPEATS = 30;
const files = buildSyntheticDisc({
  clips: [{ clipId: '00000', videoAus: encodeTestVideo(2 * 24), keyIndices: [0, 24], startPts: CLIP_START_PTS, audio: CodingType.LPCM }],
  playlists: [{ id: '00000', clipIds: Array<string>(REPEATS).fill('00000') }],
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
    haviConfig: HAVI_1920_1080,
    apps: [{ controlCode: 1, orgId: ORG_ID, appId: 0x4001, name: 'StoreXlet', baseDir: '00000', initialClass: 'bdjweb.store.StoreXlet' }],
  }),
);
files.set('BDMV/JAR/00000.jar', jar);
files.set('CERTIFICATE/app.discroot.crt', new Uint8Array(0));
files.set('CERTIFICATE/bu.discroot.crt', new Uint8Array(0));

writeFixture(outDir, files);
console.log(`wrote ${files.size} files to ${outDir}`);
