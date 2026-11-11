// SPDX-License-Identifier: LGPL-3.0-or-later
// Run many jobs but only two at a time; the rest wait in order.
import { Semaphore } from '@seikou/fansubs';

export default async function example(): Promise<void> {
  // #region construct
  const slots = new Semaphore(2);
  // #endregion

  // #region run
  let active = 0;
  let busiest = 0;
  const job = (n: number): Promise<number> =>
    slots.run(async () => {
      active++;
      busiest = Math.max(busiest, active);
      await new Promise((resolve) => setTimeout(resolve, 5));
      active--;
      return n * n;
    });
  const squares = await Promise.all([1, 2, 3, 4, 5].map(job));
  console.log(squares, 'never more than', busiest, 'at once');
  // #endregion
  if (squares.join() !== '1,4,9,16,25' || busiest !== 2) throw new Error('the jobs were not limited to two');

  // A waiter whose signal aborts leaves the line.
  const gone = new AbortController();
  const holder = slots.run(() => new Promise((resolve) => setTimeout(resolve, 20)));
  const holder2 = slots.run(() => new Promise((resolve) => setTimeout(resolve, 20)));
  const waiting = slots.run(async () => 'never', gone.signal);
  gone.abort();
  await waiting.then(
    () => {
      throw new Error('an aborted waiter ran');
    },
    () => undefined,
  );
  await Promise.all([holder, holder2]);
}
