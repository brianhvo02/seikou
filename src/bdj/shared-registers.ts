/*
 * Copyright (C) 2026  Seikou contributors
 *
 * SPDX-License-Identifier: LGPL-3.0-or-later
 */

import { GPR_COUNT, PSR_COUNT, RegisterFile } from '@seikou/engine/hdmv/registers';

export const REGISTER_WORDS = PSR_COUNT + GPR_COUNT;

export function createRegisterBuffer(): SharedArrayBuffer {
  const buffer = new SharedArrayBuffer(REGISTER_WORDS * 4);
  new RegisterFile({ shared: buffer });
  return buffer;
}

export class SharedRegisterView {
  private readonly words: Int32Array;

  constructor(buffer: SharedArrayBuffer) {
    this.words = new Int32Array(buffer);
  }

  psrRead(i: number): number {
    return i >= 0 && i < PSR_COUNT ? Atomics.load(this.words, i) >>> 0 : 0xffffffff;
  }

  gprRead(i: number): number {
    return i >= 0 && i < GPR_COUNT ? Atomics.load(this.words, PSR_COUNT + i) >>> 0 : 0;
  }
}
