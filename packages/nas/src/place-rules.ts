/** Rules about saved places shared by the NAS server and the app (resume spec 2026-10-20 §6.5). Original code. */

/** A place this near the start asks nothing (and stays off Continue watching): at most 30 s... */
export const SHORT_PLACE_MAX_US = 30_000_000;
/** ...and less than this share of the playlist. */
export const SHORT_PLACE_SHARE = 0.05;

/** Whether a place is too near its playlist's start to offer resuming: before min(30 s, 5% of the playlist). */
export function isShortPlace(timeUs: number, durationUs: number): boolean {
  return timeUs < Math.min(SHORT_PLACE_MAX_US, Math.max(0, durationUs) * SHORT_PLACE_SHARE);
}
