/*
 * Ported from libbluray src/libbluray/hdmv/mobj_parse.c and hdmv_insn.h
 * Copyright (C) 2010  hpi1
 * Copyright (C) 2012  Petri Hintukainen <phintuka@users.sourceforge.net>
 *
 * Ported to TypeScript and modified for bluray-web, 2026.
 *
 * SPDX-License-Identifier: LGPL-2.1-or-later
 */

import { ByteReader, ParseError } from '@seikou/bdmv/byte-reader';
import { checkVersion } from './version';

/** hdmv_insn_grp */
export const InsnGroup = { BRANCH: 0, CMP: 1, SET: 2 } as const;

/** hdmv_insn_grp_branch */
export const BranchSub = { GOTO: 0x00, JUMP: 0x01, PLAY: 0x02 } as const;

/** hdmv_insn_goto */
export const GotoOpt = { NOP: 0x00, GOTO: 0x01, BREAK: 0x02 } as const;

/** hdmv_insn_jump */
export const JumpOpt = { JUMP_OBJECT: 0x00, JUMP_TITLE: 0x01, CALL_OBJECT: 0x02, CALL_TITLE: 0x03, RESUME: 0x04 } as const;

/** hdmv_insn_play */
export const PlayOpt = {
  PLAY_PL: 0x00,
  PLAY_PL_PI: 0x01,
  PLAY_PL_PM: 0x02,
  TERMINATE_PL: 0x03,
  LINK_PI: 0x04,
  LINK_MK: 0x05,
} as const;

/** hdmv_insn_cmp (INSN_BC .. INSN_LT) */
export const CmpOpt = { BC: 0x01, EQ: 0x02, NE: 0x03, GE: 0x04, GT: 0x05, LE: 0x06, LT: 0x07 } as const;

/** hdmv_insn_grp_set */
export const SetSub = { SET: 0x00, SETSYSTEM: 0x01 } as const;

/** hdmv_insn_set */
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

/** hdmv_insn_setsystem */
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

export interface HdmvInsn {
  readonly opCnt: number;
  readonly grp: number;
  readonly subGrp: number;
  readonly immOp1: boolean;
  readonly immOp2: boolean;
  readonly branchOpt: number;
  readonly cmpOpt: number;
  readonly setOpt: number;
}

export interface MobjCmd {
  readonly insn: HdmvInsn;
  readonly dst: number;
  readonly src: number;
}

export interface MovieObject {
  readonly resumeIntention: boolean;
  readonly menuCallMask: boolean;
  readonly titleSearchMask: boolean;
  readonly cmds: readonly MobjCmd[];
}

export interface MovieObjects {
  readonly version: string;
  readonly objects: readonly MovieObject[];
}

const CMD_SIZE = 12;
const OBJECTS_START = 40;

/** mobj_parse_cmd: decodes one 12-byte HDMV command. */
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

/** _mobj_parse_object */
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

/** _mobj_parse */
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
