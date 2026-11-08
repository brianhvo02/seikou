// SPDX-License-Identifier: LGPL-3.0-or-later

/** An encoded episode's id, `<anilistId>-<episode>`: what the NAS routes and the player name an encode by. */
export function encodeId(anilistId: number, episode: number): string {
  return `${anilistId}-${episode}`;
}

const POSITIVE = /^[1-9]\d{0,14}$/;

function pair(text: string, separator: string): { anilistId: number; episode: number } | null {
  const parts = text.split(separator);
  if (parts.length !== 2 || !POSITIVE.test(parts[0]!) || !POSITIVE.test(parts[1]!)) return null;
  return { anilistId: Number(parts[0]), episode: Number(parts[1]) };
}

/** The AniList id and episode of an encode id; null for anything else (both are whole numbers of 1 or more). */
export function parseEncodeId(id: string): { anilistId: number; episode: number } | null {
  return pair(id, '-');
}

/** The key a place of an encoded episode is kept under, `e.<anilistId>.<episode>` (discs use `d.` and `f.`). */
export function encodePlaceKey(anilistId: number, episode: number): string {
  return `e.${anilistId}.${episode}`;
}

/** The AniList id and episode of an encode place key; null for anything else. */
export function parseEncodePlaceKey(key: string): { anilistId: number; episode: number } | null {
  return key.startsWith('e.') ? pair(key.slice(2), '.') : null;
}
