// Times a BD-J disc's start-up in the in-process replay (tests/bdj/replay-player.ts) to Java's first selectPlaylistN:
// npx tsx tests/bdj/bench-startup.ts <disc dir> [runs]. Prints the process's CPU time, the time Java ran
// (threads.runMs) and what the JIT compiled; BDJ_JIT=off|on|force and BDJ_JIT_THRESHOLD=<n> set the JIT.
import { Scheduler } from '@seikou/bdj/jvm/threads';
import { replayPlayerBdj } from './replay-player';

Scheduler.timeRuns = true;
const disc = process.argv[2] ?? 'fixtures/local/BDJ_DISC_A';
const runs = Number(process.argv[3] ?? 1);
for (let i = 0; i < runs; i++) {
  const t0 = performance.now();
  const c0 = process.cpuUsage();
  let stats = '';
  const r = await replayPlayerBdj(disc, { until: 'selectPlaylistN', occurrence: 1, timeoutMs: 240_000, beforeClose: (_p, w) => { const s = w?.runtime?.jvm.jitStats(); stats = s ? `java ${w!.runtime!.jvm.threads.runMs.toFixed(0)} ms jit ${s.mode} compiled ${s.compiled} in ${s.compileMs.toFixed(0)} ms refused ${JSON.stringify(s.refused)}` : ''; } });
  console.log(`run ${i}: firstPlaylistMs ${r.firstPlaylistMs.toFixed(0)} wall ${(performance.now() - t0).toFixed(0)} virtual ${r.virtualMs.toFixed(0)} cpu ${((process.cpuUsage(c0).user + process.cpuUsage(c0).system) / 1000).toFixed(0)} ${stats}`);
}
process.exit(0);
