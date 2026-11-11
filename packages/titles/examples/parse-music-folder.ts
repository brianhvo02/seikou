// SPDX-License-Identifier: LGPL-3.0-or-later
// Split a music release folder into its date, artist and title.
import { parseMusicFolder } from '@seikou/titles';

export default async function example(): Promise<void> {
  const release = parseMusicFolder('[2021.06.02] Glass Orchard - Paper Lanterns (Single) [CD][FLAC+CUE+BDMV][ZZZZ-0001]');
  console.log(release);
  if (release.date !== '2021-06-02' || release.artist !== 'Glass Orchard' || release.title !== 'Paper Lanterns' || !release.single) throw new Error('the folder was misread');

  const bare = parseMusicFolder('Paper Lanterns');
  if (bare.artist !== null || bare.title !== 'Paper Lanterns') throw new Error('a name with no artist gave one');
}
