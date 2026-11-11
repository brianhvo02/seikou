// SPDX-License-Identifier: LGPL-3.0-or-later
// Read sound.bdmv and report the length of each menu sound.
import { readFile } from 'node:fs/promises';
import { parseSoundBdmv } from '@seikou/bdmv';

export default async function example(): Promise<void> {
  // #region parse
  const bytes = await readFile(new URL('../../../fixtures/synthetic/disc-menu/BDMV/AUXDATA/sound.bdmv', import.meta.url));
  const sounds = parseSoundBdmv(new Uint8Array(bytes));
  for (const clip of sounds.clips) console.log(clip.channels, 'channel(s),', clip.samples.length / clip.channels / clip.sampleRate, 's');
  // #endregion
  if (sounds.clips.length === 0) throw new Error('sound.bdmv holds no sounds');
}
