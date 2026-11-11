// SPDX-License-Identifier: LGPL-3.0-or-later
// Measure each character of a run with the browser's text engine.
import { createCanvasMeasurer } from '@seikou/ass';

export default async function example(): Promise<void> {
  const ctx = new OffscreenCanvas(1, 1).getContext('2d')!;
  const measurer = createCanvasMeasurer(ctx);
  const metrics = measurer.measureRun('sans-serif', 48, [...'Hi'].map((c) => c.codePointAt(0)!), true);
  console.log(metrics.map((m) => m.advance.toFixed(1)), 'px advances');
  if (metrics.length !== 2 || metrics.some((m) => m.advance <= 0)) throw new Error('the run was not measured');
  measurer.reset?.(); // forget cached measurements once fonts have loaded
}
