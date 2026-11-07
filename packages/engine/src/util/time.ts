/** PTS values are 33-bit, 90 kHz. Navigation times (MPLS/CLPI) are 45 kHz. */
export const PTS_WRAP = 2 ** 33;

export function ticks45ToUs(ticks: number): number {
  return Math.round((ticks * 200) / 9);
}

export function usToTicks45(us: number): number {
  return Math.round((us * 9) / 200);
}

export function pts90ToUs(pts: number): number {
  return Math.round((pts * 100) / 9);
}

/** Signed a − b in 90 kHz units, treating both as points on the 33-bit wrapping PTS line. */
export function ptsDelta90(a: number, b: number): number {
  let d = (a - b) % PTS_WRAP;
  if (d > PTS_WRAP / 2) d -= PTS_WRAP;
  else if (d <= -PTS_WRAP / 2) d += PTS_WRAP;
  return d;
}
