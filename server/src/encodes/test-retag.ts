// SPDX-License-Identifier: LGPL-3.0-or-later
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Id, childOf, concat, findAll, master, parseMkv, stringOf, uint, utf8, voidElement } from '@seikou/matroska';

/** The committed encode fixtures (AniList 990001, episodes 1 and 2). */
export const ENCODE_FIXTURES = join(import.meta.dirname, '../../../fixtures/encodes/990001');

/**
 * A copy of a fixture episode with its Segment tags changed (a value of null removes the tag), for tests only. The
 * Tags element is rewritten at its own size (a Void fills what the new tags leave), so no other byte moves; it throws
 * when the new tags don't fit (drop `ENCODER` or another tag to make room).
 */
export function retagged(episode: 1 | 2, changes: Readonly<Record<string, string | null>>): Buffer {
  const bytes = readFileSync(join(ENCODE_FIXTURES, `${episode}.mkv`));
  const tree = parseMkv(bytes);
  const [tags] = findAll(tree, Id.Tags);
  if (!tags) throw new Error('the fixture has no Tags');
  const tag = childOf(tags, Id.Tag)!;
  const old: Record<string, string> = {};
  for (const simple of tag.children ?? []) {
    if (simple.id !== Id.SimpleTag) continue;
    old[stringOf(childOf(simple, Id.TagName)!)] = stringOf(childOf(simple, Id.TagString)!);
  }
  const next: Record<string, string> = { ...old };
  for (const [name, value] of Object.entries(changes)) {
    if (value === null) delete next[name];
    else next[name] = value;
  }
  const body = concat([
    master(Id.Targets, [uint(Id.TargetTypeValue, 50)]),
    ...Object.entries(next).map(([name, value]) => master(Id.SimpleTag, [utf8(Id.TagName, name), utf8(Id.TagString, value)])),
  ]);
  const oldLength = tags.headerLength + tags.size;
  // the Tag's and the Tags' headers keep their widths when the Tag's body keeps its length
  const tagBodyLength = tag.size;
  const room = tagBodyLength - body.length;
  if (room < 2) throw new Error(`the new tags need ${-room + 2} more bytes than the fixture's`);
  const rewritten = master(Id.Tags, [master(Id.Tag, [body, voidElement(room)])]);
  if (rewritten.length !== oldLength) throw new Error('the rewritten Tags changed size');
  const out = Buffer.from(bytes);
  out.set(rewritten, tags.offset);
  return out;
}
