# @seikou/nas

The wire contract between Seikou's NAS server, the player and the pairing Worker. It is types and small pure functions with no I/O, so the three sides share one definition instead of keeping copies. It needs nothing from its consumer.

## Modules

All sources are in `src/` and re-exported from `src/index.ts`; any one can also be imported by path (`@seikou/nas/nas-api`).

| Module | What it does |
| --- | --- |
| `nas-api` | The NAS API's request and response types, such as disc manifests, titles, people, playback places and subtitles. Types only, no runtime code. |
| `disc-key`, `content-hash` | Disc keys (`d.` plus a disc id, or `f.` plus a content fingerprint) and TheDiscDB's ContentHash, with its own MD5 so it runs where Node's `crypto` does not. |
| `place-rules`, `place-key` | Rules for saved playback places that the server and the app share (such as which places are too close to the start to offer resuming), and the keys that name a disc's or an encode's place. |
| `encode-title`, `encode-id` | The title an encoded episode belongs to (AniList, TMDB series or film, or an own title) read from its tags, and the id the NAS routes and the player name an encode by. |
| `title-text` | Title normalisation, so the server's matcher and the app's library search match a title the same way. |
| `pairing-code` | Pairing codes: 12 characters of Crockford base32, shown as `XXXX-XXXX-XXXX`, with a parser that forgives dashes, case and look-alike characters. |
| `cors-policy` | The CORS rules the NAS server and the rendezvous Worker share. |
| `rtc-wire` | The framing of HTTP-shaped requests and responses over one WebRTC data channel (messages of at most 65536 bytes, for Safari). |

## What a consumer provides

Nothing. The package has no dependencies, performs no I/O and reads no environment.

## Usage

Import from the package root, or from a module's path when you want only that module:

```ts
import { discKeyOf, parseDiscKey } from '@seikou/nas';
import type { DiscManifest } from '@seikou/nas/nas-api';
```

## Documentation and references

Links to repository files are relative to the Seikou repository.

- Using the packages in your own page or tool: the integration guide, [`docs/integrating.md`](../../docs/integrating.md).
- The NAS server and its API: [`docs/superpowers/specs/2026-10-17-nas-server-design.md`](../../docs/superpowers/specs/2026-10-17-nas-server-design.md).
- People, invites and the WebRTC route (`rtc-wire`): [`docs/superpowers/specs/2026-10-18-webrtc-people-design.md`](../../docs/superpowers/specs/2026-10-18-webrtc-people-design.md).
- Places (`place-rules`, `place-key`): [`docs/superpowers/specs/2026-10-20-permalinks-resume-design.md`](../../docs/superpowers/specs/2026-10-20-permalinks-resume-design.md).
- Encode ids and titles: [`docs/superpowers/specs/2026-11-08-encodes-library-design.md`](../../docs/superpowers/specs/2026-11-08-encodes-library-design.md).
- Using the NAS: [`docs/nas.md`](../../docs/nas.md). Running a server: [`docs/self-hosting.md`](../../docs/self-hosting.md).
- TheDiscDB, whose ContentHash `content-hash` follows: https://github.com/TheDiscDb/data.
