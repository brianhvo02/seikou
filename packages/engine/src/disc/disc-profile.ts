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

/** _fill_disc_info: a UHD (0300) index switches to the Profile 6 settings, a 3D one (02xx with content) to Profile 5. */
export function applyDiscProfile(regs: RegisterFile, index: IndexBdmv): void {
  if (index.version >= '0300') regs.psrInitUhd(true);
  if (index.version[1] === '2' && index.appInfo.contentExistFlag) regs.psrInit3D(index.appInfo.initialOutputModePreference, false);
}
