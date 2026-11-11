# User interface

This folder is the React side of the Seikou app, on the page's main thread. The player itself runs in the engine worker (`@seikou/engine`); the interface reads its state and sends it commands, and adds what the engine leaves to its host: picking discs, menus, input, saving places, shader sets, the theme and the NAS screens.

## Concepts

`App.tsx` creates one `PlayerController` (`@seikou/engine`'s `createController`, with the memory profile from `memory-profile.ts`) for the app's life. It is an external store: screens read its `PlayerSnapshot` with `useSyncExternalStore(controller.subscribe, controller.getSnapshot)` and send commands through its methods. There is no state library. The shader model, the theme controller and `NasHistory` follow the same pattern (`subscribe` and `getSnapshot`); the NAS client tells listeners of session and pairing changes instead.

`App` shows one of three screens. While no disc is open, it shows the help pages for a `/help` address (loaded lazily, `help/`) or `LandingScreen`, which holds the app bar, the home screen, recent discs and every NAS screen (`nas/`). Once the controller reports a disc (a playlist list or an open encode), it shows `PlayerScreen`, and the page stays dark until the disc closes.

Each piece of behaviour worth testing is a plain module with no React (`place-model.ts`, `shader-model.ts`, `keyboard.ts`, `touch.ts`, `chapter-actions.ts`, `subtitle-starts.ts` and others), and the `.tsx` files render it. Browser APIs come in through injectable parameters, so the unit tests run without a browser.

`capabilities.ts` builds a report from feature checks on the browser's globals and never from its user agent; the landing screen explains what is missing. `video-caps.ts` probes what the device can decode, for quality levels and the AV1 check on encodes. The one exception is the iPadOS check in `memory-profile.ts`, because iPadOS reports itself as a Mac.

`PlaceSaver` (`place-saver.ts`) saves the open disc's place every 10 s while it plays and at once on a pause, seek, track or offset change, on close and when the page hides. A local disc's places stay on this device (`place-store.ts`, IndexedDB); a NAS disc's go to the NAS through an outbox on the device. `place-model.ts` decides which playlists make a place and when one is finished, and `place-apply.ts` puts a place's settings back once the disc has opened, without overriding a pick the user made since.

## API

The folder has no public API for other packages; `src/main.tsx` mounts `App` and nothing outside `src/` imports from here. What its parts take from each other:

- `App.tsx` builds the controller, the NAS client, the place saver and the shader model, and passes them to `LandingScreen` and `PlayerScreen` as props.
- `PlayerScreen.tsx` renders the canvas the engine draws on (handed over with `controller.attachCanvas`), `ControlBar.tsx`, and the menus: `AudioMenu.tsx`, `SubtitleMenu.tsx` (disc PG, the viewer's files, the NAS's stored subtitles, `ToshoSearch.tsx`), `ShaderMenu.tsx`, `QualityMenu.tsx`, `EncodeMenus.tsx`, plus `PlaylistPicker.tsx` and `RemotePad.tsx` for disc menus.
- Input: `keyboard.ts` maps keys to actions and names the disc operation (UO) each needs, `touch.ts` decides what a tap or long press does over a disc menu, and `pointer.ts` maps pointer positions into the 1920×1080 menu space.
- `db.ts` opens the IndexedDB database `bluray-web` that the place store, recent discs (`recent-discs.ts`), the shader library (`shader-library.ts`) and the NAS pairings (`nas/nas-store.ts`) share. Its name stays from before the rename, so users keep their data.

## Where to look

- Opening a disc: `disc-input.ts` (a picked or dropped folder as path and file pairs), `recent-discs.ts`, `local-resume.ts` (Resume or Start from beginning for a local disc), `disc-server.ts` (discs from the development disc server).
- Video shaders: `shader-sets.ts` (the built-in Anime4K sets and `input.conf` imports), `bundled-shaders.ts` (the shader files that ship in [`anime4k/`](anime4k), vendored from Anime4K under its own licence), `shader-library.ts` and `shader-model.ts`.
- Subtitles: `SubtitleMenu.tsx`, `subtitle-starts.ts`, `EncodingPrompt.tsx` (the encoding asked for a file that is not UTF-8).
- Encodes in the player: `chapter-actions.ts` (Skip opening, Skip ending, Next episode from chapter names), `ChapterActionButton.tsx`, `NextEpisodeButton.tsx`, `EncodeMenus.tsx`.
- The look: `styles.css` (colour tokens on `:root`, light values under `:root[data-theme='light']`), `theme.ts` and `ThemeSwitch.tsx`, `name-lang.ts` (tags Japanese names so their kanji keep Japanese forms).
- The rest: `fullscreen.ts` (the standard and WebKit fullscreen APIs), `format.ts` (times as `m:ss`), `update-prompt.ts` (when to offer a new version), `media-query.ts`, `TouchLog.tsx` (`?touchlog=1`).
- The NAS screens: [`nas/`](nas/README.md). The help pages: `help/`, built from `docs/*.md` by `vite/markdown.ts`.

## Documentation

- [`../README.md`](../README.md): the app as a whole.
- Specs: [`2026-10-16-cross-browser-and-remote-design.md`](../../docs/superpowers/specs/2026-10-16-cross-browser-and-remote-design.md) (browsers, mobile, touch), [`2026-10-15-video-shaders-design.md`](../../docs/superpowers/specs/2026-10-15-video-shaders-design.md), [`2026-10-20-permalinks-resume-design.md`](../../docs/superpowers/specs/2026-10-20-permalinks-resume-design.md) (places) and [`2026-10-27-light-dark-mode-design.md`](../../docs/superpowers/specs/2026-10-27-light-dark-mode-design.md).
- [`docs/integrating.md`](../../docs/integrating.md) shows a minimal player without this interface.
