# @seikou/engine

The Blu-ray player engine for browsers. It opens a disc from local files or a NAS over HTTP (`openDisc`), runs HDMV navigation and IG menus, demuxes and decodes video with WebCodecs and audio with WebCodecs and FFmpeg's AC-3, E-AC-3 and DTS decoders (`audio.wasm`), and composites video, PG, ASS and text subtitles on an `OffscreenCanvas`, all in a worker that `createEngineWorker(name)` starts. On the page, `createController({ worker, profile })` returns a `PlayerController`, an external store over the worker's messages that also plays the audio through an AudioWorklet. BD-J (Java) menus are optional: a host with a BD-J runtime writes its own worker entry that calls `startEngineWorker` from `@seikou/engine/worker-main` with a `BdjProvider` (Seikou's app passes `seikouBdjProvider` from `src/bdj/`), and without one BD-J discs open to the playlist picker.

```ts
import { createController, createEngineWorker } from '@seikou/engine';

const controller = createController({ worker: () => createEngineWorker('bluray-engine'), profile: 'desktop' });
controller.attachCanvas(canvas); // an HTMLCanvasElement; the worker draws on its OffscreenCanvas
controller.subscribe(() => render(controller.getSnapshot()));
controller.open(entries); // [path, File] pairs of a BDMV folder (walkEntries in @seikou/engine/controller/entry-walk)
```
