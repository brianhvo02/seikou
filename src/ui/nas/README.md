# NAS screens

This folder is the app's side of the NAS server: pairing, reaching the NAS over HTTPS or WebRTC, the title and Encodes libraries, the pre-flight that opens a disc or an episode, and the owner's screens. It runs on the page's main thread. The wire types it shares with the server are in `@seikou/nas`; the server is in [`server/`](../../../server/README.md).

## Concepts

Pairing redeems a code (typed, scanned from a QR code, or from a `?pair=` link) for a device id. The device's P-256 key pair is made here and kept in IndexedDB with a non-extractable private key (`nas-store.ts`), and the NAS keeps the public half. For each session the device signs the NAS's challenge and gets a token that lasts an hour; `NasClient` renews it as it runs out. A typed code is looked up through the rendezvous Worker; a link names the server (`nas=`) or the Worker (`rv=`), and the app asks before pairing with one that isn't its own (`pair-link.ts`).

`route-choice.ts` tries the pairing's HTTPS base first, with a 2 s health check, and falls back to a WebRTC data channel set up through the Worker's signalling (`rtc/`). Both carry the same requests, so the rest of the code calls `NasClient` and never knows which route answered. A disc opened over WebRTC keeps reconnecting over WebRTC only. The engine reads a NAS disc through `RemoteSource` with `NasClient.discFetch`, which serves the same `fetch` over a `MessagePort`, so the engine worker and the BD-J worker read through the one route.

Every NAS screen has a path under `/nas/…` (`nas-route.ts` builds and parses them), and `NasHistory` (`nas-history.ts`) is the one place that pushes, replaces and listens for Back and Forward. A play link (`/nas/play/<discKey>?pl=&t=`) names its disc by its key, which the app resolves on the NAS; `PlayingRoute` keeps the link current while the disc plays, so a reload resumes it.

Each screen keeps its logic in a `*-model.ts` file with no React and no network (`library-model.ts`, `title-model.ts`, `resume-model.ts`, `buffer-model.ts`, `level-model.ts`, `subtitle-model.ts`, `fansub-model.ts`, `encodes-model.ts` and others), and the `.tsx` files render it.

Before a NAS disc opens, `Preflight.tsx` asks the NAS for the disc's places, its quality levels and a speed probe, and then offers what fits: Resume or Start from beginning (`resume-model.ts`), a quality level the device can decode (`level-model.ts`, `video-caps.ts` one folder up), and playing at once, buffering first, or playing with pauses when the link is slower than the disc (`buffer-model.ts`). `EncodePreflight.tsx` does the same for an encoded episode, and shows a warning instead of opening one on a device without AV1.

## API

The folder has no public API for other packages. `LandingScreen` (one folder up) renders these screens from the route, and `PlayerScreen` uses the parts that work during playback. The pieces other code calls:

- `NasClient` (`nas-client.ts`): pairing, sessions, every API request (titles, places, subtitles, fansubs, encodes, admin actions), `discFetch` for the engine, and listeners for session and pairing changes. Every browser API reaches it through `NasClientDeps`, so tests run without a browser. `NAS_MESSAGES` holds the words for each way reaching the NAS can fail.
- `NasHistory`, `useNasRoute`, `nasRoutePath` and `parseNasRoute`: navigation.
- `disc-spec.ts`: turns a NAS disc into the `RemoteDiscSpec` the engine opens.
- `LevelSession` (`level-session.ts`): the open disc's quality level, its GPU lease on the NAS and the Quality menu's switch.
- `StoredSubtitlePicker` (`stored-subtitle-pick.ts`) and `encode-subtitles.ts`: fetching the NAS's stored subtitles into the player.
- `launchEncode` (`encode-launch.ts`): opens an encoded episode, shared by the pre-flight and Next episode.

## Where to look

- Pairing: `PairScreen.tsx`, `pair-link.ts`, `qr.ts`, `nas-store.ts`, `people-model.ts` (who this device is paired as).
- Reaching the NAS: `nas-client.ts`, `route-choice.ts`, `rtc/rtc-connection.ts` and `rtc/signalling-client.ts`, the relay's `RelaySettings.tsx`, `RelayBadge.tsx` and `relay-model.ts`, `upload-progress.ts`.
- The disc library: `TitleLibrary.tsx`, `SeriesScreen.tsx`, `SeasonScreen.tsx`, `ContinueRow.tsx`, `Poster.tsx`, `AlphabetRail.tsx`, `LibraryScreen.tsx` (browsing by folder), with `title-model.ts`, `title-index.ts`, `library-model.ts` and `poster-reach.ts`.
- Music: `MusicScreen.tsx`, `ArtistGrid.tsx`, `ArtistPage.tsx`, `MusicReleaseMenu.tsx`, `artist-model.ts`.
- The Encodes library: `LibraryTabs.tsx`, `EncodesLibrary.tsx`, `EncodeShowScreen.tsx`, `EncodePreflight.tsx`, `encodes-model.ts`.
- Opening a disc: `Preflight.tsx`, `ResumePrompt.tsx`, `resume-model.ts`, `buffer-model.ts`, `level-model.ts`, `missing-start-notice.ts`, `NasNotFound.tsx`.
- Subtitles and fansubs: `SubtitleUpload.tsx`, `SubtitleList.tsx`, `subtitle-model.ts`, `FansubLine.tsx`, `FansubEpisodePanel.tsx`, `FansubLanguages.tsx`, `fansub-model.ts`, `tosho-search-model.ts`.
- The owner's screens: `AdminScreen.tsx` (NAS settings) with `PeopleSection.tsx`, `DrivesSection.tsx`, `EncodingNowSection.tsx` and `SubtitleUploadsSection.tsx`; `UnsortedScreen.tsx`, `FileDifferently.tsx`, `HiddenScreen.tsx`, `admin-model.ts` and `unsorted-model.ts`.
- `load-queue.ts`: limits how many requests a screen makes at once.

## Documentation

- [`docs/nas.md`](../../../docs/nas.md): using the NAS from the player.
- Specs: [`2026-10-17-nas-server-design.md`](../../../docs/superpowers/specs/2026-10-17-nas-server-design.md), [`2026-10-17-nas-library-titles-design.md`](../../../docs/superpowers/specs/2026-10-17-nas-library-titles-design.md), [`2026-10-18-webrtc-people-design.md`](../../../docs/superpowers/specs/2026-10-18-webrtc-people-design.md), [`2026-10-19-lower-quality-design.md`](../../../docs/superpowers/specs/2026-10-19-lower-quality-design.md), [`2026-10-20-permalinks-resume-design.md`](../../../docs/superpowers/specs/2026-10-20-permalinks-resume-design.md), [`2026-10-23-fansubs-design.md`](../../../docs/superpowers/specs/2026-10-23-fansubs-design.md) and [`2026-11-08-encodes-library-design.md`](../../../docs/superpowers/specs/2026-11-08-encodes-library-design.md).
