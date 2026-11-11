// SPDX-License-Identifier: LGPL-3.0-or-later
// Put frame 30 of an NTSC 29.97 fps video on the millisecond grid.
import { videoMs } from '@seikou/matroska';

export default async function example(): Promise<void> {
  const video = { fpsNum: 30000, fpsDen: 1001 };

  const ms = videoMs(30, video);
  console.log('frame 30 at', ms, 'ms');
  if (ms !== 1001 || videoMs(0, video) !== 0) throw new Error('the frame is not on the grid');
}
