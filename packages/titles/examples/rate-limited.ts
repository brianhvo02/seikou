// SPDX-License-Identifier: LGPL-3.0-or-later
// A paced call that gets a 429 throws RateLimited; the pacer waits out its Retry-After and retries once.
import { Pacer, RateLimited } from '@seikou/titles';

export default async function example(): Promise<void> {
  const slept: number[] = [];
  let now = 0;
  const pacer = new Pacer(5, 1_000, () => now, async (ms) => {
    slept.push(ms);
    now += ms;
  });

  let calls = 0;
  const answer = await pacer.run(async () => {
    calls++;
    if (calls === 1) throw new RateLimited(2_000); // as if the source said "Retry-After: 2"
    return 'answered';
  });
  console.log(answer, 'after', calls, 'calls, waited', slept);
  if (answer !== 'answered' || calls !== 2 || slept.reduce((a, b) => a + b, 0) < 2_000) throw new Error('the pacer did not wait and retry');
}
