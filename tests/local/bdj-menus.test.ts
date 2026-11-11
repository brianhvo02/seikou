import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import type { JvmMemoryStats } from '../../src/bdj/jvm/jvm';
import { MEMORY_PROFILES, type MemoryProfileName } from '@seikou/engine/memory-profile';
import { replaySettled } from '../bdj/settled';

/**
 * The developer's BD-J discs from their first menu to the feature, through the real Player, against libbluray's runs of
 * the same key scripts (tests/bdj/scripts/<disc>.<script>.keys; goldens in tests/bdj/golden/local/, written by
 * tools/bdj-trace/golden.sh when the disc is present, control calls and settled plane hashes only). Each disc's tests
 * skip when it is absent; no Docker is needed.
 *
 * Every run also checks the JVM's own memory accounting at the end against the constrained profile's BD-J budgets (5d
 * spec §4.5: the disc fits on a phone), and one script runs again under that profile, which must change nothing.
 */
const LOCAL = (name: string): string => fileURLToPath(new URL(`../../fixtures/local/${name}`, import.meta.url));
const golden = (name: string): URL => new URL(`../bdj/golden/local/${name}.jsonl`, import.meta.url);
const script = (name: string): URL => new URL(`../bdj/scripts/${name}.keys`, import.meta.url);

interface Case {
  readonly disc: string;
  readonly script: string;
  /** The feature playlist the script ends on. */
  readonly feature: number;
  readonly what: string;
  readonly profile: MemoryProfileName;
}

const CASES: readonly Case[] = [
  { disc: 'BDJ_DISC_A', script: 'bdj_disc_a.play', feature: 40, what: 'main menu, PLAY, the feature', profile: 'desktop' },
  { disc: 'BDJ_DISC_A', script: 'bdj_disc_a.chapters', feature: 40, what: 'main menu, CHAPTERS, chapter 2, the feature', profile: 'desktop' },
  { disc: 'BDJ_DISC_B', script: 'bdj_disc_b.play', feature: 800, what: 'language picker, English, main menu, PLAY, the feature', profile: 'desktop' },
  { disc: 'BDJ_DISC_A', script: 'bdj_disc_a.play', feature: 40, what: 'main menu, PLAY, the feature', profile: 'constrained' },
];

const budgets = MEMORY_PROFILES.constrained;
const mb = (n: number): string => (n / (1024 * 1024)).toFixed(2);

for (const c of CASES) {
  const dir = LOCAL(c.disc);
  describe.skipIf(!existsSync(dir) || !existsSync(golden(c.script)))(`${c.disc} against libbluray (${c.profile} memory profile)`, () => {
    it(`${c.what}: the same control calls and settled planes, within the phone's BD-J memory budgets`, async () => {
      let stats: JvmMemoryStats | null = null;
      // the first step counts from the open, as the harness's --wait-timeout 60 does from its start
      const { run, golden: g } = await replaySettled(dir, golden(c.script), script(c.script), {
        timeoutMs: 280_000,
        stepTimeoutMs: 90_000,
        memoryProfile: c.profile,
        beforeClose: (_player, worker) => {
          stats = worker?.runtime?.jvm.memoryStats() ?? null;
        },
      });
      const playlists = run.trace.filter((e) => e.call === 'selectPlaylistN' && e.args[0] !== -1).map((e) => e.args[0]);
      expect(playlists.at(-1)).toBe(c.feature);
      const settled = g.steps.flatMap((s) => (s.hash ? [s.hash] : []));
      console.log(`${c.script} (${c.profile}): settled ${settled.join(' ')}, end ${g.endHash}; ours ${run.flushes.length} flushes, ${run.untilMs.toFixed(0)} ms`);
      const s = stats as JvmMemoryStats | null;
      expect(s).not.toBeNull();
      console.log(
        `${c.script} (${c.profile}): ${s!.classes} classes keep ${mb(s!.classFileBytes)} MB, memory mounts ${mb(s!.vfsUsedBytes)} MB in ${s!.vfsFiles} files, ` +
          `${s!.zipHandles} zips open keeping ${mb(s!.zipBytes)} MB of their own`,
      );
      expect(s!.classFileBytes).toBeLessThanOrEqual(budgets.bdjClassCacheBytes);
      expect(s!.vfsUsedBytes).toBeLessThanOrEqual(budgets.bdjVfsCacheBytes);
      // ZipFile objects of one unchanged file share one archive, read from the Vfs's own copy where it has one
      expect(s!.zipBytes).toBe(0);
    }, 300_000);
  });
}
