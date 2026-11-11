# Integrating Seikou

This guide is for someone who wants Seikou's player, or parts of it, in their own page or tool. It covers the packages, how to host a page that plays discs, a minimal player, discs from a server, subtitles, BD-J, the licences, and the parsers on their own.

Everything named here is exported by a package under `packages/` in the Seikou repository. Each export has a doc comment in the source, which is the reference for its units, failure behaviour and the thread it runs on.

## 1. The packages

Seikou's reusable code is eight npm workspace packages, imported as `@seikou/<name>`. They ship TypeScript sources with no build step.

| Package | What it holds | Use it for |
| --- | --- | --- |
| `@seikou/engine` | The player engine (its worker) and `PlayerController`, the page-side store that drives it. | A player. |
| `@seikou/bdmv` | Parsers for `index.bdmv`, playlists, clips, movie objects, BDJO, `sound.bdmv` and `id.bdmv`, the UDF reader for ISO images, the M2TS demuxer and the H.264 and HEVC parameter-set readers. | Reading a disc without playing it, in Node or a browser. |
| `@seikou/pg` | The PG subtitle decoder and renderer. | Drawing disc subtitles yourself. |
| `@seikou/ass` | The ASS renderer, ported from libass, with the DejaVu Sans fallback font. | Drawing ASS subtitles on a canvas. |
| `@seikou/matroska` | Matroska and WebM writing and reading. | Reading or writing MKV files. |
| `@seikou/nas` | The wire types shared by Seikou's NAS server, the app and the rendezvous Worker. | Talking to a Seikou server. |
| `@seikou/titles` | Library naming and metadata: folder names, AniList, TMDB, MusicBrainz, Discogs, TheDiscDB. | A server that files discs under titles. |
| `@seikou/fansubs` | Finding fansub releases and lining their subtitles up with a disc's audio. | A server or tool that fetches fansubs. |

A player needs `@seikou/engine`, which brings `@seikou/bdmv`, `@seikou/pg`, `@seikou/ass`, `@seikou/matroska` and `@seikou/nas` as its own dependencies. Parsing alone needs `@seikou/bdmv` (and `@seikou/matroska` for MKV). Subtitles alone need `@seikou/pg` or `@seikou/ass`. A server uses `@seikou/nas`, `@seikou/titles` and `@seikou/fansubs`, as Seikou's own `server/` does. BD-J is not a package; section 6 says how to take it from the app.

## 2. Hosting

### Cross-origin isolation

The engine moves audio from its worker to an AudioWorklet through a `SharedArrayBuffer`, and BD-J shares its registers and graphics plane the same way. A browser gives a page `SharedArrayBuffer` only when the page is cross-origin isolated, so every response of the page, its scripts and its workers must carry these two headers:

```
Cross-Origin-Opener-Policy: same-origin
Cross-Origin-Embedder-Policy: require-corp
```

With `require-corp`, everything the page loads from another origin must allow it (`Cross-Origin-Resource-Policy`, or CORS). A static host usually takes the headers from a file such as `_headers`; Seikou's is `public/_headers`. For Vite's dev and preview servers, set them on every response, 304 answers included, because WebKit refuses a worker whose revalidated script comes back without COEP. Seikou's `vite.config.ts` does it with a small plugin:

```ts
import { defineConfig, type Plugin } from 'vite';

const isolation = { 'Cross-Origin-Opener-Policy': 'same-origin', 'Cross-Origin-Embedder-Policy': 'require-corp' };
const isolateEveryResponse: Plugin = {
  name: 'isolate-every-response',
  configureServer(server) {
    server.middlewares.use((_req, res, next) => {
      for (const [name, value] of Object.entries(isolation)) res.setHeader(name, value);
      next();
    });
  },
  configurePreviewServer(server) {
    server.middlewares.use((_req, res, next) => {
      for (const [name, value] of Object.entries(isolation)) res.setHeader(name, value);
      next();
    });
  },
};

export default defineConfig({ plugins: [isolateEveryResponse] });
```

### Vite

The engine imports its worker, its AudioWorklet, `audio.wasm` and the default font with Vite's `?url` and `?worker&url` suffixes, so a page that uses it is built with Vite. A TypeScript project also needs Vite's client types, `"types": ["vite/client"]` in its tsconfig, or tsc reports those imports as unknown modules. Seikou's own build sets `worker: { format: 'es' }`; the example below builds without it.

### Installing the packages

The packages are not published to npm. Install them from a checkout of the repository as `file:` dependencies, with `--install-links` so npm copies each package, with only what its `files` lists. The engine's own `@seikou` dependencies are unpublished too, so install them alongside:

```sh
npm install --install-links \
  file:../seikou/packages/engine file:../seikou/packages/bdmv file:../seikou/packages/pg \
  file:../seikou/packages/ass file:../seikou/packages/matroska file:../seikou/packages/nas
```

`npm run package-smoke` in the repository (`scripts/package-smoke.sh`) does exactly this in a temporary project, then typechecks and builds the example of the next section there.

## 3. A minimal player

This is `docs/integrating/minimal-player.ts` from the repository, with `docs/integrating/index.html` as its page (a canvas, a button that opens a folder picker, a play and pause button, a back button and a status line). The package smoke test typechecks it with a strict tsc and builds it with Vite, and a test checks that the code below is the file as it stands.

<!-- example:minimal-player -->
```ts
// A minimal Blu-ray player page built on @seikou/engine. index.html beside this file loads it.
import { createController, createEngineWorker, type PlayerSnapshot } from '@seikou/engine';

const canvas = document.querySelector<HTMLCanvasElement>('#video')!;
const pick = document.querySelector<HTMLButtonElement>('#pick')!;
const folder = document.querySelector<HTMLInputElement>('#folder')!;
const playPause = document.querySelector<HTMLButtonElement>('#play-pause')!;
const back = document.querySelector<HTMLButtonElement>('#back')!;
const status = document.querySelector<HTMLParagraphElement>('#status')!;

// One controller per page. It starts the engine worker and owns the audio output.
const controller = createController({ worker: () => createEngineWorker('engine'), profile: 'desktop' });
// The canvas moves to the worker as an OffscreenCanvas. From here on only the engine draws on it.
controller.attachCanvas(canvas);
controller.resize(canvas.width, canvas.height);

let audioReady: Promise<void> = Promise.resolve();
let picked = false;

pick.addEventListener('click', () => {
  // The browser lets audio start only inside a user gesture, so start it on this click.
  audioReady = controller.startAudio();
  folder.click();
});

folder.addEventListener('change', async () => {
  const files = [...(folder.files ?? [])];
  if (!files.length) return;
  // A playlist that starts before the audio ring reaches the engine plays without sound.
  await audioReady;
  picked = false;
  controller.open(files.map((file) => [file.webkitRelativePath || file.name, file] as const));
});

playPause.addEventListener('click', () => controller.togglePlay());
back.addEventListener('click', () => controller.seek(Math.max(0, controller.getSnapshot().timeUs - 10_000_000)));

/** The longest playlist the engine can play, for a disc without a menu program to choose one. */
function mainPlaylist(s: PlayerSnapshot): string | null {
  const candidates = s.playlists.filter((p) => p.playable && !p.looped);
  candidates.sort((a, b) => b.durationUs - a.durationUs);
  return candidates[0]?.id ?? null;
}

const seconds = (us: number): string => (us / 1_000_000).toFixed(1);

function render(s: PlayerSnapshot): void {
  // An HDMV disc with menus runs its own First Play (indexTitles is set), and so does a BD-J disc when the engine
  // has a provider (bdjActive). Any other disc waits idle with its playlists listed: play the main one.
  if (!picked && s.engineState === 'idle' && s.currentPlaylistId === null && s.indexTitles === null && !s.bdjActive) {
    const id = mainPlaylist(s);
    if (id) {
      picked = true;
      controller.playPlaylist(id);
    }
  }
  playPause.textContent = s.engineState === 'playing' || s.engineState === 'buffering' ? 'Pause' : 'Play';
  const where = s.currentPlaylistId ? `playlist ${s.currentPlaylistId}, ${seconds(s.timeUs)} / ${seconds(s.durationUs)} s` : 'no playlist';
  const problem = s.error ? `: ${s.error.message}` : '';
  const notices = s.notices.map((n) => n.message).join(' ');
  status.textContent = `${s.engineState}, ${where}${problem} ${notices}`.trim();
}

// The snapshot is replaced on every change, so render reads one consistent state.
controller.subscribe(() => render(controller.getSnapshot()));
render(controller.getSnapshot());
```
<!-- /example -->

What each step does:

- `createEngineWorker(name)` starts the package's engine worker, which has no BD-J. `createController({ worker, profile })` calls that factory, creates the audio output, sends the memory profile and listens for `pagehide` and `visibilitychange`. Create one controller per player, on the main thread.
- The profile is `'desktop'` or `'constrained'` (`MEMORY_PROFILES` holds the limits of each). The constrained profile keeps smaller caches and skips IG sub-paths over 64 MB; Seikou uses it on touch devices.
- `attachCanvas(canvas)` transfers the canvas to the worker as an `OffscreenCanvas`. After that only the engine draws on it, and `resize(width, height)` sets its drawing size in pixels.
- `startAudio()` must run inside a user gesture, or the browser keeps the AudioContext suspended. It resolves once the audio ring has reached the engine, and never rejects; open the disc after it, or the first playlist plays without sound.
- `open(entries)` takes `[path, File]` pairs. The paths can start anywhere above `BDMV/` (a picked folder's `webkitRelativePath`, such as `disc1/BDMV/index.bdmv`); the engine finds the folder that holds `BDMV`. For files dropped on the page, `walkEntries(entries, maxDepth)` turns `webkitGetAsEntry()` entries into the same pairs.
- The snapshot (`getSnapshot()`, a `PlayerSnapshot`) is replaced on every change, and `subscribe(listener)` calls the listener after each one, so it fits React's `useSyncExternalStore` as well as plain code. Its `engineState` goes `loading`, then `idle` with `playlists` listed, then `playing`, `paused`, `buffering` or `ended`, or `error` with `error.message`. `notices` holds messages for the viewer, such as the BD-J notice.
- A disc with an HDMV menu program runs its First Play by itself (the snapshot's `indexTitles` is set). Other discs wait in `idle`, and the host picks a playlist with `playPlaylist(id)`; Seikou shows a picker. The example plays the longest playable one.
- Commands: `play()`, `pause()`, `togglePlay()`, `seek(timeUs)` (microseconds from the playlist's start), `seekBy(deltaUs)`, `nextChapter()`, `prevChapter()`, `selectAudio(index)` with an index from `snapshot.audioTracks`, `selectSubtitle(choice)`, `setVolume(volume)` and `toggleMute()`. Disc menus take `menuKey(key)` and `pointer(kind, x, y)` in the 1920 by 1080 menu space, and `menuCall()` opens the top menu. `closeDisc()` closes the disc and resets the snapshot.

## 4. Discs from elsewhere

### A server that speaks the disc API

Seikou's NAS server and its development disc server (`tools/disc-server/`) serve a disc as a manifest plus range reads. `GET <base>manifest`, with the token in `Authorization: Bearer <token>`, answers a `DiscManifest` (`@seikou/nas`): the file list with sizes, and the small metadata files inlined as base64. `<base>files/<path>?t=<token>` serves a file's bytes by `Range` header. `tools/disc-server/README.md` describes the routes, and `docs/self-hosting.md` how to run the NAS server.

To play such a disc, pass the manifest to the controller:

```ts
import type { DiscManifest } from '@seikou/nas';

const base = 'https://nas.example/bluray/api/discs/<id>/'; // ends with '/'
const manifest = (await (await fetch(`${base}manifest`, { headers: { Authorization: `Bearer ${token}` } })).json()) as DiscManifest;
await audioReady; // startAudio() from the click that chose the disc
controller.openRemote({ kind: 'remote', base, token, manifest });
```

The engine builds the reader itself: a `RemoteSource` (read-ahead in chunks, a byte budget) over an `HttpTransport` (one `Range` request per chunk, a 503 waited out for its `Retry-After`, a 401 retried once with a fresh token from `openRemote`'s `refreshToken`). Both are exported from `@seikou/engine` for a host that wants to read a server's disc with its own code, for example to parse it with `@seikou/bdmv`, since `RemoteSource` is a `ByteSource`. The server must allow the page's origin through CORS, and the page must be cross-origin isolated as in section 2.

### ISO images

Seikou plays an ISO image only through a server. The NAS server reads the image with `readUdf` from `@seikou/bdmv` (`server/src/iso.ts`) and serves its files through the same disc API, so the player sees an ordinary disc. The browser cannot open a local ISO today; that is on the roadmap. `readUdf` itself is a parser like the others (section 8).

## 5. Subtitles

PG subtitles come from the disc. `snapshot.subtitles.pg` lists the current playlist's PG tracks, and `selectSubtitle({ kind: 'pg', stream: track.index })` shows one. `{ kind: 'off' }` hides them. The engine follows the disc's own subtitle register (PSR2) as libbluray does, so a disc program can change the track too.

SRT and ASS files come from the viewer. `loadSubtitleFiles(files)` takes `File`s, such as a pick or a drop: its subtitle files become the text subtitle set, and font files in the same pick go to the set's ASS files. `addSubtitleFonts(files)` adds fonts later, and `snapshot.subtitles.text.missingFonts` names the families the scripts ask for that nothing supplied. Show the set with `selectSubtitle({ kind: 'text' })`. A file that is neither UTF-8 nor marked with a BOM sets `snapshot.encodingPrompt`; answer it with `answerEncoding(label)`, a `TextDecoder` label, or `null` to cancel. `shiftSubtitleFile(file, deltaMs)` moves one file's cues, and `removeSubtitleFile()` removes the set.

The engine draws subtitles in its worker with the browser's fonts: an ASS family that nothing supplied falls back to the device's installed font of that name, then to the bundled DejaVu Sans. To draw subtitles outside the engine, use `@seikou/pg` and `@seikou/ass` directly; their READMEs show how.

## 6. BD-J

BD-J discs run Java programs for their menus. Seikou runs them in a JVM written in TypeScript, and that JVM lives in the app, under `src/bdj/`, outside the packages.

### Without a provider

The engine reaches BD-J only through a `BdjProvider` passed to its worker. `createEngineWorker` starts the package's own worker, which passes none. A BD-J disc then opens to the playlist list: `snapshot.usesBdj` is true, `snapshot.bdjSupported` is false, `snapshot.bdjMissing` names `BD-J runtime` (`BDJ_RUNTIME`), and a notice with code `bdj` tells the viewer to choose a playlist (`bdjUnsupportedMessage`). Playlists play as they do on any disc; the disc's menus are missing.

### Seikou's BD-J

A `BdjProvider` (`packages/engine/src/bdj-provider.ts`) is a set of factories: the BD-J worker, the class library, the host that drives the player, the session, the graphics plane, the status block and the input helpers. The engine calls them from its worker and never imports BD-J code. Seikou builds one with `seikouBdjProvider` (`src/bdj/provider.ts`), and an integrator can use it as Seikou does.

Copy these folders from the repository into your project, keeping their places beside each other:

- `src/bdj/`: the JVM, the BD-J runtime, the provider and the BD-J worker. Its `*.test.ts` files are not needed.
- `src/bdj-classlib/`: the Java class library (`rt-bdj.jar`, `libbluray-j2se.jar`, `libbluray-awt-j2se.jar`) and its TypeScript intrinsics, with its licence files.
- `src/wasm/freetype/`: `freetype.wasm`, the FreeType build BD-J draws its text with, with its licence files.

These are every path `src/bdj` reaches outside itself. `src/bdj/bdj-worker-entry.ts` imports `../wasm/freetype/freetype.wasm?url` and `../bdj-classlib/intrinsics/index`, and the intrinsics import back into `src/bdj/jvm/`, so the three folders must keep their relative layout. Everything else they import comes from the packages, and much of it is package internals reached through subpaths of `@seikou/engine`, `@seikou/bdmv` and `@seikou/ass`, for example `@seikou/engine/bdj-types`, `@seikou/engine/nav/navigator`, `@seikou/bdmv/bdjo-parser` and `@seikou/ass/default-font.ttf`. `git grep -ho "from '@seikou/[^']*'" -- src/bdj | sort -u` lists them all. The packages' `./*` exports resolve those paths, but they are internal modules, so they can change between versions of the packages without notice.

Then write an engine worker entry like Seikou's `src/engine-worker.ts`. It calls `startEngineWorker` from `@seikou/engine/worker-main` with the package's assets and the provider:

```ts
import audioWasmUrl from '@seikou/engine/audio.wasm?url';
import defaultFontUrl from '@seikou/ass/default-font.ttf?url';
import { ASSET_FETCH_TIMEOUT_MS, startEngineWorker } from '@seikou/engine/worker-main';
import rtJarUrl from './bdj-classlib/rt-bdj.jar?url';
import libblurayJarUrl from './bdj-classlib/libbluray-j2se.jar?url';
import libblurayAwtJarUrl from './bdj-classlib/libbluray-awt-j2se.jar?url';
import { bdjMissing, seikouBdjProvider } from './bdj/provider';

const g = self as unknown as Record<string, unknown>;
const fetchBytes = async (url: string): Promise<Uint8Array> => {
  const response = await fetch(url, { signal: AbortSignal.timeout(ASSET_FETCH_TIMEOUT_MS) });
  if (!response.ok) throw new Error(`${url}: HTTP ${response.status}`);
  return new Uint8Array(await response.arrayBuffer());
};

startEngineWorker({
  audioWasmUrl,
  defaultFontUrl,
  bdj: seikouBdjProvider({
    missing: bdjMissing(
      { SharedArrayBuffer: g.SharedArrayBuffer, crossOriginIsolated: g.crossOriginIsolated, Atomics: g.Atomics, Worker: g.Worker, WebAssembly: g.WebAssembly, OffscreenCanvas: g.OffscreenCanvas },
      { inWorker: true },
    ),
    loadClassLibrary: async () => {
      const [rt, libbluray, libblurayAwt] = await Promise.all([fetchBytes(rtJarUrl), fetchBytes(libblurayJarUrl), fetchBytes(libblurayAwtJarUrl)]);
      return { rt, libbluray, libblurayAwt };
    },
    decodeImage: (bytes) => createImageBitmap(new Blob([new Uint8Array(bytes)])),
  }),
});
```

`missing` is what this browser lacks to run BD-J, seen from the engine worker; when it is not empty, BD-J discs open to the playlist list with a notice naming it. `loadClassLibrary` fetches the three jars, which Vite serves as assets through `?url` (`rt-bdj.jar` is about 4 MB). `decodeImage` decodes the background stills BD-J menus show under the video; without it they are not drawn. FreeType and the fallback font are not options: `src/bdj/bdj-worker-entry.ts` imports their URLs itself, and the BD-J worker fetches each the first time a menu draws text.

Start the controller with that worker as its factory:

```ts
const controller = createController({
  worker: () => new Worker(new URL('./engine-worker.ts', import.meta.url), { type: 'module', name: 'engine' }),
  profile: 'desktop',
});
```

Keep the `new Worker(new URL(...), { type: 'module' })` literal as it is: Vite recognises that form and bundles the worker. The provider starts the BD-J worker the same way from the engine worker, so BD-J needs a browser that can start a worker from a worker. What a BD-J disc saves is kept in the browser's IndexedDB, which belongs to the page's origin; a disc opened from Seikou's NAS server keeps it in the viewer's store on the server instead, with a copy in IndexedDB.

Taking BD-J this way means copying the app's files and keeping them in step with the packages by hand. Making it a package of its own is on the roadmap.

## 7. Licences

Each piece carries its own licence. The files named here are the record; this section only lists them.

| Piece | Licence | Where it is stated |
| --- | --- | --- |
| Seikou's own code, in the app and in every package | LGPL-3.0-or-later | `LICENSE` and `COPYING` (the GNU GPL it supplements), at the root and in each package |
| Files ported from or derived from libbluray, libudfread and FFmpeg | LGPL-2.1-or-later, as their upstreams released them | Each file's header, the "Derived files" lists in `packages/*/NOTICE` and `src/bdj/NOTICE`, and `LICENSES/LGPL-2.1.txt` in each package that holds such files |
| Files ported from libass (`@seikou/ass`) | LGPL-2.1-or-later AND ISC | Each file's header and `packages/ass/NOTICE` |
| DejaVu Sans (`packages/ass/src/default-font.ttf`) | The DejaVu fonts licence | `packages/ass/src/LICENSE-DejaVu.txt` |
| `audio.wasm` (FFmpeg's AC-3, E-AC-3 and DTS decoders with `shim.c`) | LGPL-2.1-or-later | `packages/engine/wasm/audio/NOTICE` |
| `freetype.wasm` (FreeType 2.13.2 with `shim.c`) | FreeType: the FreeType License (FTL); `shim.c`: LGPL-2.1-or-later | `src/wasm/freetype/NOTICE` and `src/wasm/freetype/FTL.TXT` |
| `src/bdj-classlib/rt-bdj.jar` (OpenJDK 8 classes) | GPLv2 with the Classpath Exception | `src/bdj-classlib/LICENSE`, `ASSEMBLY_EXCEPTION` and `NOTICE` |
| The Apache Xerces classes in `rt-bdj.jar` (`com/sun/org/apache/xerces/internal/**`, `com/sun/xml/internal/stream/Entity*`) | Apache-2.0 | `src/bdj-classlib/THIRD_PARTY_APACHE` |
| The SAX classes in `rt-bdj.jar` (`org/xml/sax/**`) | GPLv2 with the Classpath Exception, plus the SAX project's public-domain notice | `src/bdj-classlib/SAX_NOTICE` |
| `sun/text/normalizer/**` in `rt-bdj.jar`, derived from ICU4J | GPLv2 with the Classpath Exception, with ICU's notice | `src/bdj-classlib/THIRD_PARTY_ICU` |
| `libbluray-j2se.jar` and `libbluray-awt-j2se.jar` | LGPL-2.1-or-later | `src/bdj-classlib/NOTICE` |
| `src/bdj-classlib/intrinsics/` (TypeScript derived from OpenJDK) | GPLv2 with the Classpath Exception | `src/bdj-classlib/intrinsics/NOTICE` |
| Other attributions of BD-J (DoppioJVM, fdlibm) | As each notice states | `src/bdj/NOTICE` |

## 8. The parsers on their own

The parsers take bytes and need no player, so they run in Node, a page or a worker.

### `@seikou/bdmv` on a folder

```ts
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { parseClpi, parseIndex, parseMpls } from '@seikou/bdmv';

const disc = process.argv[2]!; // a folder that holds BDMV/
const bytes = async (path: string) => new Uint8Array(await readFile(join(disc, path)));

const index = parseIndex(await bytes('BDMV/index.bdmv'));
console.log('first play runs', index.firstPlay.kind, 'and the disc has', index.titles.length, 'titles');

const playlist = parseMpls(await bytes('BDMV/PLAYLIST/00000.mpls'));
for (const item of playlist.playItems) {
  const clip = parseClpi(await bytes(`BDMV/CLIPINF/${item.clipId}.clpi`));
  const seconds = (item.outTime - item.inTime) / 45_000; // play item times are on a 45 kHz clock
  console.log(item.clipId, seconds.toFixed(1), 's,', clip.programs[0]?.streams.length, 'streams,', clip.epMaps[0]?.entries.length, 'entry points');
}
```

Each parser throws a `ParseError` for a file it cannot read. `parseMovieObjects`, `parseBdjo`, `parseSoundBdmv` and `parseBdid` read the other metadata files. For the streams, `M2tsReader` demuxes a clip's source packets into PES packets, and `avcCodecString` and `hevcCodecString` name the WebCodecs codec of a video stream from its parameter sets.

An ISO image is read with `readUdf(read)`, where `read(offset, length)` returns that range of the image. It resolves with every regular file, each with its path (`BDMV/STREAM/00001.M2TS`), its size and the extents of the image that hold it; `udfPieces(file, start, end)` maps a byte range of a file onto the image. `UdfImage.open(read)` opens the image once and finds single files with `find(path)`.

### `@seikou/matroska` with a `RangeReader`

```ts
import { open } from 'node:fs/promises';
import { openMatroska, type RangeReader } from '@seikou/matroska';

const path = process.argv[2]!;
const handle = await open(path);
const reader: RangeReader = {
  name: path,
  size: (await handle.stat()).size,
  async read(offset, length) {
    const buffer = new Uint8Array(length);
    const { bytesRead } = await handle.read(buffer, 0, length, offset);
    return buffer.subarray(0, bytesRead);
  },
};

const mkv = await openMatroska(reader);
console.log(mkv.durationMs, 'ms,', mkv.tracks.map((t) => t.codecId), mkv.chapters.map((c) => c.name), mkv.tags);
await handle.close();
```

A `RangeReader` returns fewer bytes than asked only at the end of the data. In a page or a worker, `blobRangeReader(file)` makes one from a `Blob` or `File`. `mkv.blocksFrom(timeMs)` iterates the blocks from a time on, and `writeMatroska` writes a file through an `MkvSink`; `packages/matroska/README.md` shows both.
