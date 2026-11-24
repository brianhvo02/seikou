# BD-J JIT: a bytecode-to-JavaScript compiler for hot methods — Design Spec

Date: 2026-11-24
Status: First slice implemented on branch `bdj-jit`, off by default in the player (§8, §9: correct, but no faster at
start-up where it could be measured).
Builds on: `2026-10-16-m5c-bdj-playback-design.md` §4.7 (stage 2), `2026-10-15-m5b-bdj-jvm-core-design.md` (the JVM).

## 1. Why

Stage 1 of 5c §4.7 (intrinsics, fast paths, start-up overlap) brought BDJ_DISC_A's warm first frame to about 4.8 s in
desktop Chrome against a 5 s bar, with tens of milliseconds of margin; the iPhone 17 Pro misses its 10 s cold target by
0.8 s and the iPad by up to 1.6 s (`docs/known-issues.md`, 5d start-up and the device gate). About 4.0 s of
BDJ_DISC_A's time is the disc's own animation and a `Thread.sleep(3000)`; the rest is Java run by the interpreter, a
larger share on the phone. Spec §4.7 names stage 2, a JIT, as the lever; `docs/roadmap.md` lists it under "Later".

A bytecode profile of BDJ_DISC_A's start-up to its first `selectPlaylistN` (in Node, `tests/bdj/bench-profile.ts`)
runs 39.6 M bytecodes in 7,497 methods; the 409 methods called 1,000 times or more hold 88% of them, the 121 called
5,000 times or more 68%, and some of the hottest loops are in methods called once or a few times (the disc's own
string decoders, `PNGImageDecoder.produceImage`). 18% of the bytecodes run in methods with exception handlers and 4%
in synchronized methods. In a V8 CPU profile of one cold start-up the interpreter's own loop is the largest single
cost of the BD-J worker.

## 2. Goals and non-goals

Goals:

- Compile hot Java methods to JavaScript in the BD-J worker so the same Java runs in fewer machine instructions.
- Change nothing Java can see, and nothing the scheduler can see: a run with the JIT makes the same calls, in the same
  order, with the same thread interleaving, as a run without it. The goldens (control-call traces, settled plane
  hashes, the local-disc goldens) stay byte for byte.
- Fall back cleanly: a method the compiler doesn't handle runs in the interpreter; where code generation is
  unavailable (a Content Security Policy without `unsafe-eval`) the JVM runs interpreted only.
- The conformance suite runs with the JIT forced on for every method as well as normally (spec §4.7).
- Measure start-up before and after.

Non-goals (this slice):

- Register allocation of the operand stack and locals into JS variables, inlining across methods, type speculation
  with deoptimisation. They are the next levers (§9).
- The compact constant-pool form (the matching memory lever in the roadmap row).
- Any change to intrinsics, natives or the class library.

## 3. Approaches considered

1. **A method-at-a-time compiler to recursive JS functions** (Java call = JS call, as in DoppioJVM's or CheerpJ's
   designs). Fastest code, but a green thread could no longer park mid-stack: every compiled call would need to save
   and rebuild frames on `Suspend`, `Invoke` continuations, monitor blocking and preemption, and stack traces,
   `StackOverflowError` depth and `getCallerClass` would need a second source of truth. Large, and every one of those
   is a way to diverge from the goldens.
2. **A frame-preserving block compiler (chosen).** A compiled method is a JS function that runs one frame of that
   method, exactly as the interpreter's inner loop would, on the same `Frame` object (its `locals`, `stack`, `pc`,
   `sp`). Calls, returns, exceptions, monitors, class initialisation and native continuations go through the
   interpreter's own functions (`call`, `ret`, `throwInto`, `ensureInit`, `complete`), so frames are still pushed
   on the thread and nothing recurses in JS. What is compiled away is the dispatch and decoding: the opcode switch,
   operand fetches, `sp` arithmetic (the stack depth at each instruction is a compile-time constant, JVMS §4.10),
   constant-pool lookups that are already resolved, and the hop back to the outer loop after a call that completed
   in place (a trivial getter, an intrinsic, a native that returned). The interpreter and a compiled method can hand
   a frame to each other at any instruction, because the frame is the whole state.
3. **More interpreter fast paths** (superinstructions, a threaded interpreter). Smaller gains; stage 1 already took the
   obvious ones.

*(My call: approach 2 — it keeps the JVM's semantics by construction, which is what the goldens and the green
threads need, and it is a night's work with room to grow into approach 1's speed later by caching stack slots in JS
variables within a block.)*

## 4. Design

### 4.1 Where it sits

- `packages/bdj/src/jvm/jit.ts` (new): `compileMethod(m, rt)` returns a `CompiledMethod` or null (not compilable).
  It does a stack-depth dataflow over the bytecode, splits it into blocks, and generates one JS function per method
  with `new Function`. It imports nothing from the interpreter; the interpreter hands it a runtime object
  (`JitRuntime`: the resolution helpers, `call`, `ret`, `ensureInit`, `throwInto`, `checkIndex`, the conversions,
  `PendingThrow`, `LoadPending`, the exit register).
- `interpreter.ts`: the outer loop of `run` dispatches a frame to its method's compiled function when there is one;
  the catch of the inner loop becomes a shared function (`caught`) used by both; a taken backward branch counts
  towards the method's heat.
- `JMethod` gains `jit` (undefined: not decided; null: interpreted only; else the compiled function) and `heat`.
- `JvmOptions.jit`: `'off' | 'on' | 'force'` (default `'off'`, §8). `'force'` compiles every method the first time a frame
  of it runs, for the tests. `Jvm.jitStats()` counts methods compiled, refused (with reasons) and failed.

### 4.2 Heat and when to compile

A method's heat is the number of backward branches it has taken while interpreted. At `JIT_THRESHOLD` (§8 gives the
value and why) the method is compiled the next time the outer loop meets one of its frames, which also gives on-stack
replacement for free: a long loop in a method entered once hops to the outer loop at a backward branch once hot, and
continues compiled at the loop head. A method is compiled once; one that can't be compiled is marked and never tried
again. *(My call: loops only. The first version also counted every entry and return; measured, it compiled hundreds of
small methods hot only by being called, whose compile and warm-up cost more than they saved, §8.)*

### 4.3 The compiled function

`(jvm, thread, frame, budget) => budget`, with the exit kind left in the runtime's `exit` register: continue the outer
loop, interpret this frame from `frame.pc`, or end the slice (`'budget'`, after a `monitorexit` that handed the
monitor to another thread, as the interpreter does). Its body is `for (;;) switch (pc) { case <block>: … }` over the
method's blocks. A block starts at pc 0, at every branch target and handler, after every branch, return, throw, call
and loop hook, and at every instruction that can leave the frame and come back to run again (an unresolved constant,
a class that may need initialising, `monitorenter`, an invoke). The default case hands the frame to the interpreter.

**Budget, exactly.** The interpreter counts one unit of the slice per instruction and stops before the instruction
that would go below zero. A block of N instructions first checks `budget < N`: if so, it hands the frame to the
interpreter at the block's start, which runs the remaining instructions one by one and stops exactly where it would
have stopped alone; otherwise it charges N. Any exit from the middle of a block refunds the instructions after the
exiting one, and an exception refunds by a per-pc table. So a thread's slices end on the same instruction with the JIT
as without, and the scheduler interleaves threads identically.

**State.** The locals and the operand stack's slots live in JS variables (`l<n>`, `s<i>`) while the compiled code runs.
A local is written through to the frame as it is stored; the operand stack is spilled to the frame before anything
else can see it (a call, a throw, class initialisation, a blocked monitor, an exit) and read back after. Within a block
a slot is held as a pending JS expression while it is pure (loads, constants, arithmetic that cannot throw,
conversions, comparisons), so a run of loads and arithmetic becomes one statement; a store to a local first gives the
pending expressions that read it their value. `frame.sp` is written only where something reads it, `frame.pc` before
every instruction that the interpreter writes it for when what follows can observe it, and a local `pc` tracks the
instruction that may throw, so the catch spills the stack and sets `frame.pc` and `frame.sp` (from the per-pc depth
table) exactly as the interpreter's catch does, then runs the same code (`caught`).

**After a call.** The interpreter returns to its outer loop after every invoke; the outer loop re-checks the thread
(state, preemption) and picks the top frame. A compiled method does the same checks (`R.after`): when the frame is
still on top, the thread runnable and not preempted, it continues at the frame's `pc` inside the same function; when
the call pushed a frame of a compiled method right above it, that method runs nested, on the JS stack, as the outer
loop would have run it next, at most 48 deep (`JIT_MAX_NESTING`); its return comes back the same way. Either is
what the outer loop would have done. The invokes themselves are shared runtime functions mirroring the interpreter's
(`invokeVirtual`, `invokeInterface`, `invokeStatic`, `invokeSpecial`), so each call site stays short.

**Constants.** A constant-pool reference already resolved when the method is compiled is folded in (field slots, a
method, a class), since resolution is a cache lookup with no effects once resolved. An unresolved one calls the same
resolution function as the interpreter at run time. A class not yet initialised at compile time keeps the
interpreter's check.

**Not compiled** (null): `jsr`/`ret` (and `wide ret`), a stack-depth conflict or an unknown opcode, bytecode longer
than 16 KiB *(My call: a generated function that large is slow to parse and such methods are run once, as class
initialisers)*, more than 400 locals and stack slots together (each is a JS variable). Everything else is compiled: exception handlers and `synchronized` work unchanged because they live in
the interpreter's `throwInto` and `ret` and the frame's `lock`.

### 4.4 Code generation and the Content Security Policy

Compiled code is made with `new Function` in the BD-J worker. The site sends no Content Security Policy
(`public/_headers` has COOP and COEP only; the service worker re-adds those two), the BD-J worker's script inherits
none, and the NAS server's `Content-Security-Policy: sandbox` is on its API answers, not on the app. Safari, Chrome and
Firefox allow `new Function` in a worker without a CSP. The JVM still probes once, at construction: if
`new Function` throws, the JIT is off for that JVM and one line is logged through `warn`. A self-hoster who adds a CSP
without `'unsafe-eval'` gets the interpreter. *(My call: probe rather than assume — a page embedding the packages may
send a CSP.)*

### 4.5 Test flags

`?jit=1` (test-only, like `?bdjfail=1`) runs the BD-J worker with the JIT on, and `?jitthreshold=<n>` with the JIT on
at that heat, so the same build can be measured both ways. They reach the BD-J worker through the worker's name, as
the engine worker's flags do. Telemetry's `bdjMemory.jvm.jitCompiled` and `jitCompileMs` say what it compiled.

## 5. Constraints

- No Java-visible change: the conformance suite (HotSpot's output), the BD-J trace and key-script goldens and the
  local-disc goldens are the oracles; none is regenerated by this work.
- The engine package is untouched; everything is in `@seikou/bdj` (original code, LGPL-3.0-or-later).
- Strict TypeScript; the generated code is plain ES2020 (BigInt literals for `long` constants).

## 6. Errors

A compile that throws (a bug in the generator, a `SyntaxError` from `new Function`) marks the method interpreted-only,
counts it in `jitStats().failed` and logs one line; the forced conformance run fails if any method failed. A JS error
inside compiled code is a JVM fault, as in the interpreter.

## 7. Testing

- `packages/bdj/src/jvm/jit.test.ts`: the stack-depth dataflow and the blocks; compiled code against the interpreter
  on assembled methods (a loop, an exception caught in its own frame and in its caller); the pc an exception's stack
  trace records; budget equivalence (24 slice lengths, each followed by a second slice: the frame's pc, sp, locals and
  stack the same with and without the JIT); refusal of `jsr`; the CSP fallback with `new Function` throwing.
- The conformance suite, all of it, a second time with `jit: 'force'`, asserting no compile failed.
- The BD-J trace comparison, replay and key-script tests unchanged (the replays run the JIT on; `BDJ_JIT=force` by hand); `tests/local/bdj-menus.test.ts`
  and `tests/local/bdj-boot.test.ts` with the local discs, also with the JIT forced.
- Start-up measured with the local discs in Node (`tests/bdj/bench-startup.ts`: CPU time and first `selectPlaylistN`
  of the in-process replay) and in headless Chromium (`bdj.bootMs`, `firstPlaylistMs`, `firstFrameMs`, cold and warm)
  and headless WebKit, with `?jit=1` against the interpreter in the same build.

## 8. Measurements

All on the developer's Mac with BDJ_DISC_A unless named. Another session loaded the Mac heavily until about 02:25
(load average 20-42); every number below was taken after that, at a load average of 2-5. Numbers taken earlier, under
load, are in the night report only and agree in direction.

- **Browser, production build, 6 runs per arm** (`tests/bdj/bench-browser.ts`), `bdj.firstFrameMs` medians, cold /
  warm. main (d053a913) / this branch with the JIT off (the default) / this branch with `?jit=1`:
  - Chrome: 4,845 / 4,824, then 4,842 / 4,821 and 4,843 / 4,821 in two more rounds (main); 4,844 / 4,821 and
    4,842 / 4,826 (JIT off); 4,892 / 4,870 (JIT on). Each arm's runs lie within about 50 ms.
  - WebKit (JavaScriptCore, the iPhone's engine): 5,003 / 5,863 (main); 4,977 / 4,937 (JIT off); 5,065 / 5,997
    (JIT on). Warm opens in WebKit fall either near 4.9 s or near 5.9 s in every arm, so its warm medians mean little.
  - Firefox: 5,225 / 5,189 (main); 5,233 / 5,218 (JIT off); 5,234 / 5,207 (JIT on).
  - BDJ_DISC_B in Chrome: 773 / 756 and 763 / 753 (main) against 788 / 752 and 794 / 765 (JIT off).
  The JIT runs (telemetry: 87 methods compiled in about 20 ms at heat 1,000, 211 in about 40 ms at heat 100) and is
  no faster: 30-90 ms slower in Chrome and WebKit, even in Firefox.
- **Node, the in-process replay to the first `selectPlaylistN`** (`tests/bdj/bench-startup.ts`, 5 runs per arm, the
  time Java ran, `threads.runMs`), cold (first JVM in the process) / warm (second): JIT off 1,098 / 831 ms; heat 1,000:
  1,110 / 861; heat 20,000: 1,160 / 821. Compiling itself costs little (about 30 ms); what the JIT loses is the compiled
  functions' own warm-up in the JS engine, which runs new code in its own interpreter until it is hot, while the BD-J
  interpreter's one big loop is already optimised; and the start-up's 40 M bytecodes are spread over 7,500 methods.
- **Steady state** (`tests/bdj/bench-loop.ts`, a 13-bytecode integer loop; `fib(20)` from the conformance classes):
  the loop runs about 2.7x faster compiled (about 1 ns per bytecode against 2.9), and call-heavy `fib` about 1.6x
  (54 against 90 ms) once compiled methods call compiled methods nested.
- **JavaScriptCore's shell** (`jsc`, the JDK boot and five conformance programs 20 times, bundled with esbuild; under
  load): interpreter 217-310 ms, JIT 225-346 ms: no gain there either.
- **An interpreter change that was undone:** moving the interpreter's frame loop into a function of its own (so V8
  would not keep leaving an on-stack-replaced loop) made Firefox's BDJ_DISC_B start-up about 110 ms slower than main
  (1,110 against 1,000 ms, measured twice); with the loop back inside `run()` the branch matches main in every browser.
- A bytecode profile of the start-up (`tests/bdj/bench-profile.ts`): 39.6 M bytecodes in 7,497 methods; the hottest
  are the JDK's jar and manifest reading (`Inflater`, `Attributes.read`, `ManifestDigester`, `HashMap`), the disc's
  own string decoding and `BDGraphicsBase.drawImageN`.

*(My call: the JIT ships off in the player — `JvmOptions.jit` defaults to `off` and `?jit=1` turns it on. It is correct
by every oracle we have, but it measured no faster at start-up in Chrome, WebKit, Firefox, Node or JavaScriptCore's shell,
so turning it on would add a code path to every BD-J boot for no measured gain. The replays and the conformance suite
run it, so it stays tested, and a device can be measured with `?jit=1` against the default.)*

## 9. Status

Done (branch `bdj-jit`): the compiler (`packages/bdj/src/jvm/jit.ts`) with locals and stack in JS variables, pure
expressions folded within a block, shared invoke steps, compiled-to-compiled calls nested on the JS stack, exact
budget equivalence, exception and handler semantics through the interpreter's own functions; the heat counter on
backward branches with on-stack entry at a loop head; the CSP probe and fallback; `JvmOptions.jit` and
`jitThreshold`, `Jvm.jitStats()`, `bdjMemory.jvm.jitCompiled`; `?jit=1` and `?jitthreshold=<n>`; the conformance suite
forced (16,506 methods compiled, none refused or failed); the trace, key-script and local-disc goldens unchanged with
the JIT on and forced.

Not done, and what would come next if the owner wants the lever after all:

- A device measurement: the iPhone 17 Pro and the iPad with `?telemetry=1` against `?telemetry=1&jit=1` (the device
  was in use by another lane tonight). On the Mac, WebKit gained nothing, so the iPhone is unlikely to.
- The cost the JIT can't remove: a new BD-J worker starts every JS function cold, and the start-up's bytecodes are
  spread thin. Levers that fit that better: intrinsics for the JDK's jar-manifest path (stage 1's kind of work, about
  a third of the interpreted time per the 5d notes), or caching the boot's state across BD-J entries.
- Speculative typing (ints unboxed), inlining of small callees, and the compact constant-pool form named in the
  roadmap row (the memory lever) were not started.
