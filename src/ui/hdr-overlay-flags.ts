// SPDX-License-Identifier: LGPL-3.0-or-later
/**
 * What the page's query says about overlays over HDR video: `?hdrgain=<n>` tunes the gain on their white (the
 * default is 2.03, graphics white over a 100 cd/m² SDR white; the engine keeps it within 1 to 10), for judging it by eye
 * on an HDR display, and the test-only `?displayhdr=1` reports an HDR display whatever `(dynamic-range: high)` says, so
 * the HDR overlay route can be tested in a headless browser.
 */
export function hdrOverlayOptions(search: string): { gain?: number; displayHdr?: boolean } {
  const params = new URLSearchParams(search);
  const out: { gain?: number; displayHdr?: boolean } = {};
  const raw = params.get('hdrgain');
  const gain = raw === null || raw.trim() === '' ? Number.NaN : Number(raw);
  if (Number.isFinite(gain)) out.gain = gain;
  if (params.get('displayhdr') === '1') out.displayHdr = true;
  return out;
}
