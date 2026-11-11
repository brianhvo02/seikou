/*
 * Ported from libbluray src/libbluray/hdmv/hdmv_vm.c
 * Copyright (C) 2010-2017  Petri Hintukainen <phintuka@users.sourceforge.net>
 *
 * Ported to TypeScript and modified for Seikou, 2026.
 *
 * SPDX-License-Identifier: LGPL-2.1-or-later
 */

import {
  BranchSub, CmpOpt, GotoOpt, InsnGroup, JumpOpt, PlayOpt, SetOpt, SetSub, SetSystemOpt,
  type MobjCmd, type MovieObject, type MovieObjects,
} from '@seikou/bdmv/mobj-parser';
import { PSR, type RegisterFile } from './registers';

/** hdmv_event_e */
export const HdmvEventType = {
  NONE: 0, END: 1, IG_END: 2, TITLE: 3, PLAY_PL: 4, PLAY_PL_PM: 5, PLAY_PL_PI: 6, PLAY_PI: 7, PLAY_PM: 8,
  PLAY_STOP: 9, STILL: 10, SET_BUTTON_PAGE: 11, ENABLE_BUTTON: 12, DISABLE_BUTTON: 13, POPUP_OFF: 14,
} as const;
export type HdmvEventType = (typeof HdmvEventType)[keyof typeof HdmvEventType];

/** HDMV_EVENT */
export interface HdmvEvent {
  readonly type: HdmvEventType;
  readonly param: number;
  readonly param2: number;
}

export interface HdmvVmOptions {
  readonly numTitles: number;
  readonly firstPlay: boolean;
  readonly topMenu: boolean;
  readonly seed?: number;
}

const PSR_FLAG = 0x80000000;
const MAX_LOOP = 1000000;
const EVENT_SLOTS = 5;
const TERMINATE_PC = 1 << 17;
const U64 = 0xffffffffffffffffn;
const NO_EVENT: HdmvEvent = { type: HdmvEventType.NONE, param: 0, param2: 0 };

/** _is_valid_reg */
function isValidReg(reg: number): boolean {
  return (reg & PSR_FLAG) !== 0 ? (reg & ~0x8000007f) === 0 : (reg & ~0x00000fff) === 0;
}

/** ADD_u32: saturates */
function addU32(a: number, b: number): number {
  const r = a + b;
  return r < 0xffffffff ? r : 0xffffffff;
}

/** MUL_u32: saturates; bigint because the product can exceed 2^53 */
function mulU32(a: number, b: number): number {
  const r = BigInt(a) * BigInt(b);
  return r < 0xffffffffn ? Number(r) : 0xffffffff;
}

export class HdmvVm {
  private pc = 0;
  private object: MovieObject | null = null;
  private igObject: MovieObject | null = null;
  private events: HdmvEvent[] = Array.from({ length: EVENT_SLOTS }, () => NO_EVENT);
  private rand: bigint;
  private playingObject: MovieObject | null = null;
  private playingPc = 0;
  private suspendedObject: MovieObject | null = null;
  private suspendedPc = 0;
  private readonly nvTimer = { time: 0, mobjId: 0 };

  constructor(
    private readonly movieObjects: MovieObjects,
    private readonly regs: RegisterFile,
    private readonly opts: HdmvVmOptions,
  ) {
    this.rand = BigInt(opts.seed ?? Math.floor(Date.now() / 1000));
  }

  // ---- registers: PSR and GPR access ----

  /** _store_reg */
  private storeReg(reg: number, val: number): number {
    if (!isValidReg(reg)) return -1;
    if ((reg & PSR_FLAG) !== 0) return -1;
    return this.regs.gprWrite(reg, val);
  }

  /** _read_reg */
  private readReg(reg: number): number {
    if (!isValidReg(reg)) return 0;
    if ((reg & PSR_FLAG) !== 0) return this.regs.psrRead(reg & 0x7f);
    return this.regs.gprRead(reg);
  }

  /** _read_setstream_regs */
  private readSetstreamRegs(val: number): number {
    const flags = (val & 0xf000f000) >>> 0;
    const val0 = this.regs.gprRead(val & 0xfff) & 0x0fff;
    const val1 = this.regs.gprRead((val >>> 16) & 0xfff) & 0x0fff;
    return (flags | val0 | (val1 << 16)) >>> 0;
  }

  /** _read_setbuttonpage_reg */
  private readSetbuttonpageReg(val: number): number {
    const flags = (val & 0xc0000000) >>> 0;
    const val0 = this.regs.gprRead(val & 0xfff) & 0x3fffffff;
    return (flags | val0) >>> 0;
  }

  /** _store_result */
  private storeResult(cmd: MobjCmd, src: number, dst: number, src0: number, dst0: number): number {
    let ret = 0;
    if (dst !== dst0) {
      if (cmd.insn.immOp1) return -1;
      ret = this.storeReg(cmd.dst, dst);
    }
    if (src !== src0) {
      if (cmd.insn.immOp1) return -1;
      ret += this.storeReg(cmd.src, src);
    }
    return ret;
  }

  /** _fetch_operand */
  private fetchOperand(setstream: boolean, setbuttonpage: boolean, imm: boolean, value: number): number {
    if (imm) return value >>> 0;
    if (setstream) return this.readSetstreamRegs(value);
    if (setbuttonpage) return this.readSetbuttonpageReg(value);
    return this.readReg(value) >>> 0;
  }

  /** _fetch_operands */
  private fetchOperands(cmd: MobjCmd): { dst: number; src: number } {
    const insn = cmd.insn;
    const isSetSystem = insn.grp === InsnGroup.SET && insn.subGrp === SetSub.SETSYSTEM;
    const setstream = isSetSystem && (insn.setOpt === SetSystemOpt.SET_STREAM || insn.setOpt === SetSystemOpt.SET_SEC_STREAM);
    const setbuttonpage = isSetSystem && insn.setOpt === SetSystemOpt.SET_BUTTON_PAGE;
    let dst = 0;
    let src = 0;
    if (insn.opCnt > 0) dst = this.fetchOperand(setstream, setbuttonpage, insn.immOp1, cmd.dst);
    if (insn.opCnt > 1) src = this.fetchOperand(setstream, setbuttonpage, insn.immOp2, cmd.src);
    return { dst, src };
  }

  // ---- event queue ----

  /** _get_event */
  private getEvent(): HdmvEvent | null {
    const first = this.events[0]!;
    if (first.type === HdmvEventType.NONE) return null;
    this.events.shift();
    this.events.push(NO_EVENT);
    return first;
  }

  /** _queue_event2: only the first four slots are usable, as in libbluray. */
  private queueEvent2(type: HdmvEventType, param: number, param2: number): number {
    for (let i = 0; i < EVENT_SLOTS - 1; i++) {
      if (this.events[i]!.type === HdmvEventType.NONE) {
        this.events[i] = { type, param: param >>> 0, param2: param2 >>> 0 };
        return 0;
      }
    }
    return -1;
  }

  /** _queue_event */
  private queueEvent(type: HdmvEventType, param: number): number {
    return this.queueEvent2(type, param, 0);
  }

  // ---- object state ----

  /** _free_ig_object */
  private freeIgObject(): void {
    this.igObject = null;
  }

  /** _resume_from_play_pl */
  private resumeFromPlayPl(): number {
    if (!this.playingObject) return -1;
    this.object = this.playingObject;
    this.pc = this.playingPc + 1;
    this.playingObject = null;
    this.freeIgObject();
    return 0;
  }

  /** _jump_object */
  private jumpObject(object: number): number {
    const target = this.movieObjects.objects[object];
    if (!target) return -1;
    this.queueEvent(HdmvEventType.PLAY_STOP, 0);
    this.freeIgObject();
    this.playingObject = null;
    this.pc = 0;
    this.object = target;
    return 0;
  }

  /** _suspended_at_play_pl */
  private suspendedAtPlayPl(): boolean {
    const o = this.suspendedObject;
    if (!o) return false;
    const insn = o.cmds[this.suspendedPc]?.insn;
    if (!insn) return false;
    return insn.grp === InsnGroup.BRANCH && insn.subGrp === BranchSub.PLAY &&
      (insn.branchOpt === PlayOpt.PLAY_PL || insn.branchOpt === PlayOpt.PLAY_PL_PI || insn.branchOpt === PlayOpt.PLAY_PL_PM);
  }

  /** _suspend_for_play_pl */
  private suspendForPlayPl(): number {
    if (this.playingObject) return -1;
    this.playingObject = this.object;
    this.playingPc = this.pc;
    this.object = null;
    return 0;
  }

  /** _suspend_object */
  private suspendObject(psrBackup: boolean): void {
    if (psrBackup) this.regs.saveState();

    if (this.igObject) {
      if (!this.playingObject) return;
      this.suspendedObject = this.playingObject;
      this.suspendedPc = this.playingPc;
      this.playingObject = null;
    } else {
      if (this.playingObject) return;
      this.suspendedObject = this.object;
      this.suspendedPc = this.pc;
    }

    this.object = null;
    this.freeIgObject();
  }

  /** _is_valid_title */
  private isValidTitle(title: number): boolean {
    if (title === 0) return this.opts.topMenu;
    if (title === 0xffff) return this.opts.firstPlay;
    return title > 0 && title <= this.opts.numTitles;
  }

  // ---- branching and playback control; the underscore names mirror libbluray's static functions ----

  /** _jump_title */
  private _jumpTitle(title: number): number {
    if (!this.isValidTitle(title)) return -1;
    this.suspendedObject = null;
    this.playingObject = null;
    this.regs.resetBackupRegisters();
    this.queueEvent(HdmvEventType.TITLE, title);
    return 0;
  }

  /** _call_title */
  private _callTitle(title: number): number {
    if (!this.isValidTitle(title)) return -1;
    this.suspendObject(true);
    this.queueEvent(HdmvEventType.TITLE, title);
    return 0;
  }

  /** _resume_object */
  private _resumeObject(psrRestore: boolean): number {
    if (!this.suspendedObject) return -1;

    this.object = null;
    this.playingObject = null;
    this.freeIgObject();

    if (psrRestore) {
      if (this.suspendedAtPlayPl()) {
        this.playingObject = this.suspendedObject;
        this.playingPc = this.suspendedPc;
        this.suspendedObject = null;
        this.regs.restoreState();
        return 0;
      }
      this.regs.restoreState();
    }

    this.object = this.suspendedObject;
    this.pc = this.suspendedPc + 1;
    this.suspendedObject = null;
    this.queueEvent(HdmvEventType.PLAY_STOP, 0);
    return 0;
  }

  /** _call_object */
  private _callObject(object: number): number {
    if (object >= this.movieObjects.objects.length) return -1;
    this.suspendObject(true);
    return this.jumpObject(object);
  }

  /** _play_at: playitem and playmark are C ints, -1 meaning absent. */
  private _playAt(playlist: number, playitem: number, playmark: number): number {
    if (this.igObject) return -1;
    const item = playitem | 0;
    const mark = playmark | 0;
    if (item >= 0) this.queueEvent2(HdmvEventType.PLAY_PL_PI, playlist, item);
    else if (mark >= 0) this.queueEvent2(HdmvEventType.PLAY_PL_PM, playlist, mark);
    else this.queueEvent(HdmvEventType.PLAY_PL, playlist);
    this.suspendForPlayPl();
    return 0;
  }

  /** _link_at */
  private _linkAt(playitem: number, playmark: number): number {
    if (!this.igObject) return -1;
    const item = playitem | 0;
    const mark = playmark | 0;
    if (item >= 0) this.queueEvent(HdmvEventType.PLAY_PI, item);
    else if (mark >= 0) this.queueEvent(HdmvEventType.PLAY_PM, mark);
    return 0;
  }

  /** _play_stop */
  private _playStop(): number {
    if (!this.igObject) return -1;
    this.queueEvent(HdmvEventType.PLAY_STOP, 1);
    return this.resumeFromPlayPl() < 0 ? -1 : 0;
  }

  // ---- SET/SYSTEM bodies ----

  /** _set_stream */
  private _setStream(dst: number, src: number): void {
    if ((dst & PSR_FLAG) !== 0) this.regs.psrWrite(PSR.PRIMARY_AUDIO_ID, (dst >>> 16) & 0xfff);
    if ((src & PSR_FLAG) !== 0) this.regs.psrWrite(PSR.IG_STREAM_ID, (src >>> 16) & 0xff);
    if ((src & 0x8000) !== 0) this.regs.psrWrite(PSR.ANGLE_NUMBER, src & 0xff);

    let psr2 = this.regs.psrRead(PSR.PG_STREAM);
    if ((dst & 0x8000) !== 0) psr2 = ((dst & 0xfff) | (psr2 & 0xfffff000)) >>> 0;
    const dispSFlag = ((dst & 0x4000) << 17) >>> 0;
    psr2 = (dispSFlag | (psr2 & 0x7fffffff)) >>> 0;
    this.regs.psrWrite(PSR.PG_STREAM, psr2);
  }

  /** _set_sec_stream */
  private _setSecStream(dst: number, src: number): void {
    const dispVFlag = (dst >>> 30) & 1;
    const dispAFlag = (src >>> 30) & 1;
    const textStFlags = (src >>> 13) & 3;

    let psr14 = this.regs.psrRead(PSR.SECONDARY_AUDIO_VIDEO);
    if ((dst & PSR_FLAG) !== 0) psr14 = (((dst & 0xff) << 8) | (psr14 & 0xffff00ff)) >>> 0;
    if ((dst & 0x00800000) !== 0) psr14 = ((((dst >>> 16) & 0xf) << 24) | (psr14 & 0xf0ffffff)) >>> 0;
    if ((src & PSR_FLAG) !== 0) psr14 = (((src >>> 16) & 0xff) | (psr14 & 0xffffff00)) >>> 0;
    psr14 = ((dispVFlag << 31) | (psr14 & 0x7fffffff)) >>> 0;
    psr14 = ((dispAFlag << 30) | (psr14 & 0xbfffffff)) >>> 0;
    this.regs.psrWrite(PSR.SECONDARY_AUDIO_VIDEO, psr14);

    let psr2 = this.regs.psrRead(PSR.PG_STREAM);
    if ((src & 0x8000) !== 0) psr2 = (((src & 0xfff) << 16) | (psr2 & 0xf000ffff)) >>> 0;
    psr2 = ((textStFlags << 30) | (psr2 & 0x3fffffff)) >>> 0;
    this.regs.psrWrite(PSR.PG_STREAM, psr2);
  }

  /** _set_nv_timer: stores the expiry only; libbluray never checks it either (_check_nv_timer is unused). */
  private _setNvTimer(dst: number, src: number): void {
    const mobjId = dst & 0xffff;
    const timeout = src & 0xffff;

    if (!timeout) {
      this.nvTimer.time = 0;
      this.regs.psrWrite(PSR.NAV_TIMER, 0);
      return;
    }
    if (mobjId >= this.movieObjects.objects.length) return;
    if (timeout > 300) return;

    this.nvTimer.time = Math.floor(Date.now() / 1000) + timeout;
    this.nvTimer.mobjId = mobjId;
    this.regs.psrWrite(PSR.NAV_TIMER, timeout);
  }

  /** _set_button_page */
  private _setButtonPage(dst: number, src: number): void {
    if (this.igObject) {
      const param = ((src & 0xc0000000) | ((dst & PSR_FLAG) >>> 2) | ((src & 0xff) << 16) | (dst & 0xffff)) >>> 0;
      this.queueEvent(HdmvEventType.SET_BUTTON_PAGE, param);
      this.pc = TERMINATE_PC;
      return;
    }
    if ((dst & PSR_FLAG) !== 0) this.regs.psrWrite(PSR.SELECTED_BUTTON_ID, dst & 0xffff);
    if ((src & PSR_FLAG) !== 0) this.regs.psrWrite(PSR.MENU_PAGE_ID, src & 0xff);
  }

  /** _enable_button */
  private _enableButton(dst: number, enable: boolean): void {
    if (this.igObject) this.queueEvent(enable ? HdmvEventType.ENABLE_BUTTON : HdmvEventType.DISABLE_BUTTON, dst);
  }

  /** _popup_off */
  private _popupOff(): void {
    if (this.igObject) this.queueEvent(HdmvEventType.POPUP_OFF, 1);
  }

  /** _set_still_mode */
  private _setStillMode(enable: boolean): void {
    if (this.igObject) this.queueEvent(HdmvEventType.STILL, enable ? 1 : 0);
  }

  /** _set_output_mode: only a profile 5 player honours it. */
  private _setOutputMode(dst: number): void {
    if (((this.regs.psrRead(PSR.PROFILE_VERSION) & 0x130240) >>> 0) !== 0x130240) return;
    const psr22 = this.regs.psrRead(PSR['3D_STATUS']);
    this.regs.psrWrite(PSR['3D_STATUS'], (dst & 1) !== 0 ? (psr22 | 1) >>> 0 : (psr22 & ~1) >>> 0);
  }

  /** _set_stream_ss: libbluray ignores it in 2D and leaves 3D unimplemented, so it is a no-op. */
  private _setStreamSs(_dst: number, _src: number): void {}

  /** _setsystem_0x10 */
  private _setsystem0x10(dst: number, _src: number): void {
    this.regs.psrWrite(103, dst);
  }

  // ---- interpreter ----

  /** RAND_u32 */
  private randU32(range: number): number {
    this.rand = (this.rand * 6364136223846793005n + 1n) & U64;
    if (range === 0) return 1;
    return Number((this.rand >> 32n) % BigInt(range)) + 1;
  }

  /** _hdmv_step: executes the next instruction of the current program. */
  private step(): number {
    const cmd = this.object!.cmds[this.pc]!;
    const insn = cmd.insn;
    let { dst, src } = this.fetchOperands(cmd);
    let incPc = 1;

    switch (insn.grp) {
      case InsnGroup.BRANCH:
        switch (insn.subGrp) {
          case BranchSub.GOTO:
            switch (insn.branchOpt) {
              case GotoOpt.NOP: break;
              case GotoOpt.GOTO: this.pc = dst; incPc = 0; break;
              case GotoOpt.BREAK: this.pc = TERMINATE_PC; break;
              default: break;
            }
            break;
          case BranchSub.JUMP:
            switch (insn.branchOpt) {
              case JumpOpt.JUMP_TITLE: this._jumpTitle(dst); break;
              case JumpOpt.CALL_TITLE: this._callTitle(dst); break;
              case JumpOpt.RESUME: this._resumeObject(true); break;
              case JumpOpt.JUMP_OBJECT: if (this.jumpObject(dst) === 0) incPc = 0; break;
              case JumpOpt.CALL_OBJECT: if (this._callObject(dst) === 0) incPc = 0; break;
              default: break;
            }
            break;
          case BranchSub.PLAY:
            switch (insn.branchOpt) {
              case PlayOpt.PLAY_PL: this._playAt(dst, -1, -1); break;
              case PlayOpt.PLAY_PL_PI: this._playAt(dst, src, -1); break;
              case PlayOpt.PLAY_PL_PM: this._playAt(dst, -1, src); break;
              case PlayOpt.LINK_PI: this._linkAt(dst, -1); break;
              case PlayOpt.LINK_MK: this._linkAt(-1, dst); break;
              case PlayOpt.TERMINATE_PL: if (this._playStop() === 0) incPc = 0; break;
              default: break;
            }
            break;
          default: break;
        }
        break;

      case InsnGroup.CMP:
        switch (insn.cmpOpt) {
          case CmpOpt.BC: this.pc += (src & ~dst) !== 0 ? 1 : 0; break;
          case CmpOpt.EQ: this.pc += dst === src ? 0 : 1; break;
          case CmpOpt.NE: this.pc += dst !== src ? 0 : 1; break;
          case CmpOpt.GE: this.pc += dst >= src ? 0 : 1; break;
          case CmpOpt.GT: this.pc += dst > src ? 0 : 1; break;
          case CmpOpt.LE: this.pc += dst <= src ? 0 : 1; break;
          case CmpOpt.LT: this.pc += dst < src ? 0 : 1; break;
          default: break;
        }
        break;

      case InsnGroup.SET:
        switch (insn.subGrp) {
          case SetSub.SET: {
            const src0 = src;
            const dst0 = dst;
            switch (insn.setOpt) {
              case SetOpt.MOVE: dst = src; break;
              case SetOpt.SWAP: [src, dst] = [dst, src]; break;
              case SetOpt.SUB: dst = dst > src ? dst - src : 0; break;
              case SetOpt.DIV: dst = src > 0 ? Math.floor(dst / src) : 0xffffffff; break;
              case SetOpt.MOD: dst = src > 0 ? dst % src : 0xffffffff; break;
              case SetOpt.ADD: dst = addU32(src, dst); break;
              case SetOpt.MUL: dst = mulU32(dst, src); break;
              case SetOpt.RND: dst = this.randU32(src); break;
              case SetOpt.AND: dst = (dst & src) >>> 0; break;
              case SetOpt.OR: dst = (dst | src) >>> 0; break;
              case SetOpt.XOR: dst = (dst ^ src) >>> 0; break;
              case SetOpt.BITSET: if (src < 32) dst = (dst | (1 << src)) >>> 0; break;
              case SetOpt.BITCLR: if (src < 32) dst = (dst & ~(1 << src)) >>> 0; break;
              case SetOpt.SHL: dst = src < 32 ? (dst << src) >>> 0 : 0; break;
              case SetOpt.SHR: dst = src < 32 ? dst >>> src : 0; break;
              default: break;
            }
            if (dst !== dst0 || src !== src0) this.storeResult(cmd, src, dst, src0, dst0);
            break;
          }
          case SetSub.SETSYSTEM:
            switch (insn.setOpt) {
              case SetSystemOpt.SET_STREAM: this._setStream(dst, src); break;
              case SetSystemOpt.SET_SEC_STREAM: this._setSecStream(dst, src); break;
              case SetSystemOpt.SET_NV_TIMER: this._setNvTimer(dst, src); break;
              case SetSystemOpt.SET_BUTTON_PAGE: this._setButtonPage(dst, src); break;
              case SetSystemOpt.ENABLE_BUTTON: this._enableButton(dst, true); break;
              case SetSystemOpt.DISABLE_BUTTON: this._enableButton(dst, false); break;
              case SetSystemOpt.POPUP_OFF: this._popupOff(); break;
              case SetSystemOpt.STILL_ON: this._setStillMode(true); break;
              case SetSystemOpt.STILL_OFF: this._setStillMode(false); break;
              case SetSystemOpt.SET_OUTPUT_MODE: this._setOutputMode(dst); break;
              case SetSystemOpt.SET_STREAM_SS: this._setStreamSs(dst, src); break;
              case SetSystemOpt.SETSYSTEM_0x10: this._setsystem0x10(dst, src); break;
              default: break;
            }
            break;
          default: break;
        }
        break;

      default: break;
    }

    this.pc += incPc;
    return 0;
  }

  // ---- interface ----

  /** hdmv_vm_select_object */
  selectObject(id: number): number {
    return this.jumpObject(id);
  }

  /** hdmv_vm_set_object: runs button commands as the IG object. */
  setObject(cmds: readonly MobjCmd[]): number {
    this.object = null;
    this.freeIgObject();
    if (cmds.length === 0) return -1;
    const ig: MovieObject = { resumeIntention: false, menuCallMask: false, titleSearchMask: false, cmds: cmds.slice() };
    this.pc = 0;
    this.igObject = ig;
    this.object = ig;
    return 0;
  }

  /** hdmv_vm_get_event */
  nextEvent(): HdmvEvent | null {
    return this.getEvent();
  }

  /** hdmv_vm_running */
  running(): boolean {
    return this.object !== null;
  }

  /** hdmv_vm_get_uo_mask */
  uoMask(): number {
    const o = this.object && !this.igObject ? this.object : (this.playingObject ?? this.suspendedObject);
    if (!o) return 0;
    return (o.menuCallMask ? 1 : 0) | (o.titleSearchMask ? 2 : 0);
  }

  /** hdmv_vm_resume */
  resume(): number {
    return this.resumeFromPlayPl();
  }

  /**
   * Not in libbluray: puts the VM where it would be had movie object `object` just executed the PLAY_PL* at `pc`, so
   * that the end of the playlist (resume()) continues at `pc + 1`. Used to resume a title at a saved place.
   */
  resumeInto(object: number, pc: number): void {
    const target = this.movieObjects.objects[object];
    if (!target) return;
    this.freeIgObject();
    this.suspendedObject = null;
    this.object = null;
    this.playingObject = target;
    this.playingPc = pc;
  }

  /** hdmv_vm_suspend_pl */
  suspendPlaylist(): number {
    if (this.object || this.igObject) return -1;
    if (!this.playingObject) return -1;
    if (!this.playingObject.resumeIntention) {
      this.playingObject = null;
      return 0;
    }
    this.suspendedObject = this.playingObject;
    this.suspendedPc = this.playingPc;
    this.playingObject = null;
    this.regs.saveState();
    return 0;
  }

  /** hdmv_vm_run (_vm_run): null is libbluray's -1. */
  run(): HdmvEvent | null {
    let maxLoop = MAX_LOOP;

    const pending = this.getEvent();
    if (pending) return pending;

    if (!this.object) return null;

    while (--maxLoop > 0) {
      if (!this.object) return this.getEvent() ?? NO_EVENT;

      if (this.pc >= this.object.cmds.length) {
        this.object = null;
        if (this.igObject) {
          this.freeIgObject();
          return { type: HdmvEventType.IG_END, param: 0, param2: 0 };
        }
        return { type: HdmvEventType.END, param: 0, param2: 0 };
      }

      if (this.step() < 0) {
        this.object = null;
        return null;
      }

      const ev = this.getEvent();
      if (ev) return ev;
    }

    this.object = null;
    return null;
  }
}
