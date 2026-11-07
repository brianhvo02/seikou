import { readFileSync } from 'node:fs';
import { CodingType } from '@seikou/bdmv/stream-types';
import { buildIndex } from '../tests/helpers/bdmv-builders';
import { buildBdjo } from '../tests/helpers/bdjo-builder';
import { CLIP_START_PTS, buildSyntheticDisc } from '../tests/helpers/synthetic-disc';
import { writeFixture } from './fixture-dir';
import { encodeTestVideo } from './x264';

const outDir = process.argv[2];
if (!outDir) {
  console.error('usage: tsx scripts/make-bdj-menu-disc.ts <outDir>');
  process.exit(1);
}

const read = (path: string): Uint8Array<ArrayBuffer> => new Uint8Array(readFileSync(new URL(path, import.meta.url)));

// The xlet's jar (MenuXlet, its logo.png and its background still bg.png) is built by tools/bdj-classlib (npm run
// bdj-classlib:build) from tests/bdj/xlets/src/bdjweb/menu.
const jar = read('../tests/bdj/xlets/menu.jar');
// The disc font: Source Sans 3 Regular, OpenType with CFF outlines (SIL OFL 1.1; scripts/fetch-bdj-fonts.sh).
const font = read('../fixtures/bdj-fonts/SourceSans3-Regular.otf');
const fontLicence = read('../fixtures/bdj-fonts/LICENSE-SourceSans3.md');

const ORG_ID = 0x7fff0001;
const BDJ_INTERACTIVE = 3;
/** The menu draws in a full-HD graphics plane. */
const HAVI_1920_1080 = 1;

// Two playlists on one 2 s clip of real H.264 (as disc-bdj, so the disc plays in Chrome): 00000 is what the menu's
// Play starts; 00001, behind the menu, is the clip 30 times (60 s), so it does not end while a test uses the menu (the
// end would be a call from Java, which counts as a reaction to a tap, and its place among the flushes varies).
const BACKGROUND_REPEATS = 30;
const files = buildSyntheticDisc({
  clips: [{ clipId: '00000', videoAus: encodeTestVideo(2 * 24), keyIndices: [0, 24], startPts: CLIP_START_PTS, audio: CodingType.LPCM }],
  playlists: [
    { id: '00000', clipIds: ['00000'] },
    { id: '00001', clipIds: Array<string>(BACKGROUND_REPEATS).fill('00000') },
  ],
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
    apps: [{ controlCode: 1, orgId: ORG_ID, appId: 0x4001, name: 'MenuXlet', baseDir: '00000', initialClass: 'bdjweb.menu.MenuXlet' }],
  }),
);
files.set('BDMV/JAR/00000.jar', jar);
// org.dvb.ui.FontFactory reads the disc's fonts through this index (DVB-MHP font directory, as discs ship it)
files.set(
  'BDMV/AUXDATA/dvb.fontindex',
  new TextEncoder().encode(
    [
      '<?xml version="1.0" encoding="UTF-8"?>',
      '<!DOCTYPE fontdirectory PUBLIC "-//DVB//DTD Font Directory 1.0//EN" "http://www.dvb.org/mhp/dtd/fontdirectory-1-0.dtd">',
      '<fontdirectory>',
      '<font>',
      '<name>SourceSans3</name>',
      '<fontformat>OTF</fontformat>',
      '<filename>00000.otf</filename>',
      '<style>PLAIN</style>',
      '</font>',
      '</fontdirectory>',
      '',
    ].join('\n'),
  ),
);
files.set('BDMV/AUXDATA/00000.otf', font);
// the font's licence travels with it (outside BDMV, where no player looks)
files.set('LICENSE-SourceSans3.md', fontLicence);
files.set('CERTIFICATE/app.discroot.crt', new Uint8Array(0));
files.set('CERTIFICATE/bu.discroot.crt', new Uint8Array(0));

writeFixture(outDir, files);
console.log(`wrote ${files.size} files to ${outDir}`);
