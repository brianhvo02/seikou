// SPDX-License-Identifier: LGPL-3.0-or-later
// Reserve ten bytes with a Void element that readers skip.
import { Id, parseMkv, voidElement } from '@seikou/matroska';

export default async function example(): Promise<void> {
  const reserved = voidElement(10);

  const node = parseMkv(reserved).children![0]!;
  console.log(reserved.length, 'bytes, id', node.id.toString(16));
  if (reserved.length !== 10 || node.id !== Id.Void) throw new Error('the reservation is not a ten byte Void');
}
