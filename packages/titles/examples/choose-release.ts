// SPDX-License-Identifier: LGPL-3.0-or-later
// Pick one release among exact catalogue hits: a Blu-ray medium first, then Japan, then the earliest date.
import { chooseRelease, type ReleaseCandidate } from '@seikou/titles';

export default async function example(): Promise<void> {
  const hit = (item: string, o: Partial<ReleaseCandidate<string>>): ReleaseCandidate<string> => ({ item, bluray: false, japan: false, date: null, artistKey: 'glass-orchard', ...o });

  const picked = chooseRelease([
    hit('cd-1999', { date: '1999-03-01' }),
    hit('bluray-2021', { bluray: true, date: '2021-06-02' }),
    hit('bluray-jp-2022', { bluray: true, japan: true, date: '2022-01-10' }),
  ]);
  console.log('picked', picked);
  if (picked !== 'bluray-jp-2022') throw new Error('the Blu-ray release from Japan should win');

  const disagree = chooseRelease([hit('a', {}), hit('b', { artistKey: 'blade-night' })]);
  if (disagree !== null || chooseRelease([]) !== null) throw new Error('hits by different artists must be a miss');
}
