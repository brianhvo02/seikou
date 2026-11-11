// SPDX-License-Identifier: LGPL-3.0-or-later
// Write a string element and read it back.
import { Id, ascii, find, parseMkv, stringOf } from '@seikou/matroska';

export default async function example(): Promise<void> {
  const bytes = ascii(Id.DocType, 'webm');

  const value = stringOf(find(parseMkv(bytes), Id.DocType));
  console.log(value);
  if (value !== 'webm') throw new Error('the string changed');
}
