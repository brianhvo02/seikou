// SPDX-License-Identifier: LGPL-3.0-or-later
// Fingerprint a disc from the sizes of its clips, the way TheDiscDB does; the order of the list does not matter.
import { contentHash } from '@seikou/nas';

export default async function example(): Promise<void> {
  const clips = [
    { name: '00001.m2ts', size: 1000 },
    { name: '00000.m2ts', size: 2000 },
  ];

  const hash = contentHash(clips);
  console.log(hash);
  if (hash !== 'FE6728886C477A014E305CF44016C231') throw new Error('the fingerprint changed');
  if (contentHash([...clips].reverse()) !== hash) throw new Error('the order of the list changed the fingerprint');
  if (contentHash([]) !== null) throw new Error('a disc with no clips has no fingerprint');
}
