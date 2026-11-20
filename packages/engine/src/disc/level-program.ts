/*
 * Original code for Seikou: what a disc program sees of a NAS disc played at a quality level.
 *
 * Copyright (C) 2026  Seikou contributors
 *
 * SPDX-License-Identifier: LGPL-3.0-or-later
 */

import { parseMpls, type Mpls } from '@seikou/bdmv/mpls-parser';
import type { DiscManifest } from '@seikou/nas/nas-api';
import type { DiscSpec } from './disc-spec';
import type { DiscModel } from './open-disc';

/**
 * The original audio stream (1-based) a quality level carries, from its query's `audio=<n>`; null for picked files, the
 * original version, or a query that names none. The level's playlists list that one stream, as their stream 1.
 * @internal
 */
export function levelAudioOf(spec: DiscSpec): number | null {
  if (spec.kind !== 'remote' || !spec.query || !spec.original) return null;
  const params = new URLSearchParams(spec.query);
  if (!params.has('level')) return null;
  const n = Number(params.get('audio') ?? '1');
  return Number.isInteger(n) && n > 0 ? n : null;
}

/**
 * The disc model a program (HDMV navigator or BD-J host) reads at a level: the level's, with every play item's audio
 * streams taken from the original's playlist (inlined in `original`), so the program's PSR1 keeps the disc's own
 * numbering instead of being clamped to the level's one stream. A playlist the original lacks, or whose play items
 * differ in number, keeps the level's streams.
 * @internal
 */
export function withOriginalAudio(disc: DiscModel, original: DiscManifest): DiscModel {
  const playlists = new Map<string, Mpls>();
  for (const [id, mpls] of disc.playlists) {
    const base64 = original.inline[`BDMV/PLAYLIST/${id}.MPLS`];
    let source: Mpls | null = null;
    if (base64 !== undefined) {
      try {
        source = parseMpls(decodeBase64(base64));
      } catch {
        source = null;
      }
    }
    if (!source || source.playItems.length !== mpls.playItems.length) {
      playlists.set(id, mpls);
      continue;
    }
    const from = source;
    playlists.set(id, { ...mpls, playItems: mpls.playItems.map((item, i) => ({ ...item, stn: { ...item.stn, audio: from.playItems[i]!.stn.audio } })) });
  }
  return { ...disc, playlists };
}

/** The bytes of a base64 string (a manifest's inlined file). @internal */
export function decodeBase64(base64: string): Uint8Array {
  const binary = atob(base64);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}
