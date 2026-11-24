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
export interface JitBase {
  /** How the last compiled method left (JIT_EXIT_*; -1 from `after`: go on in this frame). */
  exit: number;
  /** Compiled methods running nested in one another (`after`), reset when a slice starts. */
  depth: number;
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

/**
 * JitBase with the steps compiled code shares rather than repeats at every site (made by jitRuntime): the invokes, as
 * the interpreter carries them out, and what follows anything that may have left the frame.
 * @internal
 */
export interface JitRuntime extends JitBase {
  /**
   * After a call, throw, class initialisation or blocked monitor: when the frame is still on top and the thread may go
   * on, `exit` is -1 and the compiled method goes on at the frame's pc; when the call pushed a frame of a compiled
   * method right above it, that method runs here first, nested, as the outer loop would have run it next (no further
   * than JIT_MAX_NESTING deep); otherwise `exit` says how to leave. Returns the budget left.
   */
  readonly after: (jvm: Jvm, t: JThread, f: Frame, budget: number) => number;
  /** invokevirtual of `m` with the frame's operand stack `sp` deep (spilled to the frame), returning to `next`. */
  readonly invokeVirtual: (jvm: Jvm, t: JThread, f: Frame, m: JMethod, sp: number, next: number) => void;
  readonly invokeInterface: (jvm: Jvm, t: JThread, f: Frame, m: JMethod, sp: number, next: number) => void;
  readonly invokeStatic: (jvm: Jvm, t: JThread, f: Frame, m: JMethod, sp: number, next: number) => void;
  /** invokespecial of an unresolved method (a resolved one's target is chosen when compiling). */
  readonly invokeSpecial: (jvm: Jvm, t: JThread, f: Frame, m: JMethod, sp: number, next: number) => void;
}

/** Adds the shared steps (JitRuntime) to the interpreter's functions. */
export function jitRuntime(base: JitBase): JitRuntime {
  const rt = base as JitBase & { -readonly [K in keyof JitRuntime]: JitRuntime[K] };
  const NPE = 'java/lang/NullPointerException';
  rt.after = (jvm, t, f, budget) => {
    for (;;) {
      if (t.state !== 'runnable' || jvm.threads.preempted) {
        rt.exit = JIT_EXIT_CONTINUE;
        return budget;
      }
      const frames = t.frames;
      const top = frames[frames.length - 1]!;
      if (top === f) {
        rt.exit = -1;
        return budget;
      }
      const callee = top.method.jit;
      if (frames[frames.length - 2] !== f || typeof callee !== 'function' || rt.depth >= JIT_MAX_NESTING) {
        rt.exit = JIT_EXIT_CONTINUE;
        return budget;
      }
      rt.depth++;
      budget = callee(jvm, t, top, budget);
      rt.depth--;
      if (rt.exit !== JIT_EXIT_CONTINUE) {
        // a frame for the interpreter is found again by the outer loop, which hands it over the same way
        if (rt.exit === JIT_EXIT_INTERPRET) rt.exit = JIT_EXIT_CONTINUE;
        return budget;
      }
    }
  };
  rt.invokeVirtual = (jvm, t, f, m, sp, next) => {
    const recv = f.stack[sp - m.argSlots] as JObject | null;
    if (recv === null) throw new rt.PendingThrow(NPE);
    let target = m;
    if (m.cls.isInterface) target = rt.selectMethod(recv.cls, m) ?? m;
    else if (m.vtableIndex >= 0) target = recv.cls.vtable[m.vtableIndex]!;
    if (target.access & 0x0400) throw new rt.PendingThrow('java/lang/AbstractMethodError', `${rt.externalName(recv.cls.name)}.${m.name}${m.desc}`);
    f.sp = sp;
    rt.call(jvm, t, f, target, next);
  };
  rt.invokeInterface = (jvm, t, f, m, sp, next) => {
    const recv = f.stack[sp - m.argSlots] as JObject | null;
    if (recv === null) throw new rt.PendingThrow(NPE);
    if (!recv.cls.isSubclassOf(m.cls)) {
      throw new rt.PendingThrow(
        'java/lang/IncompatibleClassChangeError',
        `Class ${rt.externalName(recv.cls.name)} does not implement the requested interface ${rt.externalName(m.cls.name)}`,
      );
    }
    const target = rt.selectMethod(recv.cls, m);
    if (!target || target.isAbstract) throw new rt.PendingThrow('java/lang/AbstractMethodError', `${rt.externalName(recv.cls.name)}.${m.name}${m.desc}`);
    f.sp = sp;
    rt.call(jvm, t, f, target, next);
  };
  rt.invokeStatic = (jvm, t, f, m, sp, next) => {
    if (!m.isStatic) throw new rt.PendingThrow('java/lang/IncompatibleClassChangeError', `Expected static method ${rt.externalName(m.cls.name)}.${m.name}${m.desc}`);
    f.sp = sp;
    if (m.cls.state !== 'initialized' && !rt.ensureInit(jvm, t, f, m.cls)) return;
    rt.call(jvm, t, f, m, next);
  };
  rt.invokeSpecial = (jvm, t, f, m, sp, next) => {
    if (f.stack[sp - m.argSlots] === null) throw new rt.PendingThrow(NPE);
    const cls = f.method.cls;
    if (m.name !== '<init>' && (m.access & 0x0002) === 0 && !m.cls.isInterface && m.cls !== cls && (cls.access & 0x0020) !== 0 && cls.isSubclassOf(m.cls)) {
      m = cls.superClass!.findMethod(m.name, m.desc) ?? m;
    }
    f.sp = sp;
    rt.call(jvm, t, f, m, next);
  };
  return rt as JitRuntime;
}

/** Bytecode longer than this stays interpreted (such methods run once, as class initialisers, and parse slowly). */
export const JIT_MAX_CODE_BYTES = 16 * 1024;

/** Why a method is not compiled. */
export type JitRefusal = 'native' | 'too-long' | 'frame' | 'jsr' | 'opcode' | 'stack' | 'constant';

/** How deep compiled methods call each other on the JS stack before the outer loop takes over. */
export const JIT_MAX_NESTING = 48;

/** A frame of more locals and stack slots than this stays interpreted (each becomes a JS variable). */
export const JIT_MAX_FRAME_SLOTS = 400;

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
function successors(code: Uint8Array, pc: number): { targets: number[]; falls: boolean } {
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
    const { targets, falls } = successors(code, pc);
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
  const sym: (string | undefined)[] = [];
  const refund = new Int32Array(code.length + 1);
  const out: string[] = [];
  // The operand stack's slots and the locals live in JS variables (s<i>, l<n>) while the compiled code runs, and go back
  // to the frame (spill) before anything else can see the frame: a call, a throw, an exit; after a call the frame's
  // stack is read back (it holds the result).
  const maxStack = m.code!.maxStack;
  const maxLocals = Math.max(m.code!.maxLocals, m.argSlots);
  if (maxStack + maxLocals > JIT_MAX_FRAME_SLOTS) throw new Refused('frame');
  const S = (i: number): string => `s${i}`;
  const L = (n: number): string => `l${n}`;
  // a local is written through to the frame as it is stored, so only the operand stack is spilled
  const store = (n: number, value: string): string => `l${n} = ${value}; locals[${n}] = l${n};`;
  const spill = (d: number): string => {
    let out = '';
    for (let i = 0; i < d; i++) out += `stack[${i}] = s${i}; `;
    return out;
  };
  const spillAll = spill(maxStack);
  // after leaving the frame and coming back, the slots below `d` (at least the handler's one) are read back
  const reload = (d: number): string => {
    let out = '';
    for (let i = 0; i < Math.max(d, 1); i++) out += `s${i} = stack[${i}]; `;
    return out;
  };
  let reloadLocals = '';
  for (let n = 0; n < maxLocals; n++) reloadLocals += `l${n} = locals[${n}]; `;
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
    out.push(`if (budget < ${n}) { ${spill(d0)} f.pc = ${leader}; f.sp = ${d0}; R.exit = 1; return budget; } budget -= ${n};`);
    sym.length = 0;
    for (let ii = bi; ii < bj; ii++) {
      const pc = a.starts[ii]!;
      const sp = a.depth[ii];
      if (sp === undefined) break;
      const rem = bj - ii - 1;
      spAt[pc] = sp;
      refund[pc] = rem;
      const folded = pure(pc, sp);
      const js = folded ?? flush(sp) + instruction(pc, sp, rem);
      if (js !== '') out.push(js);
    }
    // the next block reads the operand stack from its variables
    const last = a.starts[bj - 1]!;
    const lastDepth = a.depth[bj - 1];
    const tail = lastDepth === undefined ? '' : flush(lastDepth + depthChange(last));
    if (tail !== '') out.push(tail);
  }

  /**
   * The operand stack's slots, within a block, as expressions not yet stored in their variables: a slot is held as a
   * pure expression (locals, constants, arithmetic that cannot throw) until something needs it in its variable, so a
   * run of loads and arithmetic becomes one JS expression. Undefined: the value is in the slot's variable.
   */
  function flush(depth: number): string {
    let out = '';
    for (let i = 0; i < Math.min(depth, sym.length); i++) {
      const e = sym[i];
      if (e !== undefined) {
        sym[i] = undefined;
        out += assign(i, e);
      }
    }
    sym.length = 0;
    return out;
  }

  /** A slot's value: its pending expression, or its variable. */
  function val(i: number): string {
    return sym[i] ?? S(i);
  }

  /**
   * Stores `e` in slot `i`'s variable. A pending expression reads only the variables of its own slot and the slots
   * above it (its operands), so before `s<i>` changes, the pending expressions below `i` that read it take their value
   * first (lowest first, each in turn guarding its own variable).
   */
  function assign(i: number, e: string): string {
    const ref = new RegExp(`\\bs${i}\\b`);
    let out = '';
    for (let k = 0; k < i; k++) {
      const p = sym[k];
      if (p !== undefined && ref.test(p)) {
        sym[k] = undefined;
        out += assign(k, p);
      }
    }
    return `${out}${S(i)} = ${e}; `;
  }

  /** Puts `e` in slot `i`, or stores it there when it has grown long. */
  function put(i: number, e: string): string {
    if (e.length > 160) {
      sym[i] = undefined;
      return assign(i, e);
    }
    sym[i] = /^[\w.]+$/.test(e) ? e : `(${e})`;
    return '';
  }

  /** Before local `n` changes: pending expressions that read it take their value now. */
  function settle(n: number): string {
    const ref = new RegExp(`\\bl${n}\\b`);
    let out = '';
    for (let i = 0; i < sym.length; i++) {
      const e = sym[i];
      if (e !== undefined && ref.test(e)) {
        sym[i] = undefined;
        out += assign(i, e);
      }
    }
    return out;
  }

  /** The instruction's effect on the stack depth, for one that falls through. */
  function depthChange(pc: number): number {
    const [pop, push] = stackEffect(m, code, pc);
    return push - pop;
  }

  /**
   * An instruction carried out on the pending expressions (loads, stores, constants, arithmetic that cannot throw,
   * conversions, comparisons and conditional branches); null for the others, which take their operands from the
   * variables.
   */
  function pure(pc: number, sp: number): string | null {
    const op = code[pc]!;
    const bin = (fmt: (x: string, y: string) => string, width: number): string => {
      // operands at sp-2*width and sp-width, the result where the first was
      const x = val(sp - 2 * width);
      const y = val(sp - width);
      sym[sp - width] = undefined;
      return put(sp - 2 * width, fmt(x, y));
    };
    const un = (fmt: (x: string) => string, at: number, to = at): string => {
      const x = val(at);
      if (to !== at) sym[at] = undefined;
      return put(to, fmt(x));
    };
    if (op >= 0x01 && op <= 0x11) {
      const v = op === 0x01 ? 'null' : op <= 0x08 ? String(op - 0x03) : op <= 0x0a ? `${op - 0x09}n` : op <= 0x0d ? String(op - 0x0b) : op <= 0x0f ? String(op - 0x0e) : op === 0x10 ? String((code[pc + 1]! << 24) >> 24) : String(s16(code, pc + 1));
      return put(sp, v.startsWith('-') ? `(${v})` : v);
    }
    if (op === 0x12 || op === 0x13 || op === 0x14) {
      const e = cpEntry(cls, op === 0x12 ? code[pc + 1]! : u16(code, pc + 1));
      if (e?.tag === 'int' || e?.tag === 'float' || e?.tag === 'long' || e?.tag === 'double') return put(sp, k(e.value));
      return null;
    }
    if (op >= 0x15 && op <= 0x19) return put(sp, L(code[pc + 1]!));
    if (op >= 0x1a && op <= 0x2d) return put(sp, L((op - 0x1a) % 4));
    if (op >= 0x36 && op <= 0x3a) {
      const n = code[pc + 1]!;
      const v = val(sp - (op === 0x37 || op === 0x39 ? 2 : 1));
      sym[sp - (op === 0x37 || op === 0x39 ? 2 : 1)] = undefined;
      return settle(n) + store(n, v);
    }
    if (op >= 0x3b && op <= 0x4e) {
      const n = (op - 0x3b) % 4;
      const w = op >= 0x3f && op <= 0x42 ? 2 : op >= 0x47 && op <= 0x4a ? 2 : 1;
      const v = val(sp - w);
      sym[sp - w] = undefined;
      return settle(n) + store(n, v);
    }
    if (op === 0x84) {
      const n = code[pc + 1]!;
      return settle(n) + store(n, `(${L(n)} + ${(code[pc + 2]! << 24) >> 24}) | 0`);
    }
    switch (op) {
      case 0x60: return bin((x, y) => `(${x} + ${y}) | 0`, 1);
      case 0x61: return bin((x, y) => `BigInt.asIntN(64, ${x} + ${y})`, 2);
      case 0x62: return bin((x, y) => `Math.fround(${x} + ${y})`, 1);
      case 0x63: return bin((x, y) => `(${x} + ${y})`, 2);
      case 0x64: return bin((x, y) => `(${x} - ${y}) | 0`, 1);
      case 0x65: return bin((x, y) => `BigInt.asIntN(64, ${x} - ${y})`, 2);
      case 0x66: return bin((x, y) => `Math.fround(${x} - ${y})`, 1);
      case 0x67: return bin((x, y) => `(${x} - ${y})`, 2);
      case 0x68: return bin((x, y) => `Math.imul(${x}, ${y})`, 1);
      case 0x69: return bin((x, y) => `BigInt.asIntN(64, ${x} * ${y})`, 2);
      case 0x6a: return bin((x, y) => `Math.fround(${x} * ${y})`, 1);
      case 0x6b: return bin((x, y) => `(${x} * ${y})`, 2);
      case 0x6e: return bin((x, y) => `Math.fround(${x} / ${y})`, 1);
      case 0x6f: return bin((x, y) => `(${x} / ${y})`, 2);
      case 0x72: return bin((x, y) => `Math.fround(${x} % ${y})`, 1);
      case 0x73: return bin((x, y) => `(${x} % ${y})`, 2);
      case 0x74: return un((x) => `(-${x} | 0)`, sp - 1);
      case 0x75: return un((x) => `BigInt.asIntN(64, -${x})`, sp - 2);
      case 0x76: return un((x) => `(-${x})`, sp - 1);
      case 0x77: return un((x) => `(-${x})`, sp - 2);
      case 0x7e: return bin((x, y) => `(${x} & ${y})`, 1);
      case 0x7f: return bin((x, y) => `(${x} & ${y})`, 2);
      case 0x80: return bin((x, y) => `(${x} | ${y})`, 1);
      case 0x81: return bin((x, y) => `(${x} | ${y})`, 2);
      case 0x82: return bin((x, y) => `(${x} ^ ${y})`, 1);
      case 0x83: return bin((x, y) => `(${x} ^ ${y})`, 2);
      case 0x78: return bin((x, y) => `(${x} << ${y})`, 1);
      case 0x7a: return bin((x, y) => `(${x} >> ${y})`, 1);
      case 0x7c: return bin((x, y) => `((${x} >>> ${y}) | 0)`, 1);
      case 0x85: return un((x) => `BigInt(${x})`, sp - 1);
      case 0x86: return un((x) => `Math.fround(${x})`, sp - 1);
      case 0x87: case 0x8d: return '';
      case 0x88: return un((x) => `Number(BigInt.asIntN(32, ${x}))`, sp - 2);
      case 0x8a: return un((x) => `Number(${x})`, sp - 2);
      case 0x8b: return un((x) => `R.toInt(${x})`, sp - 1);
      case 0x8e: return un((x) => `R.toInt(${x})`, sp - 2);
      case 0x90: return un((x) => `Math.fround(${x})`, sp - 2);
      case 0x91: return un((x) => `((${x} << 24) >> 24)`, sp - 1);
      case 0x92: return un((x) => `(${x} & 0xffff)`, sp - 1);
      case 0x93: return un((x) => `((${x} << 16) >> 16)`, sp - 1);
      case 0x95: case 0x96: return bin((x, y) => `R.fcmp(${x}, ${y}, ${op === 0x95 ? -1 : 1})`, 1);
    }
    if (op >= 0x99 && op <= 0x9e) {
      const x = val(sp - 1);
      sym[sp - 1] = undefined;
      const cmp = ['===', '!==', '<', '>=', '>', '<='][op - 0x99]!;
      return `${flush(sp - 1)}if (${x} ${cmp} 0) ${branch(pc + s16(code, pc + 1))}`;
    }
    if (op >= 0x9f && op <= 0xa6) {
      const x = val(sp - 2);
      const y = val(sp - 1);
      sym[sp - 2] = undefined;
      sym[sp - 1] = undefined;
      const cmp = ['===', '!==', '<', '>=', '>', '<=', '===', '!=='][op - 0x9f]!;
      return `${flush(sp - 2)}if (${x} ${cmp} ${y}) ${branch(pc + s16(code, pc + 1))}`;
    }
    if (op === 0xc6 || op === 0xc7) {
      const x = val(sp - 1);
      sym[sp - 1] = undefined;
      return `${flush(sp - 1)}if (${x} ${op === 0xc6 ? '===' : '!=='} null) ${branch(pc + s16(code, pc + 1))}`;
    }
    return null;
  }

  /**
   * Where the interpreter goes back to its outer loop (after a call, a throw, a class initialisation or a blocked
   * monitor): R.after either runs what the outer loop would run next or says to go on here, at the frame's pc, with
   * the operand stack `d` deep (read back from the frame).
   */
  function leave(rem: number, d: number): string {
    return `${rem ? `budget += ${rem}; ` : ''}budget = R.after(jvm, t, f, budget); if (R.exit >= 0) return budget; ${reload(d)}pc = f.pc; continue dispatch;`;
  }

  /** The operand stack's depth at `next`, after a call (the invoke's own when its successor is unreachable). */
  function depthAt(next: number): number {
    const i = a.starts.indexOf(next);
    return (i >= 0 ? a.depth[i] : undefined) ?? maxStack;
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
        return store(code[pc + 1]!, S(sp - 1));
      case 0x37: case 0x39:
        return store(code[pc + 1]!, S(sp - 2));
      case 0x3b: case 0x3c: case 0x3d: case 0x3e:
        return store(op - 0x3b, S(sp - 1));
      case 0x3f: case 0x40: case 0x41: case 0x42:
        return store(op - 0x3f, S(sp - 2));
      case 0x43: case 0x44: case 0x45: case 0x46:
        return store(op - 0x43, S(sp - 1));
      case 0x47: case 0x48: case 0x49: case 0x4a:
        return store(op - 0x47, S(sp - 2));
      case 0x4b: case 0x4c: case 0x4d: case 0x4e:
        return store(op - 0x4b, S(sp - 1));
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
        return store(n, `(${L(n)} + ${(code[pc + 2]! << 24) >> 24}) | 0`);
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
        return `${at} R.ret(jvm, t, f, ${S(sp - 1)}, false); R.exit = 0; return budget${rem ? ` + ${rem}` : ''};`;
      case 0xad: case 0xaf:
        return `${at} R.ret(jvm, t, f, ${S(sp - 2)}, true); R.exit = 0; return budget${rem ? ` + ${rem}` : ''};`;
      case 0xb1:
        return `${at} R.ret(jvm, t, f, undefined, false); R.exit = 0; return budget${rem ? ` + ${rem}` : ''};`;
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
          `if (fld.cls.state !== 'initialized') { ${spill(sp)} f.sp = ${sp}; if (!R.ensureInit(jvm, t, f, fld.cls)) { ${leave(rem, sp)} } } ${access} }`
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
      case 0xb6: case 0xb8: case 0xb9: {
        const m0 = resolved(idx) as JMethod | undefined;
        const next = pc + (op === 0xb9 ? 5 : 3);
        const helper = op === 0xb6 ? 'invokeVirtual' : op === 0xb8 ? 'invokeStatic' : 'invokeInterface';
        const after = depthAt(pc + (op === 0xb9 ? 5 : 3));
        return `f.pc = ${pc}; ${at} ${spill(sp)}R.${helper}(jvm, t, f, ${m0 ? k(m0) : `R.resolveMethod(jvm, cls, ${idx})`}, ${sp}, ${next}); ${leave(rem, after)}`;
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
          return `f.pc = ${pc}; ${at} if (${S(sp - m0.argSlots)} === null) ${NPE} ${spill(sp)}f.sp = ${sp}; R.call(jvm, t, f, ${k(target)}, ${next}); ${leave(rem, depthAt(next))}`;
        }
        return `f.pc = ${pc}; ${at} ${spill(sp)}R.invokeSpecial(jvm, t, f, R.resolveMethod(jvm, cls, ${idx}), ${sp}, ${next}); ${leave(rem, depthAt(next))}`;
      }
      case 0xba:
        return (
          `f.pc = ${pc}; ${at} ${spill(sp)}{ const site = f.method.callSites?.get(${pc}); ` +
          `if (!site) throw new R.LoadPending(R.linkCallSite(jvm, t, f.method, ${pc}, ${idx})); ` +
          `f.sp = ${sp}; R.call(jvm, t, f, site, ${pc + 5}); } ${leave(rem, depthAt(pc + 5))}`
        );
      case 0xbb: {
        const c = resolved(idx) as JClass | undefined;
        if (c && !c.isInterface && !(c.access & 0x0400) && c.state === 'initialized') return `${at} ${S(sp)} = jvm.heap.newObject(${k(c)});`;
        return (
          `f.pc = ${pc}; ${at} { const c = R.resolveClass(jvm, cls, ${idx}); ` +
          `if (c.isInterface || c.access & 0x0400) throw new R.PendingThrow('java/lang/InstantiationError', R.externalName(c.name)); ` +
          `if (c.state !== 'initialized') { ${spill(sp)} f.sp = ${sp}; if (!R.ensureInit(jvm, t, f, c)) { ${leave(rem, sp)} } } ${S(sp)} = jvm.heap.newObject(c); }`
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
        return `f.pc = ${pc}; ${at} { const e = ${S(sp - 1)}; if (e === null) ${NPE} ${spill(sp)} f.sp = ${sp}; R.throwInto(jvm, t, e); } ${leave(rem, 1)}`;
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
        return `f.pc = ${pc}; ${at} { const o = ${S(sp - 1)}; if (o === null) ${NPE} if (!jvm.threads.monitorEnter(t, o)) { ${spill(sp)} f.sp = ${sp}; ${leave(rem, sp)} } }`;
      case 0xc3:
        return (
          `f.pc = ${pc}; ${at} { const o = ${S(sp - 1)}; if (o === null) ${NPE} jvm.threads.monitorExit(t, o); ` +
          `if (jvm.threads.preempted) { ${spill(sp - 1)} f.pc = ${pc + 1}; f.sp = ${sp - 1}; R.exit = 2; return budget${rem ? ` + ${rem}` : ''}; } }`
        );
      case 0xc4: {
        const w = code[pc + 1]!;
        const n = u16(code, pc + 2);
        switch (w) {
          case 0x15: case 0x16: case 0x17: case 0x18: case 0x19:
            return `${S(sp)} = ${L(n)};`;
          case 0x36: case 0x38: case 0x3a:
            return store(n, S(sp - 1));
          case 0x37: case 0x39:
            return store(n, S(sp - 2));
          case 0x84:
            return store(n, `(${L(n)} + ${s16(code, pc + 4)}) | 0`);
        }
        throw new Refused('opcode');
      }
      case 0xc5: {
        const dims = code[pc + 3]!;
        const base = sp - dims;
        return (
          `f.pc = ${pc}; ${at} { const c = R.resolveClass(jvm, cls, ${idx}); const counts = [${Array.from({ length: dims }, (_, i) => S(base + i)).join(', ')}]; ` +
          `if (counts.some((n) => n < 0)) throw new R.PendingThrow('java/lang/NegativeArraySizeException'); ${S(base)} = R.multiArray(jvm, c, counts, 0); }`
        );
      }
      case 0xcb: {
        const target = pc + s16(code, pc + 1);
        return `f.pc = ${pc}; ${spill(sp)} f.sp = ${sp}; ${at} { const next = f.method.loopHooks.get(${pc})(jvm, t, f.method, locals); ${reloadLocals}pc = next === R.DECLINE ? ${target} : next; continue; }`;
      }
    }
    throw new Refused(op === 0xa8 || op === 0xa9 || op === 0xc9 ? 'jsr' : 'opcode');
  }

  const hoisted = consts.map((_, i) => `const k${i} = K[${i}];`).join('\n');
  const body = `${hoisted}
return function compiled(jvm, t, f, budget) {
const stack = f.stack, locals = f.locals;
let pc = f.pc;
${Array.from({ length: maxLocals }, (_, n) => `let l${n} = locals[${n}];`).join(' ')}
${Array.from({ length: maxStack }, (_, i) => `let s${i} = stack[${i}];`).join(' ')}
try {
dispatch: for (;;) {
switch (pc) {
${out.join('\n')}
default: {
${spillAll}
f.pc = pc; const d = SP[pc]; if (d !== undefined && d >= 0) f.sp = d; R.exit = 1; return budget;
}
}
}
} catch (e) {
${spillAll}
budget += REF[pc]; f.pc = pc; R.caught(jvm, t, f, e, SP[pc]); R.exit = 0; return budget;
}
};`;
  return { body, consts, sp: spAt, refund };
}
