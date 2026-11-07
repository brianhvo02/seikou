import { describe, expect, it } from 'vitest';
import { MEMORY_PROFILES } from './memory-profile';

describe('MEMORY_PROFILES', () => {
  it('constrained halves the frame queue for 4K streams only', () => {
    expect(MEMORY_PROFILES.constrained.maxQueuedFrames(3840)).toBe(4);
    expect(MEMORY_PROFILES.constrained.maxQueuedFrames(1920)).toBe(8);
  });

  it('desktop keeps the original limits', () => {
    const d = MEMORY_PROFILES.desktop;
    expect(d.maxQueuedFrames(3840)).toBe(8);
    expect([d.igPreloadLimitBytes, d.assEventCacheBytes, d.assLayerCacheBytes, d.assMaskCacheBytes, d.maxTextSupersampling]).toEqual([512 * 2 ** 20, 128 * 2 ** 20, 128 * 2 ** 20, 64 * 2 ** 20, 8]);
  });

  it("gives the BD-J worker's NAS reads their own small read-ahead (ruling R20)", () => {
    expect(MEMORY_PROFILES.desktop.bdjRemoteReadAheadBytes).toBe(16 * 2 ** 20);
    expect(MEMORY_PROFILES.constrained.bdjRemoteReadAheadBytes).toBe(8 * 2 ** 20);
    for (const p of Object.values(MEMORY_PROFILES)) expect(p.bdjRemoteReadAheadBytes).toBeLessThan(p.remoteReadAheadBytes);
  });
});
