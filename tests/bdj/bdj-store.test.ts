import { describe, expect, it } from 'vitest';
import { MemoryBdjStore } from '../../src/bdj/store/bdj-store';
import { replaySettled } from './settled';

const DISC = new URL('../../fixtures/synthetic/disc-bdj-store', import.meta.url);
const SCRIPT = new URL('./scripts/disc-bdj-store.open.keys', import.meta.url);

/** The file's text in a scope of the store, null when the scope or file is missing. */
async function stored(store: MemoryBdjStore, scope: string, path: string): Promise<string | null> {
  const f = (await store.load(scope)).files.find((x) => x.path === path);
  return f ? new TextDecoder().decode(f.bytes) : null;
}

/** Waits for the stop flush of the last run (the closed player's BD-J worker saves after the close returns). */
async function savedCount(store: MemoryBdjStore, want: string): Promise<void> {
  const end = Date.now() + 10_000;
  while ((await stored(store, 'persistent/7fff0002', '4001/count')) !== want) {
    if (Date.now() > end) throw new Error(`the store never held count ${want}`);
    await new Promise((r) => setTimeout(r, 20));
  }
}

describe('saved data across openings against libbluray (disc-bdj-store)', () => {
  it('three openings on one store draw counts 0, 1 and 2 as libbluray does on one storage', async () => {
    // StoreXlet reads /persistent/<org>/<app>/count and the lines of /buda/<org>/x.log, draws both, and saves one more
    // of each; golden.sh ran libbluray three times on one storage volume
    const store = new MemoryBdjStore();
    const hashes: string[] = [];
    for (const n of [1, 2, 3]) {
      const { golden } = await replaySettled(DISC, new URL(`./golden/disc-bdj-store.open.${n}.jsonl`, import.meta.url), SCRIPT, { store });
      hashes.push(golden.endHash!);
      await savedCount(store, String(n));
    }
    expect(new Set(hashes).size).toBe(3);
    // the org-level loose BUDA file (ruling R14) lasted too, in its own scope
    expect(await stored(store, 'buda/7fff0002', 'x.log')).toBe('opened\n'.repeat(3));
  }, 540_000);
});
