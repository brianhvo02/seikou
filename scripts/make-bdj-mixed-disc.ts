import { readFileSync } from 'node:fs';
import { CodingType } from '@seikou/bdmv/stream-types';
import { buildBdjo } from '../tests/helpers/bdjo-builder';
import { asm, buildMovieObjects, imm } from '../tests/helpers/hdmv-builders';
import { buildSyntheticDisc, syntheticClip } from '../tests/helpers/synthetic-disc';
import { writeFixture } from './fixture-dir';

const outDir = process.argv[2];
if (!outDir) {
  console.error('usage: tsx scripts/make-bdj-mixed-disc.ts <outDir>');
  process.exit(1);
}

/*
 * HDMV and BD-J titles handing over in both directions:
 *  - First Play is BD-J: HdmvTitleXlet starts title 1 through its TitleContext (BDJLoader → selectHdmvTitle →
 *    selectTitleN(1), libbluray's _play_hdmv and _stop_bdj).
 *  - Title 1 is HDMV (movie object 0): PlayPL 0, then JumpTitle 2 when the playlist ends (_play_bdj).
 *  - Title 2 is BD-J: PlaylistXlet plays playlist 00001.
 */

// The xlets' jar is built by tools/bdj-classlib (npm run bdj-classlib:build) from tests/bdj/xlets/src/bdjweb/mixed.
const jar = new Uint8Array(readFileSync(new URL('../tests/bdj/xlets/mixed.jar', import.meta.url)));

const ORG_ID = 0x7fff0001;
const KEY_PLAY = 0x80000000; // VK_PLAY in the key interest table
const BDJ_INTERACTIVE = 3;

const files = buildSyntheticDisc({
  clips: [syntheticClip('00000', 2, { audio: CodingType.LPCM }), syntheticClip('00001', 2, { audio: CodingType.LPCM })],
  playlists: [
    { id: '00000', clipIds: ['00000'] },
    { id: '00001', clipIds: ['00001'] },
  ],
  movieObjects: buildMovieObjects([{ cmds: [asm.playPl(imm(0)), asm.jumpTitle(imm(2))] }]),
  index: {
    firstPlay: { kind: 'bdj', name: '00000', playbackType: BDJ_INTERACTIVE },
    topMenu: { kind: 'bdj', name: '00000', playbackType: BDJ_INTERACTIVE },
    titles: [
      { kind: 'hdmv', movieObjectId: 0 },
      { kind: 'bdj', name: '00001', playbackType: BDJ_INTERACTIVE },
    ],
  },
});

files.set(
  'BDMV/BDJO/00000.bdjo',
  buildBdjo({
    jars: ['00000'],
    keyInterest: KEY_PLAY,
    apps: [{ controlCode: 1, orgId: ORG_ID, appId: 0x4001, name: 'HdmvTitleXlet', baseDir: '00000', initialClass: 'bdjweb.mixed.HdmvTitleXlet' }],
  }),
);
files.set(
  'BDMV/BDJO/00001.bdjo',
  buildBdjo({
    jars: ['00000'],
    keyInterest: KEY_PLAY,
    apps: [{ controlCode: 1, orgId: ORG_ID, appId: 0x4002, name: 'PlaylistXlet', baseDir: '00000', initialClass: 'bdjweb.mixed.PlaylistXlet' }],
  }),
);
files.set('BDMV/JAR/00000.jar', jar);
files.set('CERTIFICATE/app.discroot.crt', new Uint8Array(0));
files.set('CERTIFICATE/bu.discroot.crt', new Uint8Array(0));

writeFixture(outDir, files);
console.log(`wrote ${files.size} files to ${outDir}`);
