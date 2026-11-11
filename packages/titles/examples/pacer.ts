// SPDX-License-Identifier: LGPL-3.0-or-later
// Start at most N calls per window, with an interactive call going ahead of background ones.
import { Pacer } from '@seikou/titles';

export default async function example(): Promise<void> {
  // A fake clock and sleep keep the example instant: sleeping just moves the clock.
  let now = 0;
  const sleeps: number[] = [];
  const clock = {
    now: (): number => now,
    sleep: async (ms: number): Promise<void> => {
      sleeps.push(ms);
      now += ms;
    },
  };

  // #region construct
  const pacer = new Pacer(2, 1_000, clock.now, clock.sleep); // two calls per second
  // #endregion

  // #region run
  const started: string[] = [];
  const call = (name: string, urgent = false): Promise<string> =>
    pacer.run(async () => {
      started.push(name);
      return name;
    }, { urgent });

  const all = await Promise.all([call('a'), call('b'), call('c'), call('urgent', true)]);
  console.log('started in order:', started.join(' '), '| slept', sleeps);
  // #endregion
  if (all.join() !== 'a,b,c,urgent') throw new Error('every call should answer');
  // a and b fit the first window; the urgent call then goes ahead of c, which waited for the next window.
  if (started.join() !== 'a,b,urgent,c' || sleeps.join() !== '1000') throw new Error('the pacing is wrong');
}
