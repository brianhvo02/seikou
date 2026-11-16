// SPDX-License-Identifier: LGPL-3.0-or-later
// A title with a Dolby Vision UHD and an SDR Blu-ray of the same film is labelled Dolby Vision.
import { bestDynamicRange } from '@seikou/nas';

export default async function example(): Promise<void> {
  const title = bestDynamicRange(['dv', null]);
  const sdr = bestDynamicRange([null, undefined]);
  console.log('UHD and Blu-ray:', title, '- Blu-ray only:', sdr);
  if (title !== 'dv' || sdr !== null) throw new Error('the dynamic range order is wrong');
}
