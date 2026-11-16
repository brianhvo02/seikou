// SPDX-License-Identifier: LGPL-3.0-or-later
/**
 * The main title of a disc as Seikou's NAS library and pre-flight both choose it, from its playlists and file list.
 */
import { chooseMainTitle, type MainTitleCandidate } from './main-title';
import { clipInfoPath, streamPath } from './open-disc';

const PLAYLIST_ID = /^\d{5}$/;

/**
 * The main title (libbluray's choice) among `playlists` that could play: a five-digit name, video in its first play
 * item, and every clip's CLPI and M2TS on the disc (`has` answers for an upper-cased disc-relative path); null when
 * none can.
 * @internal
 */
export function playableMainTitle(playlists: readonly MainTitleCandidate[], has: (path: string) => boolean): MainTitleCandidate | null {
  const candidates = playlists.filter(
    (c) =>
      PLAYLIST_ID.test(c.id) &&
      c.mpls.playItems.length > 0 &&
      c.mpls.playItems[0]!.stn.video.some((v) => !v.subPath) &&
      c.mpls.playItems.every((p) => has(clipInfoPath(p.clipId)) && has(streamPath(p.clipId))),
  );
  const id = chooseMainTitle(candidates);
  return candidates.find((c) => c.id === id) ?? null;
}
