// SPDX-License-Identifier: LGPL-3.0-or-later
/**
 * What the page's query says about overlays over HDR video: `?hdrgain=<n>` tunes the gain on their white (the default
 * is 2.03, graphics white over a 100 cd/m² SDR white; the engine keeps it within 1 to 10), for judging it by eye on an
 * HDR display.
 */
export function hdrOverlayOptions(search: string): { gain?: number } {
  const raw = new URLSearchParams(search).get('hdrgain');
  const gain = raw === null || raw.trim() === '' ? Number.NaN : Number(raw);
  return Number.isFinite(gain) ? { gain } : {};
}
