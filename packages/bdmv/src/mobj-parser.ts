/*
 * Ported from libbluray src/libbluray/hdmv/mobj_parse.c and hdmv_insn.h
 * Copyright (C) 2010  hpi1
 * Copyright (C) 2012  Petri Hintukainen <phintuka@users.sourceforge.net>
 *
 * Ported to TypeScript and modified for Seikou, 2026.
 *
 * SPDX-License-Identifier: LGPL-2.1-or-later
 */

import { ByteReader, ParseError } from './byte-reader';
import { checkVersion } from './version';

/** `HdmvInsn.grp` values: the command group (libbluray `hdmv_insn_grp`, `hdmv_insn.h`). */
export const InsnGroup = { BRANCH: 0, CMP: 1, SET: 2 } as const;

/** `HdmvInsn.subGrp` values in the branch group (libbluray `hdmv_insn_grp_branch`). */
export const BranchSub = { GOTO: 0x00, JUMP: 0x01, PLAY: 0x02 } as const;

/** `HdmvInsn.branchOpt` values in the GOTO sub-group: jumps within the object's commands (libbluray `hdmv_insn_goto`). */
export const GotoOpt = { NOP: 0x00, GOTO: 0x01, BREAK: 0x02 } as const;

/** `HdmvInsn.branchOpt` values in the JUMP sub-group: jumps and calls to objects and titles (libbluray `hdmv_insn_jump`). */
export const JumpOpt = { JUMP_OBJECT: 0x00, JUMP_TITLE: 0x01, CALL_OBJECT: 0x02, CALL_TITLE: 0x03, RESUME: 0x04 } as const;

/** `HdmvInsn.branchOpt` values in the PLAY sub-group: playlist playback and links within it (libbluray `hdmv_insn_play`). */
export const PlayOpt = {
  PLAY_PL: 0x00,
  PLAY_PL_PI: 0x01,
  PLAY_PL_PM: 0x02,
  TERMINATE_PL: 0x03,
  LINK_PI: 0x04,
  LINK_MK: 0x05,
} as const;

/**
 * `HdmvInsn.cmpOpt` values of the compare group (libbluray `hdmv_insn_cmp`, `INSN_BC` to `INSN_LT`): bit test, equal,
 * not equal, greater or equal, greater, less or equal, less.
 */
export const CmpOpt = { BC: 0x01, EQ: 0x02, NE: 0x03, GE: 0x04, GT: 0x05, LE: 0x06, LT: 0x07 } as const;

/** `HdmvInsn.subGrp` values in the set group (libbluray `hdmv_insn_grp_set`). */
export const SetSub = { SET: 0x00, SETSYSTEM: 0x01 } as const;

/** `HdmvInsn.setOpt` values in the SET sub-group: register arithmetic and moves (libbluray `hdmv_insn_set`). */
export const SetOpt = {
  MOVE: 0x01,
  SWAP: 0x02,
  ADD: 0x03,
  SUB: 0x04,
  MUL: 0x05,
  DIV: 0x06,
  MOD: 0x07,
  RND: 0x08,
  AND: 0x09,
  OR: 0x0a,
  XOR: 0x0b,
  BITSET: 0x0c,
  BITCLR: 0x0d,
  SHL: 0x0e,
  SHR: 0x0f,
} as const;

/**
 * `HdmvInsn.setOpt` values in the SETSYSTEM sub-group: stream, button, still and output mode control (libbluray
 * `hdmv_insn_setsystem`). 0x10 has no name in libbluray, whose `_setsystem_0x10` writes `dst` to PSR103.
 */
export const SetSystemOpt = {
  SET_STREAM: 0x01,
  SET_NV_TIMER: 0x02,
  SET_BUTTON_PAGE: 0x03,
  ENABLE_BUTTON: 0x04,
  DISABLE_BUTTON: 0x05,
  SET_SEC_STREAM: 0x06,
  POPUP_OFF: 0x07,
  STILL_ON: 0x08,
  STILL_OFF: 0x09,
  SET_OUTPUT_MODE: 0x0a,
  SET_STREAM_SS: 0x0b,
  SETSYSTEM_0x10: 0x10,
} as const;

/** The opcode word of an HDMV command, libbluray `HDMV_INSN` (`mobj_data.h`), split by `mobj_parse_cmd`. */
export interface HdmvInsn {
  /** `op_cnt`: how many of the operands `dst` and `src` the command uses (0 to 2). */
  readonly opCnt: number;
  /** `grp`: the command group, one of `InsnGroup`. */
  readonly grp: number;
  /** `sub_grp`: the sub-group, one of `BranchSub` or `SetSub`. */
  readonly subGrp: number;
  /** `imm_op1`: `dst` is an immediate value, not a register number. */
  readonly immOp1: boolean;
  /** `imm_op2`: `src` is an immediate value, not a register number. */
  readonly immOp2: boolean;
  /** `branch_opt`: the branch command, one of `GotoOpt`, `JumpOpt` or `PlayOpt` by sub-group. */
  readonly branchOpt: number;
  /** `cmp_opt`: the comparison, one of `CmpOpt`. */
  readonly cmpOpt: number;
  /** `set_opt`: the set command, one of `SetOpt` or `SetSystemOpt` by sub-group. */
  readonly setOpt: number;
}

/**
 * One 12-byte HDMV navigation command, libbluray `MOBJ_CMD` (`mobj_data.h`). Movie objects and IG button commands use
 * the same encoding.
 */
export interface MobjCmd {
  /** The opcode word (the first 4 bytes). */
  readonly insn: HdmvInsn;
  /**
   * `dst`: the first operand. Unless `insn.immOp1` is set it is a register number: a PSR when bit 31 is set
   * (libbluray `hdmv_vm.c` `PSR_FLAG`, with the PSR number in the low 7 bits), else a GPR.
   */
  readonly dst: number;
  /** `src`: the second operand, a register number or (with `insn.immOp2`) an immediate value, encoded like `dst`. */
  readonly src: number;
}

/** One movie object: flags and the HDMV commands it runs. libbluray `MOBJ_OBJECT` (`mobj_data.h`), read by `_mobj_parse_object`. */
export interface MovieObject {
  /**
   * `resume_intention_flag`: a Menu Call may suspend the object's playlist and resume it later (libbluray
   * `hdmv_vm_suspend_pl` refuses to suspend without it).
   */
  readonly resumeIntention: boolean;
  /** `menu_call_mask`: the Menu Call user operation is not allowed while the object runs. */
  readonly menuCallMask: boolean;
  /** `title_search_mask`: the Title Search user operation is not allowed while the object runs. */
  readonly titleSearchMask: boolean;
  /** `cmds`: the object's commands in order; a GOTO command addresses them by index. */
  readonly cmds: readonly MobjCmd[];
}

/** The parsed `BDMV/MovieObject.bdmv`, libbluray `MOBJ_OBJECTS` (`mobj_data.h`). */
export interface MovieObjects {
  /** The four version characters after the `MOBJ` signature, such as `0200`. */
  readonly version: string;
  /** The movie objects in order; index.bdmv's `movieObjectId` indexes this. */
  readonly objects: readonly MovieObject[];
}

const CMD_SIZE = 12;
const OBJECTS_START = 40;

/**
 * Decodes the 12-byte HDMV command at `offset` of `bytes` (libbluray `mobj_parse_cmd`). Throws a ParseError when fewer
 * than 12 bytes remain.
 */
export function parseMobjCmd(bytes: Uint8Array, offset = 0): MobjCmd {
  const r = new ByteReader(bytes.subarray(offset, offset + CMD_SIZE));
  const opCnt = r.bits(3);
  const grp = r.bits(2);
  const subGrp = r.bits(3);
  const immOp1 = r.flag();
  const immOp2 = r.flag();
  r.skipBits(2);
  const branchOpt = r.bits(4);
  r.skipBits(4);
  const cmpOpt = r.bits(4);
  r.skipBits(3);
  const setOpt = r.bits(5);
  const dst = r.u32();
  const src = r.u32();
  return { insn: { opCnt, grp, subGrp, immOp1, immOp2, branchOpt, cmpOpt, setOpt }, dst, src };
}

/** One movie object (libbluray `_mobj_parse_object`): the three flags, padding, the command count and the commands. */
function parseObject(r: ByteReader): MovieObject {
  const resumeIntention = r.flag();
  const menuCallMask = r.flag();
  const titleSearchMask = r.flag();
  r.skipBits(13);
  const numCmds = r.u16();
  const cmds: MobjCmd[] = [];
  for (let i = 0; i < numCmds; i++) {
    if (r.remaining < CMD_SIZE) throw new ParseError('MovieObject.bdmv: unexpected EOF');
    cmds.push(parseMobjCmd(r.take(CMD_SIZE)));
  }
  return { resumeIntention, menuCallMask, titleSearchMask, cmds };
}

/**
 * Parses the bytes of `BDMV/MovieObject.bdmv` (libbluray `_mobj_parse`). Throws a ParseError for a bad signature, an
 * unsupported version, a `data_len` longer than the file, or a command cut off by the end of the file.
 */
export function parseMovieObjects(bytes: Uint8Array): MovieObjects {
  const r = new ByteReader(bytes);
  const signature = r.ascii(4);
  const version = r.ascii(4);
  if (signature !== 'MOBJ') throw new ParseError(`MovieObject.bdmv: bad signature "${signature}"`);
  checkVersion('MovieObject.bdmv', version);
  r.u32(); // extension_data_start; libbluray only logs it
  r.seek(OBJECTS_START);
  const dataLen = r.u32();
  if (r.remaining < dataLen) throw new ParseError(`MovieObject.bdmv: invalid data_len ${dataLen}`);
  r.skip(4);
  const numObjects = r.u16();
  const objects: MovieObject[] = [];
  for (let i = 0; i < numObjects; i++) objects.push(parseObject(r));
  return { version, objects };
}
