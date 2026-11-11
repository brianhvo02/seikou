// SPDX-License-Identifier: LGPL-3.0-or-later
// Write an unsigned integer element and read it back through the tree.
import { Id, find, parseMkv, uint, uintOf } from '@seikou/matroska';

export default async function example(): Promise<void> {
  const bytes = uint(Id.TimestampScale, 1_000_000);

  const value = uintOf(find(parseMkv(bytes), Id.TimestampScale));
  console.log(bytes.length, 'bytes, value', value);
  if (value !== 1_000_000n) throw new Error('the value changed');
}
