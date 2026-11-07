<!-- SPDX-License-Identifier: LGPL-3.0-or-later -->
# web/: the subtitle helper page

The page the user works in to choose fansub subtitles for a disc's episodes before an encode. `seikou-encode serve` serves it from `encoder/web/dist` together with its API (`encoder/src/server/README.md`), on 127.0.0.1, with a token per run in the address (`?t=`). It is one column under a step bar: pick a release, match episodes, line up, with a Details panel for the names and languages the encode writes and "Save for encoding", which stores the record the encode reads.

## Concepts

- **State.** `HelperState` (`helper-model.ts`) holds everything the user chose: the AniList show and episode offset, the release and its match (one row per episode, which release file it uses), the chosen tracks per episode (or `none`), each episode's timing (alignment found, the user's nudge, accepted or not) and the metadata draft. `reduce` is pure; every change but moving between steps marks the state dirty. Episodes are keyed by their 1-based index in the run's episode list.
- **Steps.** Step 1 is always open, step 2 once a release is picked, step 3 once an episode has tracks or is marked as having none (`canEnter`). An action that closes the step on screen moves the page back to the furthest open one.
- **Tracks.** Track ids repeat between a release's files, so an episode's choice is its matched file plus track ids. Across releases a track is identified by its cached path (`CachedTrack.path`), which is also what the saved record names; the metadata draft keys tracks by it.
- **Metadata draft.** `MetadataDraft` (`metadata/metadata-model.ts`) holds per episode the record's metadata fields plus the subtitle tracks' order, names, languages and ticks, and the set of field paths the user edited. `defaultMetadata` fills the defaults: title `<Show> - <nn> - <episode title>`, unnamed `und` video, audio named after its stream-table language (`jpn` is `Japanese`), subtitles named `<group> full` or `<group> signs`, chapters `Chapter n`.
- **The record.** `toRecord` writes the state as the backend's `SubtitleRecord` (an offset as `shiftMs`, a split as `split` with `shiftMs` 0, anything else as 0 and null). `fromRecord(record, release)` restores it once the record's release has been asked for again; without the release the show, timings and metadata come back but no choices. The record keeps no alignment confidence, and an episode saved with no shift, split or nudge is lined up again.
- **Wire types.** `api-types.ts` declares every answer shape itself, because `encoder/src` and `@seikou/fansubs` need Node. Only types from `@seikou/nas/nas-api` (such as `FansubAlignment`) are imported.
- **Token.** Read from `?t=` by `main.tsx` and kept only in the `HelperApi` object; requests send it as `Authorization: Bearer`, and URLs the engine fetches itself (subtitles, fonts) carry it as `?t=`.

## API

- `createApi(base, token, fetch?)` in `api.ts`: one method per route (`session`, `episodes`, `searchTitles`, `episodeTitles`, `seadex`, `searchTosho`, `fetchRelease`, `upload`, `release`, `align`, `subtitleUrl`, `fontUrl`, `record`, `saveRecord`). Failures reject with `ApiError { status, code, message, details }`; `status` 0 with `code: 'network'` means the backend did not answer.
- `helper-model.ts`: `HelperState`, `HelperAction`, `initialState`, `reduce`, `canEnter`, `toRecord`, `fromRecord`.
- `metadata/metadata-model.ts`: `MetadataDraft`, `defaultMetadata`, `languageCode`, `languageName`, `defaultTrackName`, `defaultTitle`, `defaultTrack`.
- `App({ api })`: the page shell; `StepBar` the three steps.
- `ReleaseStep({ api, state, dispatch })` in `steps/`: step 1. AniList search (only on submit), the picked show, the episode offset, SeaDex releases for that show (asked only once a show is picked), an Anime Tosho search and the user's own files; `releaseSummary` in `release-model.ts` counts what a fetched release holds.

## Building and running

- `npm run encoder:web:build` writes `encoder/web/dist` (`vite build --config encoder/web/vite.config.ts`), which `serve` needs.
- `npm run encoder:web:dev` serves the page with hot reload. Start `serve` first and set `SEIKOU_ENCODE_API` to its address; the dev server sends `/api` there. Open the dev page with serve's token as `?t=`.
- Both serve with COOP/COEP, because Seikou's engine needs `SharedArrayBuffer`.
- Tests run in the root Vitest `encoder` project (`npx vitest run --project encoder encoder/web`); component tests pick jsdom with a `// @vitest-environment jsdom` comment. Type-checking is `tsconfig.encoder-web.json` (DOM, `vite/client`); the Vite config is checked by `tsconfig.node.json`.

## Look

Dark only. One typeface, Instrument Sans (its width axis condenses the disc's name and headings), tabular numerals for times and counts (`.num`). Colours are tokens on `:root` in `styles.css`: base `#0F1B2D`, panel `#17273D`, ink `#E9EFF7`, muted `#8FA1BC`, accent `#4D9BFF` for the chosen item and alignment marks, amber `#F0B45B` only for the nudge. Left aligned, 16 px side gutters, usable at 375 px. No uppercase labels; the step bar is the only numbered thing.

## Where to look

- `main.tsx`: the entry point, reading the token.
- `App.tsx`: the header, step bar, Details sheet, save, and the step on screen.
- `StepBar.tsx`: the steps.
- `steps/ReleaseStep.tsx`, `steps/release-model.ts`: step 1 and its pure helpers.
- `api.ts`, `api-types.ts`: the client and the wire shapes.
- `helper-model.ts`: state, reducer, record conversion.
- `metadata/metadata-model.ts`: the metadata draft and its defaults.
- `styles.css`: the look.
