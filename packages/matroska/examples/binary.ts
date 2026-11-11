// SPDX-License-Identifier: LGPL-3.0-or-later
// Write a binary element and find its bytes in the parsed tree.
import { Id, binary, find, parseMkv } from '@seikou/matroska';

export default async function example(): Promise<void> {
  const bytes = binary(Id.CodecPrivate, new Uint8Array([9, 8, 7]));

  const node = find(parseMkv(bytes), Id.CodecPrivate);
  console.log(node.bytes);
  if (node.bytes!.join() !== '9,8,7') throw new Error('the payload changed');
}
