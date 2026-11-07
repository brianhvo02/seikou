// SPDX-License-Identifier: LGPL-2.1-or-later
import { expect, it } from 'vitest';

it('exposes the controller and worker factory', async () => {
  const mod = await import('@seikou/engine');
  expect(typeof mod.createController).toBe('function');
  expect(typeof mod.createEngineWorker).toBe('function');
});
