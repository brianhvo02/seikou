/*
 * Ported from libbluray src/libbluray/bluray.c (_fill_disc_info: the psr_init_UHD and
 * psr_init_3D calls) and src/libbluray/register.c
 * Copyright (C) 2009-2010  John Stebbins
 * Copyright (C) 2010-2017  Petri Hintukainen <phintuka@users.sourceforge.net>
 *
 * Ported to TypeScript and modified for Seikou, 2026.
 *
 * SPDX-License-Identifier: LGPL-2.1-or-later
 */

import type { IndexBdmv } from '@seikou/bdmv/index-parser';
import type { RegisterFile } from '../hdmv/registers';

/**
 * Raises the player profile registers for the disc, as libbluray's `_fill_disc_info` in `bluray.c` does after reading the
 * index: an index version of 0300 or later (Ultra HD) applies `psr_init_UHD` (forced) and a version 02xx index with its
 * content-exist flag set (3D) applies `psr_init_3D` with the index's initial output mode preference (not forced).
 */
export function applyDiscProfile(regs: RegisterFile, index: IndexBdmv): void {
  if (index.version >= '0300') regs.psrInitUhd(true);
  if (index.version[1] === '2' && index.appInfo.contentExistFlag) regs.psrInit3D(index.appInfo.initialOutputModePreference, false);
}
