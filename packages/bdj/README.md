# @seikou/bdj

BD-J for `@seikou/engine`. BD-J is the Java side of Blu-ray: a disc's menus and titles can be Java programs (Xlets) instead of HDMV movie objects. This package runs them in the browser, in a Java virtual machine written in TypeScript that boots libbluray's Java stack (the class library, `@seikou/bdj-classlib`), and gives the engine the glue that lets that Java drive the player. The engine never imports it: an engine worker entry passes `seikouBdjProvider(options)` to `startEngineWorker` as the `BdjProvider` the engine defines (`@seikou/engine/bdj-provider`).

The reference, with an example for every function, is at [/developers/bdj](https://bluray.pages.dev/developers/bdj).

## Concepts

The JVM runs in its own BD-J worker, which the engine worker starts once per BD-J entry. Java's calls into the player cross to the engine worker as messages, where `BdjSession` (`session.ts`) routes them to `PlayerBdjHost` (`player-host.ts`), which drives the `Player`. Three `SharedArrayBuffer`s let Java read what it must read synchronously, as libbluray's natives do: the register file (`shared-registers.ts`; the engine owns it and Java's writes go back as messages), a status block with the playback time and the UO mask (`status-block.ts`), and the 1920×1080 ARGB graphics plane (`graphics-plane.ts`).

`runtime.ts` (`BdjRuntime`) follows libbluray's `bdj.c`, and the natives under `jvm/natives/` follow libbluray's JNI code, so the Java stack sees what it sees in libbluray. `tests/bdj/` compares our control calls and settled plane hashes with traces from patched libbluray; a difference is a bug in the port. The JVM itself is original: never copy HotSpot, GNU Classpath or JamVM code into it.

Java threads are green threads, all scheduled on the BD-J worker's one JavaScript thread (`jvm/threads.ts`). A thread that enters a held monitor, waits, sleeps, parks or waits on a native's promise (a disc read, a font load) gives way to the others. The one `Atomics.wait` is the BD-J worker's wait for the graphics plane's lock (`graphics-plane.ts`), which is why BD-J needs it in workers (`atomicsWait` in `requirements.ts`).

A BD-J title that has neither selected a playlist nor shown anything (a visible plane or a background still) within 20 s of active time from boot counts as hung, and the player falls back to the title picker. The clock runs only while the page is visible and the host awake, and not while the BD-J worker waits on its own reads, for at most 120 s per boot. At the timeout the session logs a dump of every Java thread. A failed boot falls back at once.

Java's `updateGraphicN` and libbluray's ARGB overlay write the graphics plane under its lock; the engine worker only try-locks it and draws it over the video at the next presented frame after a flush. Background stills are decoded by the browser and drawn under the video, since Java never sees their pixels (`background.ts`). Text goes through FreeType compiled to WASM (`fonts/`), fetched on the first font use. Keys, clicks, taps and pointer moves reach Java as libbluray's `bd_user_input` and `bd_mouse_select` send them (`input.ts`).

What a disc writes under `/persistent/` and `/buda/` is kept between viewings (`store/`). `scopes.ts` works out the scopes from the BDJOs and `id.bdmv` as libbluray does, and `ScopeSync` loads them into the JVM's file system before Java starts and saves a scope whole after its last write. A local folder's scopes live in IndexedDB (`IdbBdjStore`); a disc from the NAS keeps them in that person's store on the NAS (`NasBdjStore`) behind a write-ahead copy in IndexedDB, so a save survives the page closing or the NAS being unreachable. A scope holds at most 16 MB.

## API

The package root exports the names listed in `public-api.txt`; every module can also be imported by path (`@seikou/bdj/<module>`), and what the root leaves out is internal and can change without notice.

`seikouBdjProvider(options)` (`provider.ts`) returns the `BdjProvider` the engine takes as `PlayerDeps.bdj`. Its options are what the host supplies: the class library loader (`loadClassLibrary`, which fetches the jars at `CLASS_LIBRARY_URLS` from `@seikou/bdj-classlib`), what the browser lacks for BD-J (`missing`, from `bdjMissing`), an image decoder for background stills, and optionally how to start the BD-J worker. Everything the provider returns (session, host, plane reader, status block writer, input helpers) runs in the engine worker. Seikou's engine worker entry, `src/engine-worker.ts`, passes it to `startEngineWorker`; the integration guide, [`docs/integrating.md`](../../docs/integrating.md), shows the same for another page.

The BD-J worker's entry is `bdj-worker-entry.ts`, which the provider starts with `new Worker(new URL(...))`. It runs `runBdjWorker` (`bdj-worker.ts`) with the class library's intrinsics (`@seikou/bdj-classlib/intrinsics`) and fetches FreeType (`wasm/freetype/freetype.wasm`) and the fallback font (`@seikou/ass/default-font.ttf`) through Vite `?url` imports the first time a menu draws text. `worker-protocol.ts` defines the messages between the two workers. Without a provider, or when `missing` is not empty, a BD-J disc opens to the playlist picker with the `bdj` notice.

## What a consumer must provide

- Vite, as for `@seikou/engine`: the BD-J worker and its wasm and font come in through `new Worker(new URL(...))` and `?url` imports.
- Cross-origin isolation, a browser that can start a worker from a worker, `Atomics.wait` in workers, WebAssembly and `OffscreenCanvas` (`bdjMissing` names what is missing).
- The class library, `@seikou/bdj-classlib`, which is under its own licences (GPLv2 with the Classpath Exception and others; see its `NOTICE`).

## Usage

```ts
import { bdjMissing, seikouBdjProvider } from '@seikou/bdj';
import { CLASS_LIBRARY_URLS } from '@seikou/bdj-classlib';

const bytes = async (url: string) => new Uint8Array(await (await fetch(url)).arrayBuffer());
const bdj = seikouBdjProvider({
  missing: bdjMissing(self as unknown as Record<string, unknown>, { inWorker: true }),
  loadClassLibrary: async () => ({
    rt: await bytes(CLASS_LIBRARY_URLS.rt),
    libbluray: await bytes(CLASS_LIBRARY_URLS.libbluray),
    libblurayAwt: await bytes(CLASS_LIBRARY_URLS.libblurayAwt),
  }),
  decodeImage: (b) => createImageBitmap(new Blob([new Uint8Array(b)])),
});
// in the engine worker's entry: startEngineWorker({ ..., bdj }) from @seikou/engine/worker-main
```

## Where to look

- `jvm/`: the JVM. `classfile.ts` (class files), `zip.ts` (jars), `loader.ts`, `heap.ts`, `values.ts`, `interpreter.ts`, `threads.ts`, `vfs.ts` (the file system Java sees) and `jvm.ts`, which ties them together. `jvm/natives/` holds the native methods by package (`lang.ts`, `io.ts`, `awt.ts`, `havi.ts`, `fonts.ts`, `libbluray.ts` and others).
- The BD-J worker: `bdj-worker.ts`, `runtime.ts`, `worker-host.ts` (what Java's libbluray natives call), `disc-info.ts` (libbluray's title list), `errors.ts`.
- The engine worker's side: `session.ts`, `player-host.ts`, `events.ts` (the PSR events Java hears), `early-worker.ts` (a worker started before its session), `input.ts`, `background.ts`.
- Shared memory: `shared-registers.ts`, `status-block.ts`, `graphics-plane.ts`.
- Text: `fonts/freetype.ts` (the WASM module in `wasm/freetype/`, rebuilt only with `npm run wasm:build:freetype` at the repository root) and `fonts/system-fonts.ts` (the JRE's logical fonts resolve to the bundled default font).
- Saved data: `store/scopes.ts`, `store/scope-sync.ts`, `store/idb-store.ts`, `store/nas-store.ts`, `store/tar.ts`.
- Tests and traces: `tests/bdj/` (conformance against HotSpot, control-call traces, key scripts) and `tools/bdj-trace/`.

## Documentation

These are in the Seikou repository.

- Specs: [`2026-10-15-m5b-bdj-jvm-core-design.md`](../../docs/superpowers/specs/2026-10-15-m5b-bdj-jvm-core-design.md) (the JVM), [`2026-10-16-m5c-bdj-playback-design.md`](../../docs/superpowers/specs/2026-10-16-m5c-bdj-playback-design.md) (playback), [`2026-10-17-m5d-bdj-menus-design.md`](../../docs/superpowers/specs/2026-10-17-m5d-bdj-menus-design.md) (menus, fonts, input) and [`2026-10-18-m5e-bdj-library-coverage-design.md`](../../docs/superpowers/specs/2026-10-18-m5e-bdj-library-coverage-design.md) (library coverage and saved data).
- `NOTICE` lists the files derived from libbluray and the DoppioJVM, fdlibm and FreeType attributions; the class library's licences are in `@seikou/bdj-classlib`'s `NOTICE`.
- [libbluray](https://www.videolan.org/developers/libbluray.html), whose `bdj.c` and Java stack this runs.
