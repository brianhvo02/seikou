// Prints the JavaScript the JIT makes for a method of the class library (or, with no arguments, for a small assembled
// loop): npx tsx tests/bdj/jit-source.ts [<class> <name+desc>], e.g. java/util/HashMap 'getNode(ILjava/lang/Object;)Ljava/util/HashMap$Node;'.
import { readFileSync } from 'node:fs';
import { Jvm } from '@seikou/bdj/jvm/jvm';
import { assembleClass } from '../helpers/jvm-asm';
const file = (rel: string): Uint8Array => readFileSync(new URL(rel, import.meta.url));
const jvm = new Jvm({ bootJars: [file('../../packages/bdj-classlib/rt-bdj.jar')], nowMs: () => 0, setTimer: () => () => {}, stdout: () => {}, stderr: () => {} });
const code = [0x03, 0x3c, 0x03, 0x3d, 0x1c, 0x1a, 0xa2, 0, 17, 0x1b, 0x1c, 0x1b, 0x06, 0x7c, 0x82, 0x60, 0x3c, 0x84, 2, 1, 0xa7, 0xff, 0xf0, 0x1b, 0xac];
jvm.loader.define('Loop', assembleClass('Loop', [{ name: 'loop', desc: '(I)I', code, maxStack: 4, maxLocals: 3 }]), null, null);
const [cn, md] = process.argv.slice(2);
const cls = cn ? jvm.loader.loadBoot(cn)! : jvm.loader.loadBoot('Loop')!;
const m = cls.methods.get(md ?? 'loop(I)I')!;
const F = globalThis.Function;
(globalThis as { Function: unknown }).Function = function (...args: string[]) {
  console.log(args[args.length - 1]);
  return F(...args);
};
const { compileMethod } = await import('@seikou/bdj/jvm/jit');
compileMethod(m, {} as never);
