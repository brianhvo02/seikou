import { CodingType } from '@seikou/bdmv/stream-types';
import { buildSoundBdmv } from '../tests/helpers/bdmv-builders';
import { asm, buildMovieObjects, imm } from '../tests/helpers/hdmv-builders';
import { endSegment, icsSegment, odsSegment, pdsSegment, type IcsSpec } from '../tests/helpers/ig-builders';
import { CLIP_START_PTS, buildSyntheticDisc, type SyntheticClipSpec } from '../tests/helpers/synthetic-disc';
import { writeFixture } from './fixture-dir';
import { encodeTestVideo } from './x264';

const outDir = process.argv[2];
if (!outDir) {
  console.error('usage: tsx scripts/make-menu-disc.ts <outDir>');
  process.exit(1);
}

const W = 64;
const H = 32;
const NONE = 0xffff;

/** A W×H object: horizontal stripes of `a` and `b`, `stripe` rows high, so the RLE has runs of both kinds and line ends. */
function stripes(a: number, b: number, stripe: number): number[][] {
  return Array.from({ length: H }, (_, y) => new Array<number>(W).fill(Math.floor(y / stripe) % 2 === 0 ? a : b));
}

function objects(list: Array<[id: number, rows: number[][]]>): Uint8Array[] {
  return list.flatMap(([id, rows]) => odsSegment(id, 0, W, H, rows));
}

/** Palette 0: 1 grey, 2 white, 3 yellow, 4 red, 5 half-transparent blue, 6 green. */
const palette = pdsSegment(0, 0, [
  [1, 128, 128, 128, 255],
  [2, 235, 128, 128, 255],
  [3, 210, 146, 16, 255],
  [4, 81, 240, 90, 255],
  [5, 41, 110, 240, 128],
  [6, 145, 34, 54, 255],
]);

// ---- the top menu (playlist 00001): always-on, two pages ----

const A = 1;
const B = 2;
const C = 3;
/** SET_BUTTON_PAGE from a button: dst bit 31 = button flag, src bit 31 = page flag (hdmv_vm.c _set_button_page). */
const toPage = (page: number, button: number): Uint8Array => asm.setButtonPage(imm(0x80000000 | button), imm(0x80000000 | page));

const topMenu: IcsSpec = {
  compositionState: 'epochStart',
  uiModel: 'alwaysOn',
  pages: [
    {
      id: 0,
      defaultSelected: A,
      paletteId: 0,
      bogs: [
        {
          defaultValid: A,
          buttons: [{
            id: A, x: 200, y: 200, neighbours: [B, B, A, A],
            normal: [1, 1], selected: [2, 2], activated: [3, 3], activatedSound: 0,
            cmds: [asm.jumpTitle(imm(1))],
          }],
        },
        {
          defaultValid: B,
          buttons: [{
            id: B, x: 200, y: 300, neighbours: [A, A, B, B],
            normal: [4, 4], selected: [5, 7], selectedRepeat: true, activated: [8, 8], selectedSound: 1,
            cmds: [toPage(1, C)],
          }],
        },
      ],
    },
    {
      id: 1,
      defaultSelected: C,
      paletteId: 0,
      bogs: [{
        defaultValid: C,
        buttons: [{ id: C, x: 200, y: 400, normal: [9, 9], selected: [10, 10], activated: [11, 11], cmds: [toPage(0, B)] }],
      }],
    },
  ],
};

const topMenuSegments = [
  ...icsSegment(topMenu),
  palette,
  ...objects([
    [1, stripes(1, 1, H)], [2, stripes(2, 1, 4)], [3, stripes(3, 2, 2)],
    [4, stripes(1, 5, 8)], [5, stripes(2, 4, 4)], [6, stripes(4, 2, 4)], [7, stripes(2, 6, 16)], [8, stripes(3, 3, H)],
    [9, stripes(1, 6, 8)], [10, stripes(6, 2, 4)], [11, stripes(3, 6, 2)],
  ]),
  endSegment(),
];

// ---- title 1 (playlist 00000): a pop-up menu with one button ----

const popupMenu: IcsSpec = {
  compositionState: 'epochStart',
  uiModel: 'popup',
  pages: [{
    id: 0,
    defaultSelected: 1,
    paletteId: 0,
    bogs: [{
      defaultValid: 1,
      buttons: [{ id: 1, x: 800, y: 900, neighbours: [NONE, NONE, NONE, NONE], normal: [1, 1], selected: [2, 2], activated: [3, 3], cmds: [asm.popupOff(), asm.linkMk(imm(1))] }],
    }],
  }],
};

const popupSegments = [...icsSegment(popupMenu), palette, ...objects([[1, stripes(1, 5, 4)], [2, stripes(2, 5, 4)], [3, stripes(3, 4, 8)]]), endSegment()];

const igAtStart = (segments: Uint8Array[]) => segments.map((payload) => ({ pts: CLIP_START_PTS, payload }));

const movieObjects = buildMovieObjects([
  { cmds: [asm.playPl(imm(1)), asm.goto(0)] }, // 0: First Play and top menu, the menu playlist over and over
  { cmds: [asm.playPl(imm(0))] }, // 1: title 1
]);

/** A short mono tone; the two sounds differ in pitch and length. */
function tone(samples: number, period: number): Int16Array {
  return Int16Array.from({ length: samples }, (_, i) => Math.round(Math.sin((2 * Math.PI * i) / period) * 8000));
}

/** Real H.264 (x264, IDR every second) so the disc also plays in Chrome (tests/e2e/menus.spec.ts). */
const aus = encodeTestVideo((8 + 10) * 24);
const clip = (clipId: string, from: number, seconds: number, igUnits: SyntheticClipSpec['igUnits']): SyntheticClipSpec => ({
  clipId,
  videoAus: aus.slice(from * 24, (from + seconds) * 24),
  keyIndices: Array.from({ length: seconds }, (_, i) => i * 24),
  startPts: CLIP_START_PTS,
  audio: CodingType.LPCM,
  igUnits,
});

const INTERACTIVE = 1;
const files = buildSyntheticDisc({
  clips: [clip('00001', 0, 8, igAtStart(popupSegments)), clip('00002', 8, 10, igAtStart(topMenuSegments))],
  playlists: [
    { id: '00000', clipIds: ['00001'], chapterEverySeconds: 2, uoMask: [0x10, 0, 0, 0, 0, 0, 0, 0] }, // the feature masks time search
    { id: '00001', clipIds: ['00002'] },
  ],
  movieObjects,
  index: {
    firstPlay: { kind: 'hdmv', movieObjectId: 0, playbackType: INTERACTIVE },
    topMenu: { kind: 'hdmv', movieObjectId: 0, playbackType: INTERACTIVE },
    titles: [{ kind: 'hdmv', movieObjectId: 1, playbackType: 0 }],
  },
});
files.set('BDMV/AUXDATA/sound.bdmv', buildSoundBdmv([{ channels: 1, samples: tone(2400, 100) }, { channels: 2, samples: tone(1200, 50) }]));

writeFixture(outDir, files);
console.log(`wrote ${files.size} files to ${outDir}`);
