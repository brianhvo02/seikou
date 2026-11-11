// SPDX-License-Identifier: LGPL-3.0-or-later
// Nest elements: an Info with a timestamp scale and a title.
import { Id, childOf, find, master, parseMkv, stringOf, uint, utf8 } from '@seikou/matroska';

export default async function example(): Promise<void> {
  const info = master(Id.Info, [uint(Id.TimestampScale, 1_000_000), utf8(Id.Title, 'Nested')]);

  const node = find(parseMkv(info), Id.Info);
  console.log(node.children!.length, 'children');
  if (node.children!.length !== 2 || stringOf(childOf(node, Id.Title)!) !== 'Nested') throw new Error('the children were lost');
}
