// SPDX-License-Identifier: LGPL-3.0-or-later
// Write a UTF-8 string element with Japanese text and read it back.
import { Id, find, parseMkv, stringOf, utf8 } from '@seikou/matroska';

export default async function example(): Promise<void> {
  const bytes = utf8(Id.Title, '青光 第一話');

  const value = stringOf(find(parseMkv(bytes), Id.Title));
  console.log(value);
  if (value !== '青光 第一話') throw new Error('the text changed');
}
