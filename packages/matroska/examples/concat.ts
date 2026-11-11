// SPDX-License-Identifier: LGPL-3.0-or-later
// Join byte arrays into one.
import { concat } from '@seikou/matroska';

export default async function example(): Promise<void> {
  const joined = concat([new Uint8Array([1, 2]), new Uint8Array(0), new Uint8Array([3])]);
  console.log(joined);
  if (joined.join() !== '1,2,3') throw new Error('the parts were not joined');
}
