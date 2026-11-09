// SPDX-License-Identifier: LGPL-3.0-or-later
/**
 * The Subtitles menu's NAS sources for an encoded episode: the entry's source tags (`GET encodes/<id>`), the subtitle
 * store's uploads for that disc and playlist, and, when one is attached to a chapter, the source playlist's chapters
 * (from the disc's manifest, when the NAS still has the disc) to find the episode's first chapter.
 */
import type { EncodeDetail, StoredSubtitle } from '@seikou/nas/nas-api';
import { Timeline } from '@seikou/engine/nav/timeline';
import { playlistOf } from './library-model';
import type { NasClient } from './nas-client';
import { forPlaylist, STORED_LIST_TIMEOUT_MS, storedForEncode, type EncodeStored } from './subtitle-model';

/** What the player keeps of an encode for its Subtitles menu. */
export interface EncodeSubtitleSources {
  readonly entry: EncodeDetail;
  readonly stored: readonly EncodeStored[];
}

/** Whether an encode's tags name where it came from: the disc, the playlist and its start there. */
export function hasSource(entry: EncodeDetail): entry is EncodeDetail & { readonly discKey: string; readonly playlistId: string; readonly episodeStartMs: number } {
  return entry.discKey !== null && entry.playlistId !== null && entry.episodeStartMs !== null;
}

/**
 * The entry and the stored subtitles it offers. The source chapters are read only when a chapter attachment is listed
 * for the source playlist; a disc the NAS no longer has (or a manifest that fails) offers none of those. Null when the
 * entry is gone. A failed subtitle list offers none.
 */
export async function loadEncodeSubtitles(
  nas: Pick<NasClient, 'encode' | 'subtitlesForDisc' | 'resolveDisc' | 'manifest'>,
  encodeId: string,
  log: (message: string, err: unknown) => void = (m, e) => console.warn(m, e),
): Promise<EncodeSubtitleSources | null> {
  const entry = await nas.encode(encodeId);
  if (!entry) return null;
  if (!hasSource(entry)) return { entry, stored: [] };
  let items: StoredSubtitle[];
  try {
    items = forPlaylist(await nas.subtitlesForDisc(entry.discKey, { timeoutMs: STORED_LIST_TIMEOUT_MS }), entry.discKey, entry.playlistId);
  } catch (err) {
    log('listing the stored subtitles failed', err);
    return { entry, stored: [] };
  }
  let chaptersMs: number[] | null = null;
  if (items.some((s) => s.attachment.kind === 'chapter')) {
    try {
      const disc = await nas.resolveDisc(entry.discKey);
      const mpls = disc ? playlistOf(await nas.manifest(disc.id), entry.playlistId) : null;
      if (mpls && mpls.playItems.length > 0) chaptersMs = new Timeline(mpls.playItems, mpls.marks).chapters(mpls.marks).map((c) => c.startUs / 1000);
    } catch (err) {
      log("reading the source disc's chapters failed", err);
    }
  }
  return { entry, stored: storedForEncode(items, entry, chaptersMs) };
}
