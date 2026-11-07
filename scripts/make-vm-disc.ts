import { CodingType } from '@seikou/bdmv/stream-types';
import { asm, buildMovieObjects, imm, psr, reg } from '../tests/helpers/hdmv-builders';
import { CLIP_START_PTS, buildSyntheticDisc, syntheticClip } from '../tests/helpers/synthetic-disc';
import { writeFixture } from './fixture-dir';

const outDir = process.argv[2];
if (!outDir) {
  console.error('usage: tsx scripts/make-vm-disc.ts <outDir>');
  process.exit(1);
}

/** First Play: every SET operation, compares and branches, a call/resume pair, then playlist 0 and title 1. */
const firstPlay: Uint8Array[] = [
  asm.set('move', reg(0), imm(100)),
  asm.set('move', reg(1), imm(7)),
  asm.set('swap', reg(0), reg(1)), // r0 = 7, r1 = 100
  asm.set('add', reg(0), imm(5)),
  asm.set('sub', reg(0), imm(2)),
  asm.set('mul', reg(0), imm(3)),
  asm.set('div', reg(0), imm(4)), // r0 = 7
  asm.set('mod', reg(1), imm(7)), // r1 = 2
  asm.set('rnd', reg(2), imm(10)),
  asm.set('move', reg(3), imm(0xf0f0)),
  asm.set('and', reg(3), imm(0x0ff0)),
  asm.set('or', reg(3), imm(0x0f00)),
  asm.set('xor', reg(3), imm(0xaaaa)),
  asm.set('move', reg(4), imm(0)),
  asm.set('bitset', reg(4), imm(3)),
  asm.set('bitset', reg(4), imm(5)),
  asm.set('bitclr', reg(4), imm(3)),
  asm.set('move', reg(8), imm(1)),
  asm.set('shl', reg(8), imm(4)),
  asm.set('shr', reg(8), imm(2)),
  asm.set('move', reg(9), psr(4)),
  asm.set('move', reg(6), imm(0)),
];
const loop = firstPlay.length;
firstPlay.push(
  asm.set('add', reg(6), imm(1)),
  asm.cmp('lt', reg(6), imm(3)),
  asm.goto(loop),
  asm.cmp('eq', reg(0), imm(7)),
  asm.set('move', reg(5), imm(1)),
  asm.cmp('ne', reg(0), imm(7)),
  asm.set('move', reg(5), imm(99)), // skipped
  asm.cmp('bc', reg(3), imm(0x0001)),
  asm.set('move', reg(10), imm(1)),
  asm.cmp('ge', reg(1), reg(0)),
  asm.set('move', reg(11), imm(1)), // skipped
  asm.cmp('gt', reg(0), reg(1)),
  asm.set('move', reg(12), imm(1)),
  asm.cmp('le', reg(1), reg(0)),
  asm.set('move', reg(13), imm(1)),
  asm.cmp('lt', reg(0), reg(1)),
  asm.set('move', reg(14), imm(1)), // skipped
  // SET edge cases: underflow, saturation, division by zero, shifts and bit numbers past 31, rnd 0, a PSR operand
  asm.set('move', reg(30), imm(5)),
  asm.set('sub', reg(30), imm(10)), // underflow: 0
  asm.set('move', reg(31), imm(0xfffffff0)),
  asm.set('add', reg(31), imm(0x100)), // saturates
  asm.set('move', reg(32), imm(0x10000)),
  asm.set('mul', reg(32), imm(0x10000)), // saturates
  asm.set('move', reg(33), imm(7)),
  asm.set('div', reg(33), imm(0)), // 0xffffffff
  asm.set('move', reg(34), imm(7)),
  asm.set('mod', reg(34), imm(0)), // 0xffffffff
  asm.set('move', reg(35), imm(0xff)),
  asm.set('shl', reg(35), imm(32)), // 0
  asm.set('move', reg(36), imm(0xff)),
  asm.set('shr', reg(36), imm(40)), // 0
  asm.set('move', reg(37), imm(0xf)),
  asm.set('bitset', reg(37), imm(40)), // unchanged
  asm.set('bitclr', reg(37), imm(40)), // unchanged
  asm.set('bitset', reg(37), imm(31)),
  asm.set('rnd', reg(38), imm(0)),
  asm.set('rnd', reg(39), imm(1)),
  asm.cmp('bc', reg(37), imm(0x10)), // false
  asm.set('move', reg(40), imm(1)),
  asm.cmp('bc', reg(37), imm(0x8)), // true
  asm.set('move', reg(41), imm(1)),
  asm.set('move', reg(42), imm(0x1234)),
  asm.set('swap', reg(42), psr(4)), // r42 takes PSR4, the PSR cannot be stored to
  // SET_SYSTEM beyond audio: PG stream with display flag, IG stream, angle, navigation timer, button page
  asm.setStream(imm(0x8000 | 0x4000 | 2), imm(0x80010000 | 0x8000 | 2)),
  asm.setStream(imm(0x8000 | 3), imm(0)), // PG stream 3, display flag off
  asm.setNvTimer(imm(5), imm(10)),
  asm.setNvTimer(imm(5), imm(301)), // rejected
  asm.setNvTimer(imm(0), imm(0)), // cancels
  asm.setButtonPage(imm(0x80000004), imm(0x80000002)),
  asm.callObject(imm(4)),
  asm.playPl(imm(0)),
  asm.jumpTitle(imm(1)),
);

const movieObjects = buildMovieObjects([
  { cmds: firstPlay }, // 0: first play
  { cmds: [asm.set('move', reg(20), imm(9)), asm.resume()] }, // 1: top menu, returns to what the menu call interrupted
  { menuCallMask: true, cmds: [asm.playPlPi(imm(1), imm(1)), asm.playPlPm(imm(2), imm(1)), asm.jumpTitle(imm(2))] }, // 2: title 1
  { resumeIntention: true, cmds: [asm.setStream(imm(0x80010000), imm(0)), asm.playPl(imm(0)), asm.jumpObject(imm(5))] }, // 3: title 2
  { cmds: [asm.set('rnd', reg(7), imm(100)), asm.resume()] }, // 4: called from first play
  { cmds: [asm.set('add', reg(15), imm(55))] }, // 5: the program ends here
  // 6: title 3, a movie title (chapter PSR): whole playlist, then a start item, a start mark on a LINK mark, a start mark on an ENTRY mark
  {
    resumeIntention: true,
    cmds: [asm.playPl(imm(3)), asm.playPlPi(imm(3), imm(1)), asm.playPlPm(imm(3), imm(1)), asm.playPlPm(imm(3), imm(2)), asm.jumpObject(imm(5))],
  },
  // 7: title 4, a movie title: start item 1 of a playlist whose second (seamless) item has a chapter mark at its start
  { cmds: [asm.playPlPi(imm(4), imm(1)), asm.jumpObject(imm(5))] },
]);

/** 45 kHz clip time of the first frame. */
const CLIP_IN = CLIP_START_PTS / 2;
const clip = (id: string) => syntheticClip(id, 2, { audio: CodingType.LPCM });
const INTERACTIVE = 1;
const files = buildSyntheticDisc({
  clips: [clip('00001'), clip('00002')],
  playlists: [
    { id: '00000', clipIds: ['00001'] },
    { id: '00001', clipIds: ['00001', '00002'], chapterEverySeconds: 1 },
    { id: '00002', clipIds: ['00002'], chapterEverySeconds: 1 },
    // ENTRY and LINK marks on the clips' key frames (0 s and 1 s); none at the start of the second item, where libbluray's
    // packet position (start of clip) is before the first EP map entry
    {
      id: '00003',
      clipIds: ['00001', '00002'],
      marks: [
        { playItemRef: 0, time: CLIP_IN, type: 1 },
        { playItemRef: 0, time: CLIP_IN + 45_000, type: 2 },
        { playItemRef: 1, time: CLIP_IN + 45_000, type: 1 },
      ],
    },
    // chapter mark at the start of the seamless (condition 5) second item: libbluray starts that item at packet 0, before
    // the mark's packet (the first EP map entry), so a start item there is still in the first chapter
    {
      id: '00004',
      clipIds: ['00001', '00002'],
      marks: [
        { playItemRef: 0, time: CLIP_IN, type: 1 },
        { playItemRef: 1, time: CLIP_IN, type: 1 },
        { playItemRef: 1, time: CLIP_IN + 45_000, type: 1 },
      ],
    },
  ],
  movieObjects,
  index: {
    firstPlay: { kind: 'hdmv', movieObjectId: 0, playbackType: INTERACTIVE },
    topMenu: { kind: 'hdmv', movieObjectId: 1, playbackType: INTERACTIVE },
    titles: [
      { kind: 'hdmv', movieObjectId: 2, playbackType: INTERACTIVE },
      { kind: 'hdmv', movieObjectId: 3, playbackType: INTERACTIVE },
      { kind: 'hdmv', movieObjectId: 6, playbackType: 0 },
      { kind: 'hdmv', movieObjectId: 7, playbackType: 0 },
    ],
  },
});

writeFixture(outDir, files);
console.log(`wrote ${files.size} files to ${outDir}`);
