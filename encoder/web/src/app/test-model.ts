// SPDX-License-Identifier: LGPL-3.0-or-later
import type { EncodeSettings, TestProfileResult } from '../api-types';

// What the Test page shows about a test encode, worked out from the job. Pure.

/** The most profiles one test compares. */
export const MAX_TEST_PROFILES = 3;

/** How far, in seconds, a video of a row may drift from the row's first before it is moved back. */
export const DRIFT_SECONDS = 0.1;

/**
 * The bytes an episode of `episodeSeconds` would take: the profile's video bytes per second plus the shared audio's
 * bytes per second once for each of the `audioStreams` streams the encode writes, times the length.
 */
export function projectedBytes(episodeSeconds: number, result: Pick<TestProfileResult, 'videoBytesPerSecond' | 'audioBytesPerSecond'>, audioStreams: number): number {
  return (result.videoBytesPerSecond + result.audioBytesPerSecond * audioStreams) * episodeSeconds;
}

/** A size in decimal units: "9.5 MB" below 10 MB, "418 MB" below 1 GB, "1.23 GB" from there. */
export function formatSize(bytes: number): string {
  const mb = bytes / 1e6;
  if (mb < 10) return `${mb.toFixed(1)} MB`;
  if (mb < 1000) return `${Math.round(mb)} MB`;
  return `${(bytes / 1e9).toFixed(2)} GB`;
}

/** A time in the playlist as "m:ss" or "h:mm:ss", seconds rounded down so a stretch's label never lies after its start. */
export function formatPlaylistTime(ms: number): string {
  const total = Math.floor(ms / 1000);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const ss = String(total % 60).padStart(2, '0');
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${ss}` : `${m}:${ss}`;
}

/** The settings a test compares, in one line: CRF, preset, film grain and any extra SVT-AV1 arguments. */
export function testSummary(s: EncodeSettings): string {
  const parts = [`CRF ${s.crf}`, `preset ${s.preset}`, `film grain ${s.filmGrain}`];
  if (s.extraSvtArgs.length > 0) parts.push(s.extraSvtArgs.join(' '));
  return parts.join(', ');
}
