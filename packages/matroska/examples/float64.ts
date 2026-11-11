// SPDX-License-Identifier: LGPL-3.0-or-later
// Write a float element and read it back.
import { Id, find, float64, floatOf, parseMkv } from '@seikou/matroska';

export default async function example(): Promise<void> {
  const bytes = float64(Id.Duration, 2500.5);

  const value = floatOf(find(parseMkv(bytes), Id.Duration));
  console.log(bytes.length, 'bytes, value', value);
  if (value !== 2500.5) throw new Error('the value changed');
}
