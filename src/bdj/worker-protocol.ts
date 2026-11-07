/*
 * Original code for bluray-web: the messages between the engine worker and the BD-J worker.
 *
 * Copyright (C) 2026  bluray-web contributors
 *
 * SPDX-License-Identifier: LGPL-2.1-or-later
 */

import { discTransfer } from '@seikou/engine/disc/disc-spec';
import type { ToBdj } from '@seikou/engine/bdj-types';

export type { BdjWireValue, ToBdj, FromBdj, BdjFailureCode, BdjCallName } from '@seikou/engine/bdj-types';

/** What posting `m` must transfer: a boot message's fetch port (the WebRTC route), else nothing. */
export function bootTransfer(m: ToBdj): Transferable[] {
  return m.type === 'boot' ? discTransfer(m.disc) : [];
}
