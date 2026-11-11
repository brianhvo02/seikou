// SPDX-License-Identifier: LGPL-3.0-or-later
// The length of one frame at 23.976 fps, rounded to the nearest nanosecond.
import { frameDurationNs } from '@seikou/matroska';

export default async function example(): Promise<void> {
  const ns = frameDurationNs({ fpsNum: 24000, fpsDen: 1001 });
  console.log('one frame lasts', ns, 'ns');
  if (ns !== 41_708_333n) throw new Error('the frame duration is wrong');
}
