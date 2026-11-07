// SPDX-License-Identifier: LGPL-3.0-or-later
import { expect, it } from 'vitest';

// The import is cold: Vitest transforms the whole barrel (the engine and the packages it imports) inside this test,
// which can pass the default 5 s on a loaded machine while a full run fills every worker.
it('exposes the controller and worker factory', { timeout: 30_000 }, async () => {
  const mod = await import('@seikou/engine');
  expect(typeof mod.createController).toBe('function');
  expect(typeof mod.createEngineWorker).toBe('function');
});
