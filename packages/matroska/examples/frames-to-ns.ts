// SPDX-License-Identifier: LGPL-3.0-or-later
// Convert 24 frames of 23.976 fps video to nanoseconds.
import { framesToNs } from '@seikou/matroska';

export default async function example(): Promise<void> {
  const ns = framesToNs(24, { fpsNum: 24000, fpsDen: 1001 });
  console.log('24 frames last', ns, 'ns');
  if (ns !== 1_001_000_000n) throw new Error('24 frames at 23.976 fps last 1.001 s');
}
