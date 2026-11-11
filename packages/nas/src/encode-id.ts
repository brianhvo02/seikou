// SPDX-License-Identifier: LGPL-3.0-or-later
import { parseTitlePart, titlePart } from './encode-title';
import type { EncodeTitle } from './encode-title';

/**
 * An encoded episode's id, `<titlePart>-<episode>` (`990001-3` for an AniList entry, `tv990002s2-5`, `mv990003-1`,
 * `own<hex>-4`): what the NAS routes and the player name an encode by.
 */
export function encodeId(title: EncodeTitle, episode: number): string {
  return `${titlePart(title)}-${episode}`;
}

const POSITIVE = /^[1-9]\d{0,14}$/;

function pair(text: string, separator: string): { title: EncodeTitle; episode: number } | null {
  const parts = text.split(separator);
  if (parts.length !== 2 || !POSITIVE.test(parts[1]!)) return null;
  const title = parseTitlePart(parts[0]!);
  return title ? { title, episode: Number(parts[1]) } : null;
}

/** The title and episode of an encode id; null for anything else (the episode is a whole number of 1 or more). */
export function parseEncodeId(id: string): { title: EncodeTitle; episode: number } | null {
  return pair(id, '-');
}

/** The key a place of an encoded episode is kept under, `e.<titlePart>.<episode>` (discs use `d.` and `f.`). */
export function encodePlaceKey(title: EncodeTitle, episode: number): string {
  return `e.${titlePart(title)}.${episode}`;
}

/**
 * The title and episode of an encode place key; null for anything else.
 * @internal
 */
export function parseEncodePlaceKey(key: string): { title: EncodeTitle; episode: number } | null {
  return key.startsWith('e.') ? pair(key.slice(2), '.') : null;
}
