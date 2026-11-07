// SPDX-License-Identifier: LGPL-3.0-or-later
import type { IndexBdmv } from '@seikou/bdmv/index-parser';
import type { RegisterFile } from '../hdmv/registers';

/** _fill_disc_info: a UHD (0300) index switches to the Profile 6 settings, a 3D one (02xx with content) to Profile 5. */
export function applyDiscProfile(regs: RegisterFile, index: IndexBdmv): void {
  if (index.version >= '0300') regs.psrInitUhd(true);
  if (index.version[1] === '2' && index.appInfo.contentExistFlag) regs.psrInit3D(index.appInfo.initialOutputModePreference, false);
}
