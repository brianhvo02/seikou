// SPDX-License-Identifier: LGPL-3.0-or-later
import { DemoPlayer } from '@seikou/demo';

// #region construct
const player = new DemoPlayer('main');
// #endregion

// #region open
async function main(): Promise<void> {
  await player.open('/disc');
}
// #endregion
void main();
