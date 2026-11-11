// SPDX-License-Identifier: LGPL-3.0-or-later
// Write a signed integer element (a ReferenceBlock is signed).
import { Id, sint } from '@seikou/matroska';

export default async function example(): Promise<void> {
  const bytes = sint(Id.ReferenceBlock, -5);

  console.log(Array.from(bytes, (b) => b.toString(16)));
  // id 0xfb, size 1, then -5 as one two's-complement byte
  if (bytes.join() !== '251,129,251') throw new Error('-5 is not 0xfb');
}
