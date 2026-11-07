import { ByteWriter } from './byte-writer';
import { BranchSub, CmpOpt, GotoOpt, InsnGroup, JumpOpt, PlayOpt, SetOpt, SetSub, SetSystemOpt } from '@seikou/bdmv/mobj-parser';

const OBJECTS_START = 40;

export interface Operand {
  readonly value: number;
  readonly imm: boolean;
}

export const reg = (n: number): Operand => ({ value: n, imm: false });
export const psr = (n: number): Operand => ({ value: (0x80000000 | n) >>> 0, imm: false });
export const imm = (v: number): Operand => ({ value: v >>> 0, imm: true });

const NONE: Operand = { value: 0, imm: false };

export function encodeCmd(c: {
  grp: number;
  subGrp: number;
  opCnt: number;
  branchOpt?: number;
  cmpOpt?: number;
  setOpt?: number;
  dst?: Operand;
  src?: Operand;
}): Uint8Array {
  const dst = c.dst ?? NONE;
  const src = c.src ?? NONE;
  return new ByteWriter()
    .bits(3, c.opCnt)
    .bits(2, c.grp)
    .bits(3, c.subGrp)
    .bits(1, dst.imm ? 1 : 0)
    .bits(1, src.imm ? 1 : 0)
    .bits(2, 0)
    .bits(4, c.branchOpt ?? 0)
    .bits(4, 0)
    .bits(4, c.cmpOpt ?? 0)
    .bits(3, 0)
    .bits(5, c.setOpt ?? 0)
    .u32(dst.value)
    .u32(src.value)
    .toBytes();
}

const opCount = (dst?: Operand, src?: Operand): number => (src ? 2 : dst ? 1 : 0);
const branch = (subGrp: number, opt: number, dst?: Operand, src?: Operand): Uint8Array =>
  encodeCmd({ grp: InsnGroup.BRANCH, subGrp, opCnt: opCount(dst, src), branchOpt: opt, dst, src });
const setSystem = (opt: number, dst?: Operand, src?: Operand): Uint8Array =>
  encodeCmd({ grp: InsnGroup.SET, subGrp: SetSub.SETSYSTEM, opCnt: opCount(dst, src), setOpt: opt, dst, src });

const CMP = { bc: CmpOpt.BC, eq: CmpOpt.EQ, ne: CmpOpt.NE, ge: CmpOpt.GE, gt: CmpOpt.GT, le: CmpOpt.LE, lt: CmpOpt.LT };
const SET = {
  move: SetOpt.MOVE, swap: SetOpt.SWAP, add: SetOpt.ADD, sub: SetOpt.SUB, mul: SetOpt.MUL, div: SetOpt.DIV, mod: SetOpt.MOD,
  rnd: SetOpt.RND, and: SetOpt.AND, or: SetOpt.OR, xor: SetOpt.XOR, bitset: SetOpt.BITSET, bitclr: SetOpt.BITCLR,
  shl: SetOpt.SHL, shr: SetOpt.SHR,
};

export const asm = {
  nop: (): Uint8Array => branch(BranchSub.GOTO, GotoOpt.NOP),
  goto: (target: number): Uint8Array => branch(BranchSub.GOTO, GotoOpt.GOTO, imm(target)),
  break: (): Uint8Array => branch(BranchSub.GOTO, GotoOpt.BREAK),
  jumpObject: (o: Operand): Uint8Array => branch(BranchSub.JUMP, JumpOpt.JUMP_OBJECT, o),
  jumpTitle: (t: Operand): Uint8Array => branch(BranchSub.JUMP, JumpOpt.JUMP_TITLE, t),
  callObject: (o: Operand): Uint8Array => branch(BranchSub.JUMP, JumpOpt.CALL_OBJECT, o),
  callTitle: (t: Operand): Uint8Array => branch(BranchSub.JUMP, JumpOpt.CALL_TITLE, t),
  resume: (): Uint8Array => branch(BranchSub.JUMP, JumpOpt.RESUME),
  playPl: (pl: Operand): Uint8Array => branch(BranchSub.PLAY, PlayOpt.PLAY_PL, pl),
  playPlPi: (pl: Operand, pi: Operand): Uint8Array => branch(BranchSub.PLAY, PlayOpt.PLAY_PL_PI, pl, pi),
  playPlPm: (pl: Operand, pm: Operand): Uint8Array => branch(BranchSub.PLAY, PlayOpt.PLAY_PL_PM, pl, pm),
  terminatePl: (): Uint8Array => branch(BranchSub.PLAY, PlayOpt.TERMINATE_PL),
  linkPi: (pi: Operand): Uint8Array => branch(BranchSub.PLAY, PlayOpt.LINK_PI, pi),
  linkMk: (pm: Operand): Uint8Array => branch(BranchSub.PLAY, PlayOpt.LINK_MK, pm),
  cmp: (op: keyof typeof CMP, a: Operand, b: Operand): Uint8Array =>
    encodeCmd({ grp: InsnGroup.CMP, subGrp: 0, opCnt: 2, cmpOpt: CMP[op], dst: a, src: b }),
  set: (op: keyof typeof SET, dst: Operand, src: Operand): Uint8Array =>
    encodeCmd({ grp: InsnGroup.SET, subGrp: SetSub.SET, opCnt: 2, setOpt: SET[op], dst, src }),
  setStream: (dst: Operand, src: Operand): Uint8Array => setSystem(SetSystemOpt.SET_STREAM, dst, src),
  setButtonPage: (dst: Operand, src: Operand): Uint8Array => setSystem(SetSystemOpt.SET_BUTTON_PAGE, dst, src),
  enableButton: (b: Operand): Uint8Array => setSystem(SetSystemOpt.ENABLE_BUTTON, b),
  disableButton: (b: Operand): Uint8Array => setSystem(SetSystemOpt.DISABLE_BUTTON, b),
  popupOff: (): Uint8Array => setSystem(SetSystemOpt.POPUP_OFF),
  stillOn: (): Uint8Array => setSystem(SetSystemOpt.STILL_ON),
  stillOff: (): Uint8Array => setSystem(SetSystemOpt.STILL_OFF),
  setNvTimer: (o: Operand, t: Operand): Uint8Array => setSystem(SetSystemOpt.SET_NV_TIMER, o, t),
};

export function buildMovieObjects(
  objects: Array<{ resumeIntention?: boolean; menuCallMask?: boolean; titleSearchMask?: boolean; cmds: Uint8Array[] }>,
): Uint8Array<ArrayBuffer> {
  const body = new ByteWriter().u32(0).u16(objects.length);
  for (const o of objects) {
    body
      .bits(1, o.resumeIntention ? 1 : 0)
      .bits(1, o.menuCallMask ? 1 : 0)
      .bits(1, o.titleSearchMask ? 1 : 0)
      .bits(13, 0)
      .u16(o.cmds.length);
    for (const c of o.cmds) body.bytes(c);
  }
  const bodyBytes = body.toBytes();
  return new ByteWriter()
    .ascii('MOBJ')
    .ascii('0200')
    .u32(0)
    .zeros(OBJECTS_START - 12)
    .u32(bodyBytes.length)
    .bytes(bodyBytes)
    .toBytes();
}
