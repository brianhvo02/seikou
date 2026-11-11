// SPDX-License-Identifier: LGPL-3.0-or-later
// The key a disc is linked by: its content fingerprint, or its id when it has no clips.
import { discKeyOf } from '@seikou/nas';

export default async function example(): Promise<void> {
  const files = [{ path: 'BDMV/STREAM/00001.M2TS', size: 1000 }];

  const byContent = discKeyOf('0123456789abcdef', files);
  const byId = discKeyOf('0123456789abcdef', []);
  console.log(byContent, byId);
  if (!byContent.startsWith('f.') || byId !== 'd.0123456789abcdef') throw new Error('unexpected disc keys');
}
