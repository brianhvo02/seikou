// SPDX-License-Identifier: LGPL-3.0-or-later
import { parseDiscKey } from './disc-key';
import type { ParsedDiscKey } from './disc-key';
import { parseEncodePlaceKey } from './encode-id';

/** What a place key names: a disc (by fingerprint or id) or an encoded episode. */
export type ParsedPlaceKey =
  | { readonly kind: 'disc'; readonly key: ParsedDiscKey }
  | { readonly kind: 'encode'; readonly anilistId: number; readonly episode: number };

/**
 * A place key of either library: `f.`/`d.` for a disc, `e.<anilistId>.<episode>` for an encode; null for anything
 * else. Only the places store and routes take both; whatever looks a disc up keeps to `parseDiscKey`.
 */
export function parsePlaceKey(key: string): ParsedPlaceKey | null {
  const disc = parseDiscKey(key);
  if (disc) return { kind: 'disc', key: disc };
  const encode = parseEncodePlaceKey(key);
  return encode ? { kind: 'encode', ...encode } : null;
}

/** The playlist id an encode's one place is kept under (an encode has one file and no playlists). */
export const ENCODE_PLAYLIST = 'mkv';
