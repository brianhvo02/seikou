/*
 * Original code for Seikou: the errors the BD-J runtime reports to the player.
 *
 * Copyright (C) 2026 Seikou contributors
 *
 * SPDX-License-Identifier: LGPL-3.0-or-later
 */

import type { BdjErrorCode } from '@seikou/engine/bdj-types';
export type { BdjErrorCode } from '@seikou/engine/bdj-types';

export class BdjError extends Error {
  constructor(
    readonly code: BdjErrorCode,
    message: string,
    readonly javaStack: readonly string[] = [],
  ) {
    super(message);
    this.name = 'BdjError';
  }
}
