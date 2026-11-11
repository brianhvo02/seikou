// SPDX-License-Identifier: LGPL-3.0-or-later
// A place under 30 seconds or 5% of the playlist is too near the start to offer resuming.
import { isShortPlace } from '@seikou/nas';

export default async function example(): Promise<void> {
  const hour = 3_600_000_000; // microseconds

  const early = isShortPlace(10_000_000, hour);
  const later = isShortPlace(120_000_000, hour);
  console.log('10 s in:', early, '- 2 min in:', later);
  if (!early || later) throw new Error('the short place rule is wrong');
}
