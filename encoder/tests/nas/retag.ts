// SPDX-License-Identifier: LGPL-3.0-or-later
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

// Copies of the encodes fixture's episode 1 (AniList 990001) with its tags rewritten in place, so the NAS files them
// under another made-up entry or episode, or refuses them for want of a tag.

const EPISODE_ONE = fileURLToPath(new URL('../../../fixtures/encodes/990001/1.mkv', import.meta.url));

/** SimpleTag `TagName` (45 A3, size) followed by its `TagString` (44 87, size) header. */
function tagAt(bytes: Buffer, name: string, valueLength: number): number {
  const head = Buffer.concat([Buffer.from([0x45, 0xa3, 0x80 | name.length]), Buffer.from(name), Buffer.from([0x44, 0x87, 0x80 | valueLength])]);
  const at = bytes.indexOf(head);
  if (at < 0 || bytes.indexOf(head, at + 1) >= 0) throw new Error(`the fixture has no single ${name} tag`);
  return at + head.length;
}

/**
 * Episode 1's file tagged `ANILIST_ID` `anilistId` (six digits, as 990001) and `EPISODE` `episode` (one digit); with
 * `noAniList` its `ANILIST_ID` tag is renamed so the file has none.
 */
export function retagged(anilistId: number, episode: number, o: { noAniList?: boolean } = {}): Buffer {
  const id = String(anilistId);
  const ep = String(episode);
  if (id.length !== 6 || ep.length !== 1) throw new Error('a six-digit AniList id and a one-digit episode are rewritten in place');
  const bytes = readFileSync(EPISODE_ONE);
  const idAt = tagAt(bytes, 'ANILIST_ID', 6);
  bytes.write(id, idAt);
  bytes.write(ep, tagAt(bytes, 'EPISODE', 1));
  if (o.noAniList) bytes.write('ANILIST_XX', idAt - 3 - 'ANILIST_ID'.length);
  return bytes;
}
