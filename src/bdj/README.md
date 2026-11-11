# BD-J

BD-J is the Java side of Blu-ray: a disc's menus and titles can be Java programs (Xlets) instead of HDMV movie objects. This folder runs them in the browser. It holds a Java virtual machine written in TypeScript that boots libbluray's Java stack (the class library in [`../bdj-classlib/`](../bdj-classlib)), and the glue that lets that Java drive the player. It is app code: `@seikou/engine` never imports it and reaches it only through the provider interface it defines (`BdjProvider` in `packages/engine/src/bdj-provider.ts`).

## Concepts

The JVM runs in its own BD-J worker, which the engine worker starts once per BD-J entry. Java's calls into the player cross to the engine worker as messages, where `BdjSession` (`session.ts`) routes them to `PlayerBdjHost` (`player-host.ts`), which drives the `Player`. Three `SharedArrayBuffer`s let Java read what it must read synchronously, as libbluray's natives do: the register file (`shared-registers.ts`; the engine owns it and Java's writes go back as messages), a status block with the playback time and the UO mask (`status-block.ts`), and the 1920×1080 ARGB graphics plane (`graphics-plane.ts`).

`runtime.ts` (`BdjRuntime`) follows libbluray's `bdj.c`, and the natives under `jvm/natives/` follow libbluray's JNI code, so the Java stack sees what it sees in libbluray. `tests/bdj/` compares our control calls and settled plane hashes with traces from patched libbluray; a difference is a bug in the port. The JVM itself is original: never copy HotSpot, GNU Classpath or JamVM code into it.

Java threads are green threads, all scheduled on the BD-J worker's one JavaScript thread (`jvm/threads.ts`). A thread that enters a held monitor, waits, sleeps, parks or waits on a native's promise (a disc read, a font load) gives way to the others. The one `Atomics.wait` is the BD-J worker's wait for the graphics plane's lock (`graphics-plane.ts`), which is why BD-J needs it in workers (`atomicsWait` in `requirements.ts`).

A BD-J title that has neither selected a playlist nor shown anything (a visible plane or a background still) within 20 s of active time from boot counts as hung, and the player falls back to the title picker. The clock runs only while the page is visible and the host awake, and not while the BD-J worker waits on its own reads, for at most 120 s per boot. At the timeout the session logs a dump of every Java thread. A failed boot falls back at once.

Java's `updateGraphicN` and libbluray's ARGB overlay write the graphics plane under its lock; the engine worker only try-locks it and draws it over the video at the next presented frame after a flush. Background stills are decoded by the browser and drawn under the video, since Java never sees their pixels (`background.ts`). Text goes through FreeType compiled to WASM (`fonts/`), fetched on the first font use. Keys, clicks, taps and pointer moves reach Java as libbluray's `bd_user_input` and `bd_mouse_select` send them (`input.ts`).

What a disc writes under `/persistent/` and `/buda/` is kept between viewings (`store/`). `scopes.ts` works out the scopes from the BDJOs and `id.bdmv` as libbluray does, and `ScopeSync` loads them into the JVM's file system before Java starts and saves a scope whole after its last write. A local folder's scopes live in IndexedDB (`IdbBdjStore`); a disc from the NAS keeps them in that person's store on the NAS (`NasBdjStore`) behind a write-ahead copy in IndexedDB, so a save survives the page closing or the NAS being unreachable. A scope holds at most 16 MB.

## API

`provider.ts` exports `seikouBdjProvider(options)`, which returns the `BdjProvider` the engine takes as `PlayerDeps.bdj`. Its options are what the app supplies: the class library loader (`loadClassLibrary`), what the browser lacks for BD-J (`missing`, from `bdjMissing` in `requirements.ts`), an image decoder for background stills, and optionally how to start the BD-J worker. Everything the provider returns (session, host, plane reader, status block writer, input helpers) runs in the engine worker. The app's engine worker entry, `src/engine-worker.ts`, passes it to `startEngineWorker`; `docs/integrating.md` shows how another app can do the same.

The BD-J worker's entry is `bdj-worker-entry.ts`, which runs `runBdjWorker` (`bdj-worker.ts`) with the class library's intrinsics and the FreeType and default font fetchers. `worker-protocol.ts` defines the messages between the two workers. Without a provider, or when `missing` is not empty, a BD-J disc opens to the playlist picker with the `bdj` notice.

## Where to look

- `jvm/`: the JVM. `classfile.ts` (class files), `zip.ts` (jars), `loader.ts`, `heap.ts`, `values.ts`, `interpreter.ts`, `threads.ts`, `vfs.ts` (the file system Java sees) and `jvm.ts`, which ties them together. `jvm/natives/` holds the native methods by package (`lang.ts`, `io.ts`, `awt.ts`, `havi.ts`, `fonts.ts`, `libbluray.ts` and others).
- The BD-J worker: `bdj-worker.ts`, `runtime.ts`, `worker-host.ts` (what Java's libbluray natives call), `disc-info.ts` (libbluray's title list), `errors.ts`.
- The engine worker's side: `session.ts`, `player-host.ts`, `events.ts` (the PSR events Java hears), `early-worker.ts` (a worker started before its session), `input.ts`, `background.ts`.
- Shared memory: `shared-registers.ts`, `status-block.ts`, `graphics-plane.ts`.
- Text: `fonts/freetype.ts` (the WASM module in `src/wasm/freetype/`) and `fonts/system-fonts.ts` (the JRE's logical fonts resolve to the bundled default font).
- Saved data: `store/scopes.ts`, `store/scope-sync.ts`, `store/idb-store.ts`, `store/nas-store.ts`, `store/tar.ts`.
- Tests and traces: `tests/bdj/` (conformance against HotSpot, control-call traces, key scripts) and `tools/bdj-trace/`.

## Documentation

- Specs: [`2026-10-15-m5b-bdj-jvm-core-design.md`](../../docs/superpowers/specs/2026-10-15-m5b-bdj-jvm-core-design.md) (the JVM), [`2026-10-16-m5c-bdj-playback-design.md`](../../docs/superpowers/specs/2026-10-16-m5c-bdj-playback-design.md) (playback), [`2026-10-17-m5d-bdj-menus-design.md`](../../docs/superpowers/specs/2026-10-17-m5d-bdj-menus-design.md) (menus, fonts, input) and [`2026-10-18-m5e-bdj-library-coverage-design.md`](../../docs/superpowers/specs/2026-10-18-m5e-bdj-library-coverage-design.md) (library coverage and saved data).
- [`NOTICE`](NOTICE) lists the files derived from libbluray and the DoppioJVM and fdlibm attributions; the class library's licences are in [`../bdj-classlib/NOTICE`](../bdj-classlib/NOTICE).
- [libbluray](https://www.videolan.org/developers/libbluray.html), whose `bdj.c` and Java stack this runs.
