// SPDX-License-Identifier: LGPL-3.0-or-later
// Rank a SeaDex entry's public releases: the curators' best first, then web releases, then the rest.
import { rankReleases, type SeaDexEntry, type SeaDexRelease } from '@seikou/fansubs';

export default async function example(): Promise<void> {
  const release = (group: string, o: Partial<SeaDexRelease>): SeaDexRelease => ({
    tracker: 'Nyaa', infoHash: 'a'.repeat(40), isBest: false, dualAudio: false, group, tags: [], files: [], ...o,
  });
  const entry: SeaDexEntry = {
    alId: 990001, incomplete: false, notes: '', comparison: '',
    releases: [
      release('Group C', {}),
      release('Group B', { tags: ['Web'] }),
      release('Group A', { isBest: true }),
      release('Private Group', { infoHash: null, isBest: true }), // redacted: private trackers are left out
    ],
  };
  const ranked = rankReleases(entry);
  console.log(ranked.map((r) => r.release.group + ' (' + r.rank + ')'));
  if (ranked.map((r) => r.rank).join() !== 'best,web,other' || ranked[0]!.release.group !== 'Group A') throw new Error('the ranking is wrong');
}
