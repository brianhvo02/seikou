// Steady-state speed of one long loop, interpreted and compiled: npx tsx tests/bdj/bench-loop.ts [n]
import { readFileSync } from 'node:fs';
import { Jvm, type JitMode } from '@seikou/bdj/jvm/jvm';
import { assembleClass } from '../helpers/jvm-asm';
const file = (rel: string): Uint8Array => readFileSync(new URL(rel, import.meta.url));
const BOOT = [file('../../packages/bdj-classlib/rt-bdj.jar')];
const n = Number(process.argv[2] ?? 2_000_000);
// static int loop(int n) { int s = 0; for (int i = 0; i < n; i++) s += i ^ (s >>> 3); return s; }
const code = [0x03, 0x3c, 0x03, 0x3d, 0x1c, 0x1a, 0xa2, 0, 17, 0x1b, 0x1c, 0x1b, 0x06, 0x7c, 0x82, 0x60, 0x3c, 0x84, 2, 1, 0xa7, 0xff, 0xf0, 0x1b, 0xac];
for (const mode of ['off', 'force', 'off', 'force', 'off', 'force'] as JitMode[]) {
  const jvm = new Jvm({ bootJars: BOOT, nowMs: () => 0, setTimer: (ms, fn) => { const id = setTimeout(fn, ms); return () => clearTimeout(id); }, stdout: () => {}, stderr: () => {}, jit: mode });
  jvm.loader.define('Loop', assembleClass('Loop', [{ name: 'loop', desc: '(I)I', code, maxStack: 4, maxLocals: 3 }]), null, null);
  const t0 = performance.now();
  const v = await jvm.callStatic('Loop', 'loop', '(I)I', [n]);
  const ms = performance.now() - t0;
  console.log(mode, v, ms.toFixed(0), 'ms', ((ms * 1e6) / (n * 13)).toFixed(2), 'ns/bytecode');
}
