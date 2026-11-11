/*
 * Original code for Seikou: the playback state the engine publishes each tick for the BD-J worker's synchronous
 * natives (tellTimeN, getUOMaskN).
 *
 * Copyright (C) 2026  Seikou contributors
 *
 * SPDX-License-Identifier: LGPL-3.0-or-later
 */

import type { StatusBlockWriterLike } from '@seikou/engine/bdj-types';

const TIME45 = 0;
const UO_MASK = 1;
const BIGINT_WORDS = 2;

/** A new status block: two 64-bit words (the time, then the UO mask), both 0. */
export function createStatusBlock(): SharedArrayBuffer {
  return new SharedArrayBuffer(BIGINT_WORDS * 8);
}

class StatusBlockViews {
  protected readonly longs: BigInt64Array;

  constructor(readonly buffer: SharedArrayBuffer) {
    this.longs = new BigInt64Array(buffer, 0, BIGINT_WORDS);
  }
}

/** The engine worker's side of the status block: it writes the time and the UO mask, each word with Atomics. */
export class StatusBlockWriter extends StatusBlockViews implements StatusBlockWriterLike {
  /** bd_tell_time's out_time: the title time of the current packet, in 45 kHz ticks. */
  setTime45(t: bigint): void {
    Atomics.store(this.longs, TIME45, BigInt.asIntN(64, t));
  }

  /** The user operations masked now: bdpriv_get_uo_mask's bits (bluray.c), one per UO mask index. */
  setUoMask(bits: bigint): void {
    Atomics.store(this.longs, UO_MASK, BigInt.asIntN(64, bits));
  }
}

/**
 * The BD-J worker's side of the status block, read synchronously by libbluray's tellTimeN and getUOMaskN natives
 * (org_videolan_Libbluray.c), which in libbluray read the player's state directly.
 */
export class StatusBlockReader extends StatusBlockViews {
  /** The last time the engine published, in 45 kHz ticks. */
  time45(): bigint {
    return BigInt.asUintN(64, Atomics.load(this.longs, TIME45));
  }

  /** The last UO mask bits the engine published. */
  uoMask(): bigint {
    return BigInt.asUintN(64, Atomics.load(this.longs, UO_MASK));
  }
}
