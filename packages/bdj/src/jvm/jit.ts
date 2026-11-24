/*
 * Original code for Seikou: the BD-J virtual machine's compiler of hot methods to JavaScript (a JIT). A compiled
 * method runs one frame of that method exactly as the interpreter's inner loop would, on the same Frame (its locals,
 * operand stack, pc and sp), so green threads, native continuations, exceptions, monitors and stack traces work
 * unchanged: what it compiles away is the opcode dispatch, operand decoding, the operand-stack pointer (the depth at
 * each instruction is fixed, JVM Specification §4.10) and constant-pool lookups already resolved. It counts the time
 * slice's budget per instruction as the interpreter does, so threads interleave identically with and without it.
 *
 * Copyright (C) 2026 Seikou contributors
 *
 * SPDX-License-Identifier: LGPL-3.0-or-later
 */

import type { CpEntry } from './classfile';
import type { Frame, NativeResult } from './interpreter';
import type { JClass, JField, JMethod } from './loader';
import type { JThread } from './threads';
import type { Jvm } from './jvm';
import type { JArray, JObject, JValue } from './values';

/** How a compiled method left: the outer loop goes on, the interpreter takes the frame at its pc, or the slice ends. */
export const JIT_EXIT_CONTINUE = 0;
/** The interpreter runs the frame from its pc (the budget is short of a block, or the pc starts no block). */
export const JIT_EXIT_INTERPRET = 1;
/** The slice ends ('budget'), as after a monitorexit that handed the monitor to another thread. */
export const JIT_EXIT_YIELD = 2;

/**
 * A compiled method: runs `f` (a frame of the method) from `f.pc` with `budget` instructions left in the slice, and
 * returns the budget left, with how it left in the runtime's `exit`.
 * @internal
 */
export type CompiledMethod = (jvm: Jvm, t: JThread, f: Frame, budget: number) => number;

/**
 * What compiled code calls: the interpreter's own functions, so a compiled method resolves, calls, returns, throws and
 * initialises classes exactly as the interpreter does.
 * @internal
 */
export interface JitRuntime {
  /** How the last compiled method left (JIT_EXIT_*). */
  exit: number;
  readonly resolveClass: (jvm: Jvm, cls: JClass, index: number) => JClass;
  readonly resolveField: (jvm: Jvm, cls: JClass, index: number) => JField;
  readonly resolveMethod: (jvm: Jvm, cls: JClass, index: number) => JMethod;
  readonly resolveLdc: (jvm: Jvm, t: JThread, cls: JClass, index: number) => JValue;
  readonly call: (jvm: Jvm, t: JThread, f: Frame, m: JMethod, nextPc: number) => void;
  readonly ret: (jvm: Jvm, t: JThread, f: Frame, v: JValue | undefined, wide: boolean) => void;
  readonly ensureInit: (jvm: Jvm, t: JThread, f: Frame, c: JClass) => boolean;
  readonly throwInto: (jvm: Jvm, t: JThread, exc: JObject) => void;
  /** The interpreter's handling of an exception escaping an instruction at `f.pc`, whose stack depth was `sp`. */
  readonly caught: (jvm: Jvm, t: JThread, f: Frame, e: unknown, sp: number) => void;
  readonly checkIndex: (arr: JArray | null, i: number) => JArray;
  readonly multiArray: (jvm: Jvm, cls: JClass, counts: readonly number[], d: number) => JArray;
  readonly toInt: (v: number) => number;
  readonly toLong: (v: number) => bigint;
  readonly longToFloat: (v: bigint) => number;
  readonly fcmp: (a: number, b: number, nan: number) => number;
  readonly selectMethod: (cls: JClass, m: JMethod) => JMethod | null;
  readonly linkCallSite: (jvm: Jvm, t: JThread, m: JMethod, pc: number, index: number) => NativeResult;
  readonly externalName: (name: string) => string;
  /** Thrown by compiled code like the interpreter's own: an exception to create once the frame's pc is saved. */
  readonly PendingThrow: new (cls: string, message?: string) => Error;
  readonly LoadPending: new (work: NativeResult) => Error;
  /** A loop hook's "no shortcut" answer. */
  readonly DECLINE: unknown;
}

/** Bytecode longer than this stays interpreted (such methods run once, as class initialisers, and parse slowly). */
export const JIT_MAX_CODE_BYTES = 16 * 1024;

/** Why a method is not compiled. */
export type JitRefusal = 'native' | 'too-long' | 'jsr' | 'opcode' | 'stack' | 'constant';

/** The stack depth before each instruction and the blocks of a method, or why it can't be compiled. */
export interface JitAnalysis {
  /** Instruction start offsets, in order. */
  readonly starts: readonly number[];
  /** Operand-stack depth before the instruction at each start (undefined: unreachable). */
  readonly depth: readonly (number | undefined)[];
  /** Instruction starts that begin a block. */
  readonly leaders: ReadonlySet<number>;
}

const OPCODE_LENGTH = new Int8Array(256).fill(-1);
(() => {
  const set = (from: number, to: number, n: number): void => {
    for (let op = from; op <= to; op++) OPCODE_LENGTH[op] = n;
  };
  set(0x00, 0x0f, 1);
  OPCODE_LENGTH[0x10] = 2;
  OPCODE_LENGTH[0x11] = 3;
  OPCODE_LENGTH[0x12] = 2;
  set(0x13, 0x14, 3);
  set(0x15, 0x19, 2);
  set(0x1a, 0x35, 1);
  set(0x36, 0x3a, 2);
  set(0x3b, 0x83, 1);
  OPCODE_LENGTH[0x84] = 3;
  set(0x85, 0x98, 1);
  set(0x99, 0xa8, 3);
  OPCODE_LENGTH[0xa9] = 2;
  set(0xac, 0xb1, 1);
  set(0xb2, 0xb8, 3);
  set(0xb9, 0xba, 5);
  OPCODE_LENGTH[0xbb] = 3;
  OPCODE_LENGTH[0xbc] = 2;
  OPCODE_LENGTH[0xbd] = 3;
  set(0xbe, 0xbf, 1);
  set(0xc0, 0xc1, 3);
  set(0xc2, 0xc3, 1);
  OPCODE_LENGTH[0xc5] = 4;
  set(0xc6, 0xc7, 3);
  set(0xc8, 0xc9, 5);
  OPCODE_LENGTH[0xcb] = 3;
})();

const s16 = (code: Uint8Array, p: number): number => (((code[p]! << 8) | code[p + 1]!) << 16) >> 16;
const u16 = (code: Uint8Array, p: number): number => (code[p]! << 8) | code[p + 1]!;
const s32 = (code: Uint8Array, p: number): number => (code[p]! << 24) | (code[p + 1]! << 16) | (code[p + 2]! << 8) | code[p + 3]!;

function insnLength(code: Uint8Array, pc: number): number {
  const op = code[pc]!;
  if (op === 0xaa) {
    const p = (pc + 4) & ~3;
    return p - pc + 12 + (s32(code, p + 8) - s32(code, p + 4) + 1) * 4;
  }
  if (op === 0xab) {
    const p = (pc + 4) & ~3;
    return p - pc + 8 + s32(code, p + 4) * 8;
  }
  if (op === 0xc4) return code[pc + 1] === 0x84 ? 6 : 4;
  return OPCODE_LENGTH[op]!;
}

class Refused extends Error {
  constructor(readonly reason: JitRefusal) {
    super(reason);
  }
}

function cpEntry(cls: JClass, index: number): CpEntry {
  return cls.file?.cp[index] ?? null;
}

function utf8(cls: JClass, index: number): string {
  const e = cpEntry(cls, index);
  if (e?.tag !== 'utf8') throw new Refused('constant');
  return e.value;
}

/** A member reference's descriptor (fieldref, methodref, imethodref or indy). */
function refDesc(cls: JClass, index: number): string {
  const e = cpEntry(cls, index);
  if (e?.tag !== 'fieldref' && e?.tag !== 'methodref' && e?.tag !== 'imethodref' && e?.tag !== 'indy') throw new Refused('constant');
  const nat = cpEntry(cls, e.nat);
  if (nat?.tag !== 'nat') throw new Refused('constant');
  return utf8(cls, nat.desc);
}

const slotsOf = (desc: string): number => (desc === 'J' || desc === 'D' ? 2 : desc === 'V' ? 0 : 1);

/** Argument slots and return slots of a method descriptor. */
function methodSlots(desc: string): { args: number; ret: number } {
  let args = 0;
  let i = 1;
  while (desc.charCodeAt(i) !== 0x29) {
    const c = desc.charCodeAt(i);
    if (c === 0x4a || c === 0x44) {
      args += 2;
      i++;
    } else {
      args += 1;
      while (desc.charCodeAt(i) === 0x5b) i++;
      i = desc.charCodeAt(i) === 0x4c ? desc.indexOf(';', i) + 1 : i + 1;
      if (i === 0) throw new Refused('constant');
    }
  }
  return { args, ret: slotsOf(desc.slice(i + 1)) };
}

/** [slots popped, slots pushed] of the instruction at `pc` (control transfers handled by the caller). */
function stackEffect(m: JMethod, code: Uint8Array, pc: number): readonly [number, number] {
  const op = code[pc]!;
  const cls = m.cls;
  if (op <= 0x08) return op === 0 ? [0, 0] : [0, 1];
  if (op <= 0x0a) return [0, 2];
  if (op <= 0x0d) return [0, 1];
  if (op <= 0x0f) return [0, 2];
  if (op <= 0x13) {
    if (op === 0x12 || op === 0x13) {
      const e = cpEntry(cls, op === 0x12 ? code[pc + 1]! : u16(code, pc + 1));
      if (e?.tag === 'long' || e?.tag === 'double') throw new Refused('constant');
    }
    return [0, 1];
  }
  if (op === 0x14) return [0, 2];
  if (op === 0x15 || op === 0x17 || op === 0x19) return [0, 1];
  if (op === 0x16 || op === 0x18) return [0, 2];
  if (op <= 0x1d) return [0, 1];
  if (op <= 0x21) return [0, 2];
  if (op <= 0x25) return [0, 1];
  if (op <= 0x29) return [0, 2];
  if (op <= 0x2d) return [0, 1];
  if (op <= 0x35) return op === 0x2f || op === 0x31 ? [2, 2] : [2, 1];
  if (op === 0x36 || op === 0x38 || op === 0x3a) return [1, 0];
  if (op === 0x37 || op === 0x39) return [2, 0];
  if (op <= 0x3e) return [1, 0];
  if (op <= 0x42) return [2, 0];
  if (op <= 0x46) return [1, 0];
  if (op <= 0x4a) return [2, 0];
  if (op <= 0x4e) return [1, 0];
  if (op <= 0x56) return op === 0x50 || op === 0x52 ? [4, 0] : [3, 0];
  switch (op) {
    case 0x57: return [1, 0];
    case 0x58: return [2, 0];
    case 0x59: return [1, 2];
    case 0x5a: return [2, 3];
    case 0x5b: return [3, 4];
    case 0x5c: return [2, 4];
    case 0x5d: return [3, 5];
    case 0x5e: return [4, 6];
    case 0x5f: return [2, 2];
  }
  if (op <= 0x73) return (op - 0x60) % 2 === 0 ? [2, 1] : [4, 2];
  if (op <= 0x77) return (op - 0x74) % 2 === 0 ? [1, 1] : [2, 2];
  if (op <= 0x7d) return (op - 0x78) % 2 === 0 ? [2, 1] : [3, 2];
  if (op <= 0x83) return (op - 0x7e) % 2 === 0 ? [2, 1] : [4, 2];
  if (op === 0x84) return [0, 0];
  switch (op) {
    case 0x85: return [1, 2];
    case 0x86: return [1, 1];
    case 0x87: return [1, 2];
    case 0x88: return [2, 1];
    case 0x89: return [2, 1];
    case 0x8a: return [2, 2];
    case 0x8b: return [1, 1];
    case 0x8c: return [1, 2];
    case 0x8d: return [1, 2];
    case 0x8e: return [2, 1];
    case 0x8f: return [2, 2];
    case 0x90: return [2, 1];
    case 0x91: case 0x92: case 0x93: return [1, 1];
    case 0x94: return [4, 1];
    case 0x95: case 0x96: return [2, 1];
    case 0x97: case 0x98: return [4, 1];
  }
  if (op <= 0x9e) return [1, 0];
  if (op <= 0xa6) return [2, 0];
  if (op === 0xa7 || op === 0xc8 || op === 0xcb) return [0, 0];
  if (op === 0xaa || op === 0xab) return [1, 0];
  if (op >= 0xac && op <= 0xb1) return [op === 0xb1 ? 0 : op === 0xad || op === 0xaf ? 2 : 1, 0];
  switch (op) {
    case 0xb2: return [0, slotsOf(refDesc(cls, u16(code, pc + 1)))];
    case 0xb3: return [slotsOf(refDesc(cls, u16(code, pc + 1))), 0];
    case 0xb4: return [1, slotsOf(refDesc(cls, u16(code, pc + 1)))];
    case 0xb5: return [1 + slotsOf(refDesc(cls, u16(code, pc + 1))), 0];
    case 0xb6: case 0xb7: case 0xb9: {
      const s = methodSlots(refDesc(cls, u16(code, pc + 1)));
      return [s.args + 1, s.ret];
    }
    case 0xb8: case 0xba: {
      const s = methodSlots(refDesc(cls, u16(code, pc + 1)));
      return [s.args, s.ret];
    }
    case 0xbb: return [0, 1];
    case 0xbc: case 0xbd: case 0xbe: case 0xc0: case 0xc1: return [1, 1];
    case 0xbf: return [1, 0];
    case 0xc2: case 0xc3: return [1, 0];
    case 0xc4: {
      const w = code[pc + 1]!;
      if (w === 0x15 || w === 0x17 || w === 0x19) return [0, 1];
      if (w === 0x16 || w === 0x18) return [0, 2];
      if (w === 0x36 || w === 0x38 || w === 0x3a) return [1, 0];
      if (w === 0x37 || w === 0x39) return [2, 0];
      if (w === 0x84) return [0, 0];
      throw new Refused(w === 0xa9 ? 'jsr' : 'opcode');
    }
    case 0xc5: return [code[pc + 3]!, 1];
    case 0xc6: case 0xc7: return [1, 0];
  }
  throw new Refused(op === 0xa8 || op === 0xa9 || op === 0xc9 ? 'jsr' : 'opcode');
}

/** Branch and switch targets of the instruction at `pc`, and whether control can also fall through to the next. */
function successors(code: Uint8Array, pc: number, len: number): { targets: number[]; falls: boolean } {
  const op = code[pc]!;
  if ((op >= 0x99 && op <= 0xa6) || op === 0xc6 || op === 0xc7) return { targets: [pc + s16(code, pc + 1)], falls: true };
  // a loop hook either jumps like its goto or returns a pc of its own, the loop's exit (treated as the next instruction)
  if (op === 0xcb) return { targets: [pc + s16(code, pc + 1)], falls: true };
  if (op === 0xa7) return { targets: [pc + s16(code, pc + 1)], falls: false };
  if (op === 0xc8) return { targets: [pc + s32(code, pc + 1)], falls: false };
  if (op === 0xaa) {
    const p = (pc + 4) & ~3;
    const n = s32(code, p + 8) - s32(code, p + 4) + 1;
    const targets = [pc + s32(code, p)];
    for (let i = 0; i < n; i++) targets.push(pc + s32(code, p + 12 + i * 4));
    return { targets, falls: false };
  }
  if (op === 0xab) {
    const p = (pc + 4) & ~3;
    const n = s32(code, p + 4);
    const targets = [pc + s32(code, p)];
    for (let i = 0; i < n; i++) targets.push(pc + s32(code, p + 12 + i * 8));
    return { targets, falls: false };
  }
  if ((op >= 0xac && op <= 0xb1) || op === 0xbf) return { targets: [], falls: false };
  void len;
  return { targets: [], falls: true };
}

/**
 * The instruction can leave the frame (a call, a return, a throw, a blocked monitor, a class to initialise, a
 * constant to resolve through Java) or hands control to a hook: the next instruction starts a block.
 */
function endsBlock(op: number): boolean {
  return (op >= 0x99 && op <= 0xb1) || (op >= 0xb6 && op <= 0xba) || op === 0xbf || op === 0xc2 || op === 0xc3 || op === 0xc6 || op === 0xc7 || op === 0xc8 || op === 0xcb;
}

/** Finds the instructions, the stack depth before each and the blocks; throws Refused for what is not compiled. */
export function analyse(m: JMethod): JitAnalysis {
  const code = m.code?.code;
  if (!code || m.isNative) throw new Refused('native');
  if (code.length > JIT_MAX_CODE_BYTES) throw new Refused('too-long');
  const starts: number[] = [];
  const index = new Int32Array(code.length + 1).fill(-1);
  for (let pc = 0; pc < code.length; ) {
    index[pc] = starts.length;
    starts.push(pc);
    const len = insnLength(code, pc);
    if (len <= 0) {
      const op = code[pc]!;
      throw new Refused(op === 0xa8 || op === 0xa9 || op === 0xc9 ? 'jsr' : 'opcode');
    }
    pc += len;
    if (pc > code.length) throw new Refused('opcode');
  }
  const depth: (number | undefined)[] = new Array<number | undefined>(starts.length).fill(undefined);
  const leaders = new Set<number>([0]);
  const work: number[] = [];
  const reach = (pc: number, d: number): void => {
    const i = pc >= 0 && pc < code.length ? index[pc]! : -1;
    if (i < 0) throw new Refused('stack');
    const have = depth[i];
    if (have === undefined) {
      depth[i] = d;
      work.push(i);
    } else if (have !== d) throw new Refused('stack');
  };
  reach(0, 0);
  for (const h of m.code!.handlers) {
    leaders.add(h.handlerPc);
    reach(h.handlerPc, 1);
  }
  const maxStack = m.code!.maxStack;
  while (work.length > 0) {
    const i = work.pop()!;
    const pc = starts[i]!;
    const op = code[pc]!;
    const [pop, push] = stackEffect(m, code, pc);
    const d = depth[i]! - pop;
    if (d < 0 || d + push > maxStack) throw new Refused('stack');
    const after = d + push;
    const len = insnLength(code, pc);
    const { targets, falls } = successors(code, pc, len);
    for (const target of targets) {
      leaders.add(target);
      reach(target, after);
    }
    if (falls) {
      if (pc + len >= code.length) throw new Refused('stack');
      if (endsBlock(op)) leaders.add(pc + len);
      reach(pc + len, after);
    } else if (pc + len < code.length) leaders.add(pc + len);
  }
  return { starts, depth, leaders };
}

/** Compiles `m`, or answers why it stays interpreted. */
export function compileMethod(m: JMethod, rt: JitRuntime): CompiledMethod | JitRefusal {
  let a: JitAnalysis;
  try {
    a = analyse(m);
  } catch (e) {
    if (e instanceof Refused) return e.reason;
    throw e;
  }
  let source: { body: string; consts: unknown[]; sp: Int32Array; refund: Int32Array };
  try {
    source = generate(m, a);
  } catch (e) {
    if (e instanceof Refused) return e.reason;
    throw e;
  }
  const factory = new Function('R', 'K', 'cls', 'SP', 'REF', source.body) as (
    rt: JitRuntime,
    consts: unknown[],
    cls: JClass,
    sp: Int32Array,
    refund: Int32Array,
  ) => CompiledMethod;
  return factory(rt, source.consts, m.cls, source.sp, source.refund);
}

const NPE = `throw new R.PendingThrow('java/lang/NullPointerException');`;

/** Generates the source of the compiled function's factory. */
function generate(m: JMethod, a: JitAnalysis): { body: string; consts: unknown[]; sp: Int32Array; refund: Int32Array } {
  const code = m.code!.code;
  const cls = m.cls;
  const consts: unknown[] = [];
  const constIndex = new Map<unknown, number>();
  const k = (v: unknown): string => {
    // numbers are not shared: a Map takes 0 and -0 for one key
    let i = typeof v === 'number' ? undefined : constIndex.get(v);
    if (i === undefined) {
      i = consts.length;
      consts.push(v);
      constIndex.set(v, i);
    }
    return `k${i}`;
  };
  // per pc: the depth before the instruction (-1: none) and the instructions after it in its block (the refund)
  const spAt = new Int32Array(code.length + 1).fill(-1);
  const refund = new Int32Array(code.length + 1);
  const out: string[] = [];
  const S = (i: number): string => `stack[${i}]`;
  const L = (n: number): string => `locals[${n}]`;
  const resolved = (index: number): unknown => cls.resolved[index];

  // blocks, in bytecode order: [leader index, end index)
  const blocks: [number, number][] = [];
  for (let i = 0; i < a.starts.length; ) {
    let j = i + 1;
    while (j < a.starts.length && !a.leaders.has(a.starts[j]!)) j++;
    blocks.push([i, j]);
    i = j;
  }

  for (const [bi, bj] of blocks) {
    const leader = a.starts[bi]!;
    const d0 = a.depth[bi];
    if (d0 === undefined) continue; // unreachable: the default case hands it to the interpreter if it ever runs
    const n = bj - bi;
    out.push(`case ${leader}:`);
    out.push(`if (budget < ${n}) { f.pc = ${leader}; f.sp = ${d0}; R.exit = 1; return budget; } budget -= ${n};`);
    for (let ii = bi; ii < bj; ii++) {
      const pc = a.starts[ii]!;
      const sp = a.depth[ii];
      if (sp === undefined) break;
      const rem = bj - ii - 1;
      spAt[pc] = sp;
      refund[pc] = rem;
      out.push(`// ${pc}`);
      out.push(instruction(pc, sp, rem));
    }
  }

  /**
   * Leaves the function where the interpreter goes back to its outer loop: when the frame is still on top and the
   * thread may go on, continue at its pc here, as the outer loop would.
   */
  function exitOuter(rem: number): string {
    return `${rem ? `budget += ${rem}; ` : ''}if (t.frames[t.frames.length - 1] === f && t.state === 'runnable' && !jvm.threads.preempted) { pc = f.pc; continue; } R.exit = 0; return budget;`;
  }

  function branch(target: number): string {
    return `{ pc = ${target}; continue; }`;
  }

  function instruction(pc: number, sp: number, rem: number): string {
    const op = code[pc]!;
    const at = `pc = ${pc};`;
    const idx = u16(code, pc + 1);
    switch (op) {
      case 0x00:
        return '';
      case 0x01:
        return `${S(sp)} = null;`;
      case 0x02: case 0x03: case 0x04: case 0x05: case 0x06: case 0x07: case 0x08:
        return `${S(sp)} = ${op - 0x03};`;
      case 0x09: case 0x0a:
        return `${S(sp)} = ${op - 0x09}n;`;
      case 0x0b: case 0x0c: case 0x0d:
        return `${S(sp)} = ${op - 0x0b};`;
      case 0x0e: case 0x0f:
        return `${S(sp)} = ${op - 0x0e};`;
      case 0x10:
        return `${S(sp)} = ${(code[pc + 1]! << 24) >> 24};`;
      case 0x11:
        return `${S(sp)} = ${s16(code, pc + 1)};`;
      case 0x12: case 0x13: {
        const ci = op === 0x12 ? code[pc + 1]! : idx;
        const e = cpEntry(cls, ci);
        if (e?.tag === 'int' || e?.tag === 'float') return `${S(sp)} = ${k(e.value)};`;
        if (e?.tag === 'string' && resolved(ci)) return `${S(sp)} = ${k(resolved(ci))};`;
        return `f.pc = ${pc}; ${at} ${S(sp)} = R.resolveLdc(jvm, t, cls, ${ci});`;
      }
      case 0x14: {
        const e = cpEntry(cls, idx);
        if (e?.tag !== 'long' && e?.tag !== 'double') return `${at} throw new R.PendingThrow('java/lang/ClassFormatError', 'bad ldc2_w constant ${idx}');`;
        return `${S(sp)} = ${k(e.value)};`;
      }
      case 0x15: case 0x16: case 0x17: case 0x18: case 0x19:
        return `${S(sp)} = ${L(code[pc + 1]!)};`;
      case 0x1a: case 0x1b: case 0x1c: case 0x1d:
        return `${S(sp)} = ${L(op - 0x1a)};`;
      case 0x1e: case 0x1f: case 0x20: case 0x21:
        return `${S(sp)} = ${L(op - 0x1e)};`;
      case 0x22: case 0x23: case 0x24: case 0x25:
        return `${S(sp)} = ${L(op - 0x22)};`;
      case 0x26: case 0x27: case 0x28: case 0x29:
        return `${S(sp)} = ${L(op - 0x26)};`;
      case 0x2a: case 0x2b: case 0x2c: case 0x2d:
        return `${S(sp)} = ${L(op - 0x2a)};`;
      case 0x2e: case 0x2f: case 0x30: case 0x31: case 0x32: case 0x33: case 0x34: case 0x35:
        return `${at} { const i = ${S(sp - 1)}; const arr = R.checkIndex(${S(sp - 2)}, i); ${S(sp - 2)} = arr.data[i]; }`;
      case 0x36: case 0x38: case 0x3a:
        return `${L(code[pc + 1]!)} = ${S(sp - 1)};`;
      case 0x37: case 0x39:
        return `${L(code[pc + 1]!)} = ${S(sp - 2)};`;
      case 0x3b: case 0x3c: case 0x3d: case 0x3e:
        return `${L(op - 0x3b)} = ${S(sp - 1)};`;
      case 0x3f: case 0x40: case 0x41: case 0x42:
        return `${L(op - 0x3f)} = ${S(sp - 2)};`;
      case 0x43: case 0x44: case 0x45: case 0x46:
        return `${L(op - 0x43)} = ${S(sp - 1)};`;
      case 0x47: case 0x48: case 0x49: case 0x4a:
        return `${L(op - 0x47)} = ${S(sp - 2)};`;
      case 0x4b: case 0x4c: case 0x4d: case 0x4e:
        return `${L(op - 0x4b)} = ${S(sp - 1)};`;
      case 0x4f: case 0x51: case 0x55: case 0x56:
        return `${at} { const i = ${S(sp - 2)}; const arr = R.checkIndex(${S(sp - 3)}, i); arr.data[i] = ${S(sp - 1)}; }`;
      case 0x54:
        return `${at} { const v = ${S(sp - 1)}; const i = ${S(sp - 2)}; const arr = R.checkIndex(${S(sp - 3)}, i); arr.data[i] = arr.cls.name === '[Z' ? v & 1 : v; }`;
      case 0x50: case 0x52:
        return `${at} { const i = ${S(sp - 3)}; const arr = R.checkIndex(${S(sp - 4)}, i); arr.data[i] = ${S(sp - 2)}; }`;
      case 0x53:
        return (
          `${at} { const v = ${S(sp - 1)}; const i = ${S(sp - 2)}; const arr = R.checkIndex(${S(sp - 3)}, i); ` +
          `if (v !== null && !v.cls.isSubclassOf(arr.cls.componentType)) throw new R.PendingThrow('java/lang/ArrayStoreException', R.externalName(v.cls.name)); arr.data[i] = v; }`
        );
      case 0x57: case 0x58:
        return '';
      case 0x59:
        return `${S(sp)} = ${S(sp - 1)};`;
      case 0x5a:
        return `{ const v1 = ${S(sp - 1)}; ${S(sp - 1)} = ${S(sp - 2)}; ${S(sp - 2)} = v1; ${S(sp)} = v1; }`;
      case 0x5b:
        return `{ const v1 = ${S(sp - 1)}; ${S(sp - 1)} = ${S(sp - 2)}; ${S(sp - 2)} = ${S(sp - 3)}; ${S(sp - 3)} = v1; ${S(sp)} = v1; }`;
      case 0x5c:
        return `${S(sp)} = ${S(sp - 2)}; ${S(sp + 1)} = ${S(sp - 1)};`;
      case 0x5d:
        return `{ const v1 = ${S(sp - 1)}, v2 = ${S(sp - 2)}, v3 = ${S(sp - 3)}; ${S(sp - 3)} = v2; ${S(sp - 2)} = v1; ${S(sp - 1)} = v3; ${S(sp)} = v2; ${S(sp + 1)} = v1; }`;
      case 0x5e:
        return `{ const v1 = ${S(sp - 1)}, v2 = ${S(sp - 2)}, v3 = ${S(sp - 3)}, v4 = ${S(sp - 4)}; ${S(sp - 4)} = v2; ${S(sp - 3)} = v1; ${S(sp - 2)} = v4; ${S(sp - 1)} = v3; ${S(sp)} = v2; ${S(sp + 1)} = v1; }`;
      case 0x5f:
        return `{ const v1 = ${S(sp - 1)}; ${S(sp - 1)} = ${S(sp - 2)}; ${S(sp - 2)} = v1; }`;
      // int and float: the two operands are at sp-2 and sp-1; long and double: at sp-4 and sp-2
      case 0x60: return `${S(sp - 2)} = (${S(sp - 2)} + ${S(sp - 1)}) | 0;`;
      case 0x61: return `${S(sp - 4)} = BigInt.asIntN(64, ${S(sp - 4)} + ${S(sp - 2)});`;
      case 0x62: return `${S(sp - 2)} = Math.fround(${S(sp - 2)} + ${S(sp - 1)});`;
      case 0x63: return `${S(sp - 4)} = ${S(sp - 4)} + ${S(sp - 2)};`;
      case 0x64: return `${S(sp - 2)} = (${S(sp - 2)} - ${S(sp - 1)}) | 0;`;
      case 0x65: return `${S(sp - 4)} = BigInt.asIntN(64, ${S(sp - 4)} - ${S(sp - 2)});`;
      case 0x66: return `${S(sp - 2)} = Math.fround(${S(sp - 2)} - ${S(sp - 1)});`;
      case 0x67: return `${S(sp - 4)} = ${S(sp - 4)} - ${S(sp - 2)};`;
      case 0x68: return `${S(sp - 2)} = Math.imul(${S(sp - 2)}, ${S(sp - 1)});`;
      case 0x69: return `${S(sp - 4)} = BigInt.asIntN(64, ${S(sp - 4)} * ${S(sp - 2)});`;
      case 0x6a: return `${S(sp - 2)} = Math.fround(${S(sp - 2)} * ${S(sp - 1)});`;
      case 0x6b: return `${S(sp - 4)} = ${S(sp - 4)} * ${S(sp - 2)};`;
      case 0x6c:
        return `${at} { const b = ${S(sp - 1)}; if (b === 0) throw new R.PendingThrow('java/lang/ArithmeticException', '/ by zero'); ${S(sp - 2)} = (${S(sp - 2)} / b) | 0; }`;
      case 0x6d:
        return `${at} { const b = ${S(sp - 2)}; if (b === 0n) throw new R.PendingThrow('java/lang/ArithmeticException', '/ by zero'); ${S(sp - 4)} = BigInt.asIntN(64, ${S(sp - 4)} / b); }`;
      case 0x6e: return `${S(sp - 2)} = Math.fround(${S(sp - 2)} / ${S(sp - 1)});`;
      case 0x6f: return `${S(sp - 4)} = ${S(sp - 4)} / ${S(sp - 2)};`;
      case 0x70:
        return `${at} { const b = ${S(sp - 1)}; if (b === 0) throw new R.PendingThrow('java/lang/ArithmeticException', '/ by zero'); ${S(sp - 2)} = (${S(sp - 2)} % b) | 0; }`;
      case 0x71:
        return `${at} { const b = ${S(sp - 2)}; if (b === 0n) throw new R.PendingThrow('java/lang/ArithmeticException', '/ by zero'); ${S(sp - 4)} = ${S(sp - 4)} % b; }`;
      case 0x72: return `${S(sp - 2)} = Math.fround(${S(sp - 2)} % ${S(sp - 1)});`;
      case 0x73: return `${S(sp - 4)} = ${S(sp - 4)} % ${S(sp - 2)};`;
      case 0x74: return `${S(sp - 1)} = -${S(sp - 1)} | 0;`;
      case 0x75: return `${S(sp - 2)} = BigInt.asIntN(64, -${S(sp - 2)});`;
      case 0x76: return `${S(sp - 1)} = -${S(sp - 1)};`;
      case 0x77: return `${S(sp - 2)} = -${S(sp - 2)};`;
      case 0x78: return `${S(sp - 2)} = ${S(sp - 2)} << ${S(sp - 1)};`;
      case 0x79: return `${S(sp - 3)} = BigInt.asIntN(64, ${S(sp - 3)} << BigInt(${S(sp - 1)} & 63));`;
      case 0x7a: return `${S(sp - 2)} = ${S(sp - 2)} >> ${S(sp - 1)};`;
      case 0x7b: return `${S(sp - 3)} = ${S(sp - 3)} >> BigInt(${S(sp - 1)} & 63);`;
      case 0x7c: return `${S(sp - 2)} = (${S(sp - 2)} >>> ${S(sp - 1)}) | 0;`;
      case 0x7d: return `${S(sp - 3)} = BigInt.asIntN(64, BigInt.asUintN(64, ${S(sp - 3)}) >> BigInt(${S(sp - 1)} & 63));`;
      case 0x7e: return `${S(sp - 2)} = ${S(sp - 2)} & ${S(sp - 1)};`;
      case 0x7f: return `${S(sp - 4)} = ${S(sp - 4)} & ${S(sp - 2)};`;
      case 0x80: return `${S(sp - 2)} = ${S(sp - 2)} | ${S(sp - 1)};`;
      case 0x81: return `${S(sp - 4)} = ${S(sp - 4)} | ${S(sp - 2)};`;
      case 0x82: return `${S(sp - 2)} = ${S(sp - 2)} ^ ${S(sp - 1)};`;
      case 0x83: return `${S(sp - 4)} = ${S(sp - 4)} ^ ${S(sp - 2)};`;
      case 0x84: {
        const n = code[pc + 1]!;
        return `${L(n)} = (${L(n)} + ${(code[pc + 2]! << 24) >> 24}) | 0;`;
      }
      case 0x85: return `${S(sp - 1)} = BigInt(${S(sp - 1)});`;
      case 0x86: return `${S(sp - 1)} = Math.fround(${S(sp - 1)});`;
      case 0x87: return '';
      case 0x88: return `${S(sp - 2)} = Number(BigInt.asIntN(32, ${S(sp - 2)}));`;
      case 0x89: return `${S(sp - 2)} = R.longToFloat(${S(sp - 2)});`;
      case 0x8a: return `${S(sp - 2)} = Number(${S(sp - 2)});`;
      case 0x8b: return `${S(sp - 1)} = R.toInt(${S(sp - 1)});`;
      case 0x8c: return `${S(sp - 1)} = R.toLong(${S(sp - 1)});`;
      case 0x8d: return '';
      case 0x8e: return `${S(sp - 2)} = R.toInt(${S(sp - 2)});`;
      case 0x8f: return `${S(sp - 2)} = R.toLong(${S(sp - 2)});`;
      case 0x90: return `${S(sp - 2)} = Math.fround(${S(sp - 2)});`;
      case 0x91: return `${S(sp - 1)} = (${S(sp - 1)} << 24) >> 24;`;
      case 0x92: return `${S(sp - 1)} = ${S(sp - 1)} & 0xffff;`;
      case 0x93: return `${S(sp - 1)} = (${S(sp - 1)} << 16) >> 16;`;
      case 0x94: return `{ const a = ${S(sp - 4)}, b = ${S(sp - 2)}; ${S(sp - 4)} = a > b ? 1 : a < b ? -1 : 0; }`;
      case 0x95: case 0x96: return `${S(sp - 2)} = R.fcmp(${S(sp - 2)}, ${S(sp - 1)}, ${op === 0x95 ? -1 : 1});`;
      case 0x97: case 0x98: return `${S(sp - 4)} = R.fcmp(${S(sp - 4)}, ${S(sp - 2)}, ${op === 0x97 ? -1 : 1});`;
      case 0x99: case 0x9a: case 0x9b: case 0x9c: case 0x9d: case 0x9e: {
        const cmp = ['===', '!==', '<', '>=', '>', '<='][op - 0x99]!;
        return `if (${S(sp - 1)} ${cmp} 0) ${branch(pc + s16(code, pc + 1))}`;
      }
      case 0x9f: case 0xa0: case 0xa1: case 0xa2: case 0xa3: case 0xa4: {
        const cmp = ['===', '!==', '<', '>=', '>', '<='][op - 0x9f]!;
        return `if (${S(sp - 2)} ${cmp} ${S(sp - 1)}) ${branch(pc + s16(code, pc + 1))}`;
      }
      case 0xa5: case 0xa6:
        return `if (${S(sp - 2)} ${op === 0xa5 ? '===' : '!=='} ${S(sp - 1)}) ${branch(pc + s16(code, pc + 1))}`;
      case 0xa7:
        return branch(pc + s16(code, pc + 1));
      case 0xc8:
        return branch(pc + s32(code, pc + 1));
      case 0xc6: case 0xc7:
        return `if (${S(sp - 1)} ${op === 0xc6 ? '===' : '!=='} null) ${branch(pc + s16(code, pc + 1))}`;
      case 0xaa: {
        const p = (pc + 4) & ~3;
        const low = s32(code, p + 4);
        const high = s32(code, p + 8);
        const cases: string[] = [];
        for (let i = low; i <= high; i++) cases.push(`case ${i}: pc = ${pc + s32(code, p + 12 + (i - low) * 4)}; continue;`);
        return `switch (${S(sp - 1)}) { ${cases.join(' ')} default: pc = ${pc + s32(code, p)}; continue; }`;
      }
      case 0xab: {
        const p = (pc + 4) & ~3;
        const n = s32(code, p + 4);
        const cases: string[] = [];
        for (let i = 0; i < n; i++) cases.push(`case ${s32(code, p + 8 + i * 8)}: pc = ${pc + s32(code, p + 12 + i * 8)}; continue;`);
        return `switch (${S(sp - 1)}) { ${cases.join(' ')} default: pc = ${pc + s32(code, p)}; continue; }`;
      }
      case 0xac: case 0xae: case 0xb0:
        return `${at} R.ret(jvm, t, f, ${S(sp - 1)}, false); ${exitOuter(rem)}`;
      case 0xad: case 0xaf:
        return `${at} R.ret(jvm, t, f, ${S(sp - 2)}, true); ${exitOuter(rem)}`;
      case 0xb1:
        return `${at} R.ret(jvm, t, f, undefined, false); ${exitOuter(rem)}`;
      case 0xb2: case 0xb3: {
        const fld = resolved(idx) as JField | undefined;
        const put = op === 0xb3;
        const w = slotsOf(refDesc(cls, idx));
        const access = put ? `fld.cls.staticValues[fld.slot] = ${S(sp - w)};` : `${S(sp)} = fld.cls.staticValues[fld.slot];`;
        if (fld && fld.isStatic && fld.cls.state === 'initialized') {
          return put ? `${k(fld.cls)}.staticValues[${fld.slot}] = ${S(sp - w)};` : `${S(sp)} = ${k(fld.cls)}.staticValues[${fld.slot}];`;
        }
        return (
          `f.pc = ${pc}; ${at} { const fld = R.resolveField(jvm, cls, ${idx}); ` +
          `if (!fld.isStatic) throw new R.PendingThrow('java/lang/IncompatibleClassChangeError', 'Expected static field ' + R.externalName(fld.cls.name) + '.' + fld.name); ` +
          `if (fld.cls.state !== 'initialized') { f.sp = ${sp}; if (!R.ensureInit(jvm, t, f, fld.cls)) { ${exitOuter(rem)} } } ${access} }`
        );
      }
      case 0xb4: case 0xb5: {
        const fld = resolved(idx) as JField | undefined;
        const put = op === 0xb5;
        const w = slotsOf(refDesc(cls, idx));
        const obj = put ? S(sp - w - 1) : S(sp - 1);
        if (fld && !fld.isStatic) {
          return put
            ? `${at} { const o = ${obj}; if (o === null) ${NPE} o.fields[${fld.slot}] = ${S(sp - w)}; }`
            : `${at} { const o = ${obj}; if (o === null) ${NPE} ${S(sp - 1)} = o.fields[${fld.slot}]; }`;
        }
        return (
          `f.pc = ${pc}; ${at} { const fld = R.resolveField(jvm, cls, ${idx}); ` +
          `if (fld.isStatic) throw new R.PendingThrow('java/lang/IncompatibleClassChangeError', 'Expected non-static field ' + R.externalName(fld.cls.name) + '.' + fld.name); ` +
          `const o = ${obj}; if (o === null) ${NPE} ${put ? `o.fields[fld.slot] = ${S(sp - w)};` : `${S(sp - 1)} = o.fields[fld.slot];`} }`
        );
      }
      case 0xb6: {
        const m0 = resolved(idx) as JMethod | undefined;
        const next = pc + 3;
        const mm = m0 ? k(m0) : `R.resolveMethod(jvm, cls, ${idx})`;
        let select: string;
        if (m0 && !m0.cls.isInterface) {
          select = m0.vtableIndex >= 0 ? `const target = recv.cls.vtable[${m0.vtableIndex}];` : `const target = m;`;
        } else {
          select = `let target = m; if (m.cls.isInterface) target = R.selectMethod(recv.cls, m) ?? m; else if (m.vtableIndex >= 0) target = recv.cls.vtable[m.vtableIndex];`;
        }
        return (
          `f.pc = ${pc}; ${at} { const m = ${mm}; const recv = stack[${sp} - m.argSlots]; if (recv === null) ${NPE} ${select} ` +
          `if (target.access & 0x0400) throw new R.PendingThrow('java/lang/AbstractMethodError', R.externalName(recv.cls.name) + '.' + m.name + m.desc); ` +
          `f.sp = ${sp}; R.call(jvm, t, f, target, ${next}); } ${exitOuter(rem)}`
        );
      }
      case 0xb7: {
        const m0 = resolved(idx) as JMethod | undefined;
        const next = pc + 3;
        if (m0) {
          // what the interpreter selects at every execution, chosen once: it depends only on resolved classes and methods
          let target = m0;
          if (
            m0.name !== '<init>' &&
            (m0.access & 0x0002) === 0 &&
            !m0.cls.isInterface &&
            m0.cls !== cls &&
            (cls.access & 0x0020) !== 0 &&
            cls.isSubclassOf(m0.cls)
          ) {
            target = cls.superClass!.findMethod(m0.name, m0.desc) ?? m0;
          }
          return `f.pc = ${pc}; ${at} if (stack[${sp - m0.argSlots}] === null) ${NPE} f.sp = ${sp}; R.call(jvm, t, f, ${k(target)}, ${next}); ${exitOuter(rem)}`;
        }
        return (
          `f.pc = ${pc}; ${at} { let m = R.resolveMethod(jvm, cls, ${idx}); if (stack[${sp} - m.argSlots] === null) ${NPE} ` +
          `if (m.name !== '<init>' && (m.access & 0x0002) === 0 && !m.cls.isInterface && m.cls !== cls && (cls.access & 0x0020) !== 0 && cls.isSubclassOf(m.cls)) m = cls.superClass.findMethod(m.name, m.desc) ?? m; ` +
          `f.sp = ${sp}; R.call(jvm, t, f, m, ${next}); } ${exitOuter(rem)}`
        );
      }
      case 0xb8: {
        const m0 = resolved(idx) as JMethod | undefined;
        const next = pc + 3;
        const mm = m0 ? k(m0) : `R.resolveMethod(jvm, cls, ${idx})`;
        const init = m0 && m0.isStatic && m0.cls.state === 'initialized' ? '' : `if (m.cls.state !== 'initialized' && !R.ensureInit(jvm, t, f, m.cls)) { ${exitOuter(rem)} } `;
        return (
          `f.pc = ${pc}; ${at} { const m = ${mm}; ` +
          `if (!m.isStatic) throw new R.PendingThrow('java/lang/IncompatibleClassChangeError', 'Expected static method ' + R.externalName(m.cls.name) + '.' + m.name + m.desc); ` +
          `f.sp = ${sp}; ${init}R.call(jvm, t, f, m, ${next}); } ${exitOuter(rem)}`
        );
      }
      case 0xb9: {
        const m0 = resolved(idx) as JMethod | undefined;
        const next = pc + 5;
        const mm = m0 ? k(m0) : `R.resolveMethod(jvm, cls, ${idx})`;
        return (
          `f.pc = ${pc}; ${at} { const m = ${mm}; const recv = stack[${sp} - m.argSlots]; if (recv === null) ${NPE} ` +
          `if (!recv.cls.isSubclassOf(m.cls)) throw new R.PendingThrow('java/lang/IncompatibleClassChangeError', 'Class ' + R.externalName(recv.cls.name) + ' does not implement the requested interface ' + R.externalName(m.cls.name)); ` +
          `const target = R.selectMethod(recv.cls, m); ` +
          `if (!target || target.isAbstract) throw new R.PendingThrow('java/lang/AbstractMethodError', R.externalName(recv.cls.name) + '.' + m.name + m.desc); ` +
          `f.sp = ${sp}; R.call(jvm, t, f, target, ${next}); } ${exitOuter(rem)}`
        );
      }
      case 0xba:
        return (
          `f.pc = ${pc}; ${at} { const site = f.method.callSites?.get(${pc}); ` +
          `if (!site) throw new R.LoadPending(R.linkCallSite(jvm, t, f.method, ${pc}, ${idx})); ` +
          `f.sp = ${sp}; R.call(jvm, t, f, site, ${pc + 5}); } ${exitOuter(rem)}`
        );
      case 0xbb: {
        const c = resolved(idx) as JClass | undefined;
        if (c && !c.isInterface && !(c.access & 0x0400) && c.state === 'initialized') return `${S(sp)} = jvm.heap.newObject(${k(c)});`;
        return (
          `f.pc = ${pc}; ${at} { const c = R.resolveClass(jvm, cls, ${idx}); ` +
          `if (c.isInterface || c.access & 0x0400) throw new R.PendingThrow('java/lang/InstantiationError', R.externalName(c.name)); ` +
          `if (c.state !== 'initialized') { f.sp = ${sp}; if (!R.ensureInit(jvm, t, f, c)) { ${exitOuter(rem)} } } ${S(sp)} = jvm.heap.newObject(c); }`
        );
      }
      case 0xbc: {
        const type = ['', '', '', '', 'Z', 'C', 'F', 'D', 'B', 'S', 'I', 'J'][code[pc + 1]!];
        if (!type) throw new Refused('opcode');
        return (
          `${at} { const n = ${S(sp - 1)}; if (n < 0) throw new R.PendingThrow('java/lang/NegativeArraySizeException'); ` +
          `const loader = jvm.loader; ${S(sp - 1)} = jvm.heap.newArray(loader.arrayOf(loader.primitive('${type}')), n); }`
        );
      }
      case 0xbd: {
        const c = resolved(idx) as JClass | undefined;
        return (
          `${c ? '' : `f.pc = ${pc}; `}${at} { const c = ${c ? k(c) : `R.resolveClass(jvm, cls, ${idx})`}; const n = ${S(sp - 1)}; ` +
          `if (n < 0) throw new R.PendingThrow('java/lang/NegativeArraySizeException'); ${S(sp - 1)} = jvm.heap.newArray(jvm.loader.arrayOf(c), n); }`
        );
      }
      case 0xbe:
        return `${at} { const arr = ${S(sp - 1)}; if (arr === null) ${NPE} ${S(sp - 1)} = arr.data.length; }`;
      case 0xbf:
        return `f.pc = ${pc}; ${at} { const e = ${S(sp - 1)}; if (e === null) ${NPE} R.throwInto(jvm, t, e); } ${exitOuter(rem)}`;
      case 0xc0: {
        const c = resolved(idx) as JClass | undefined;
        return (
          `${c ? '' : `f.pc = ${pc}; `}${at} { const o = ${S(sp - 1)}; if (o !== null) { const c = ${c ? k(c) : `R.resolveClass(jvm, cls, ${idx})`}; ` +
          `if (!o.cls.isSubclassOf(c)) throw new R.PendingThrow('java/lang/ClassCastException', R.externalName(o.cls.name) + ' cannot be cast to ' + R.externalName(c.name)); } }`
        );
      }
      case 0xc1: {
        const c = resolved(idx) as JClass | undefined;
        return `${c ? '' : `f.pc = ${pc}; `}${at} { const o = ${S(sp - 1)}; ${S(sp - 1)} = o !== null && o.cls.isSubclassOf(${c ? k(c) : `R.resolveClass(jvm, cls, ${idx})`}) ? 1 : 0; }`;
      }
      case 0xc2:
        return `f.pc = ${pc}; ${at} { const o = ${S(sp - 1)}; if (o === null) ${NPE} if (!jvm.threads.monitorEnter(t, o)) { f.sp = ${sp}; ${exitOuter(rem)} } }`;
      case 0xc3:
        return (
          `f.pc = ${pc}; ${at} { const o = ${S(sp - 1)}; if (o === null) ${NPE} jvm.threads.monitorExit(t, o); ` +
          `if (jvm.threads.preempted) { f.pc = ${pc + 1}; f.sp = ${sp - 1}; R.exit = 2; return budget${rem ? ` + ${rem}` : ''}; } }`
        );
      case 0xc4: {
        const w = code[pc + 1]!;
        const n = u16(code, pc + 2);
        switch (w) {
          case 0x15: case 0x16: case 0x17: case 0x18: case 0x19:
            return `${S(sp)} = ${L(n)};`;
          case 0x36: case 0x38: case 0x3a:
            return `${L(n)} = ${S(sp - 1)};`;
          case 0x37: case 0x39:
            return `${L(n)} = ${S(sp - 2)};`;
          case 0x84:
            return `${L(n)} = (${L(n)} + ${s16(code, pc + 4)}) | 0;`;
        }
        throw new Refused('opcode');
      }
      case 0xc5: {
        const dims = code[pc + 3]!;
        const base = sp - dims;
        return (
          `f.pc = ${pc}; ${at} { const c = R.resolveClass(jvm, cls, ${idx}); const counts = stack.slice(${base}, ${sp}); ` +
          `if (counts.some((n) => n < 0)) throw new R.PendingThrow('java/lang/NegativeArraySizeException'); ${S(base)} = R.multiArray(jvm, c, counts, 0); }`
        );
      }
      case 0xcb: {
        const target = pc + s16(code, pc + 1);
        return `f.pc = ${pc}; f.sp = ${sp}; ${at} { const next = f.method.loopHooks.get(${pc})(jvm, t, f.method, locals); pc = next === R.DECLINE ? ${target} : next; continue; }`;
      }
    }
    throw new Refused(op === 0xa8 || op === 0xa9 || op === 0xc9 ? 'jsr' : 'opcode');
  }

  const hoisted = consts.map((_, i) => `const k${i} = K[${i}];`).join('\n');
  const body = `${hoisted}
return function compiled(jvm, t, f, budget) {
const stack = f.stack, locals = f.locals;
let pc = f.pc;
try {
for (;;) {
switch (pc) {
${out.join('\n')}
default: {
f.pc = pc; const d = SP[pc]; if (d !== undefined && d >= 0) f.sp = d; R.exit = 1; return budget;
}
}
}
} catch (e) {
budget += REF[pc]; f.pc = pc; R.caught(jvm, t, f, e, SP[pc]); R.exit = 0; return budget;
}
};`;
  return { body, consts, sp: spAt, refund };
}
