/*
 * Copyright (C) 2026  Seikou contributors
 *
 * SPDX-License-Identifier: LGPL-3.0-or-later
 */

import { GPR_COUNT, PSR_COUNT, RegisterFile } from '@seikou/engine/hdmv/registers';

/** The register file's size in 32-bit words: the PSRs first, then the GPRs, as RegisterFile lays them out. */
export const REGISTER_WORDS = PSR_COUNT + GPR_COUNT;

/** A new shared register file with RegisterFile's initial values written into it (PSRs at their defaults, GPRs 0). */
export function createRegisterBuffer(): SharedArrayBuffer {
  const buffer = new SharedArrayBuffer(REGISTER_WORDS * 4);
  new RegisterFile({ shared: buffer });
  return buffer;
}

/**
 * The BD-J worker's read-only view of the register file the engine worker owns, read with Atomics so a value the
 * engine stored is seen at once. Java's register writes go to the engine as `writeReg` calls instead.
 */
export class SharedRegisterView {
  private readonly words: Int32Array;

  constructor(buffer: SharedArrayBuffer) {
    this.words = new Int32Array(buffer);
  }

  /** PSR `i` as an unsigned value; 0xffffffff for a number out of range, as libbluray's register.c bd_psr_read returns -1. */
  psrRead(i: number): number {
    return i >= 0 && i < PSR_COUNT ? Atomics.load(this.words, i) >>> 0 : 0xffffffff;
  }

  /** GPR `i` as an unsigned value; 0 for a number out of range, as bd_gpr_read. */
  gprRead(i: number): number {
    return i >= 0 && i < GPR_COUNT ? Atomics.load(this.words, PSR_COUNT + i) >>> 0 : 0;
  }
}
