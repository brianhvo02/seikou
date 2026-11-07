# @seikou/engine

The Blu-ray player engine: a worker that opens a disc (local files or a NAS over HTTP), runs HDMV navigation and IG
menus, demuxes and decodes video (WebCodecs) and audio (WebCodecs plus FFmpeg's AC-3, E-AC-3 and DTS decoders in
`audio.wasm`), and composites video, PG, ASS and text subtitles on an `OffscreenCanvas`; and the page-side
`PlayerController`, an external store over the worker's messages that also plays the audio through an AudioWorklet.
`createEngineWorker(name)` starts the package's own worker and `createController` wires it to the page. BD-J (Java)
menus are not included: a host that has a BD-J runtime starts its own worker entry that calls
`startEngineWorker({ bdj, audioWasmUrl, defaultFontUrl })` from `@seikou/engine/worker-main` with a `BdjProvider`;
without one, BD-J discs open to the playlist picker.

```ts
import { createController, createEngineWorker } from '@seikou/engine';

const controller = createController({ worker: () => createEngineWorker('bluray-engine'), profile: 'desktop' });
controller.attachCanvas(canvas); // an HTMLCanvasElement; the worker draws on its OffscreenCanvas
controller.subscribe(() => render(controller.getSnapshot()));
controller.open(entries); // [path, File] pairs of a BDMV folder (walkEntries in @seikou/engine/controller/entry-walk)
```
