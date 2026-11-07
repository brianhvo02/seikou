/*
 * Original code for bluray-web: the errors the BD-J runtime reports to the player.
 *
 * Copyright (C) 2026 bluray-web contributors
 *
 * SPDX-License-Identifier: LGPL-2.1-or-later
 */

import type { BdjErrorCode } from '../bdj-types';
export type { BdjErrorCode } from '../bdj-types';

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
