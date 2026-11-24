// Counts bytecodes and calls per Java method over a BD-J disc's start-up (the interpreter's profile; the JIT is off
// while it counts): npx tsx tests/bdj/bench-profile.ts <disc dir>.
import { replayPlayerBdj } from './replay-player';
import { setBytecodeProfile, type BytecodeProfile } from '@seikou/bdj/jvm/interpreter';
const disc = process.argv[2] ?? 'fixtures/local/BDJ_DISC_A';
const p: BytecodeProfile = { bytecodes: new Map(), calls: new Map() };
setBytecodeProfile(p);
await replayPlayerBdj(disc, { until: 'selectPlaylistN', occurrence: 1, timeoutMs: 240_000 });
setBytecodeProfile(null);
const rows = [...p.bytecodes].map(([m, n]) => ({ k: `${m.cls.name}.${m.name}${m.desc}`, n, c: p.calls.get(m) ?? 0, len: m.code?.code.length ?? 0, h: m.code?.handlers.length ?? 0, sync: m.isSynchronized }));
rows.sort((a, b) => b.n - a.n);
const total = rows.reduce((s, r) => s + r.n, 0);
console.log('total bytecodes', total, 'methods', rows.length);
let acc = 0;
for (const [i, r] of rows.entries()) { acc += r.n; if (i < 40) console.log(r.n, (100 * acc / total).toFixed(1) + '%', r.c, r.len, r.h, r.sync, r.k); }
for (const th of [100, 500, 1000, 5000]) {
  const hot = rows.filter((r) => r.c >= th || r.n >= th * 20);
  console.log('calls>=', th, 'methods', hot.length, 'share', (100 * hot.reduce((s, r) => s + r.n, 0) / total).toFixed(1));
}
const withH = rows.filter(r=>r.h>0).reduce((s,r)=>s+r.n,0);
console.log('share in methods with handlers', (100*withH/total).toFixed(1), 'sync', (100*rows.filter(r=>r.sync).reduce((s,r)=>s+r.n,0)/total).toFixed(1));
process.exit(0);
