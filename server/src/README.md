# NAS server source

This is the source of the NAS server. [`../README.md`](../README.md) covers running, deploying and configuring it; this page explains how the code is put together.

## Concepts

A request is answered by a list of handlers (`Handler` in `http.ts`): each one either answers or returns null to let the next one try. `createServer` runs the built-in `GET /api/health` first and adds CORS to every answer. The same list serves requests that arrive over a WebRTC data channel (`rtc/dispatch.ts`), so a route never knows which way a device came, except where it asks (uploads refuse a data channel with 403 `https-only`).

Every device and pairing code belongs to a person, and owner status is the person's (`auth.ts`). A device pairs once with a code (10 minutes, or 3 days for an invite) and registers its P-256 public key. After that it signs a 60 s challenge to get a session token that lasts an hour, and sends that token as `Authorization: Bearer` or `t=` on every request. Pairing, the session handshake and health are the only routes open without a token; `requireToken` in `app.ts` answers 401 to the rest. Admin routes take the token only as a header, and only from an owner device.

`library.ts` walks the read-only roots slowly and nightly, leaves out a disc whose files changed within the last hour, reads `.iso` files through the UDF reader (`iso.ts`), and keeps the last scan's discs for a root that has gone missing. After each scan the title service (`titles/service.ts`) matches discs to titles with the rules in `@seikou/titles` and keeps the answers in `metadata.json`, so a restart serves the last catalogue offline. A disc is filed only when the evidence agrees; everything else goes to Unsorted with a reason the owner sees.

Everything the server writes lives in its data directory, plus the encodes folder when one is set. The stores replace whole files atomically (a temporary file, then a rename), so a crash never leaves half a file:

| Path under the data directory | What it holds | Code |
| --- | --- | --- |
| `auth.json`, `secret` | people, devices and pairing codes; the key that signs session tokens | `auth.ts`, `store.ts` |
| `rendezvous-key.json` | the NAS's key for the rendezvous Worker | `rendezvous-client.ts`, `main.ts` |
| `library.json` | the last scan of every root | `library.ts` |
| `metadata.json`, `owner.json`, `art/` | the title catalogue's lookups, the owner's choices, cached posters | `titles/service.ts`, `@seikou/titles` |
| `users/<personId>/` | each person's BD-J saved data (`bdj/`), places (`playback/`) and `player-settings.json` | `bdj-store.ts`, `playback-store.ts`, `player-settings-store.ts` |
| `subtitles/` | uploaded and fansub subtitles with their fonts | `subtitle-store.ts` |
| `fansubs/` | fansub state, the download cache and viewers' picks | `fansubs/` |
| `transcode/` | encoded intervals of quality levels, an LRU by bytes | `levels/segment-cache.ts` |
| `encodes.json`, `encode-entries.json` | the Encodes folder's index and the AniList and TMDB entries its shows need | `encodes/index-store.ts`, `titles/service.ts` |

Quality levels (`levels/`) re-encode a disc's video on the GPU while it plays, at most 120 s of film ahead of the reads, and a read the encoder hasn't reached yet answers 503 with `Retry-After: 1`. The fansub pass (`fansubs/service.ts`) runs one title at a time at night and pauses while a disc is read or a level encodes (`disc-activity.ts`).

## API

Every route is under `/api/`, and each file under `routes/` says in its doc comment which paths it answers, with every status and error code:

| File | Routes |
| --- | --- |
| `pair.ts` | `pair/redeem`, `session/challenge`, `session` (open without a token) |
| `titles.ts` | `me`, `titles`, `titles/<id>`, `art/<artId>` |
| `library.ts` | `library?path=` (folders) |
| `discs.ts` | `discs/resolve/<discKey>`, `discs/<id>/manifest`, `files/<path>`, `probe`, `levels`, `viewing` |
| `playback.ts`, `player-settings.ts` | `me/playback/…` (places, Continue watching, progress), `me/player-settings` |
| `bdj-store.ts` | `bdj-store/<scope>` (a person's BD-J saved data under ETags) |
| `subtitles.ts` | `subtitles`, `subtitles/<id>/file`, `fonts/<name>` |
| `fansubs.ts` | `fansubs/search`, `releases`, `picks`, and the owner's `languages`, `titles/<id>`, `subtitles/<id>` |
| `encodes.ts` | `encodes/status`, `ids`, `shows`, `<id>`, `<id>/manifest`, `<id>/files/EPISODE.MKV`, `uploads` |
| `admin.ts` | `admin/…`, the owner screens' actions |

The request and response types are in `@seikou/nas` (`packages/nas/src/nas-api.ts`), which the app and the encoder share. A route that is not configured (no title service, no levels backend, no encodes folder) answers 404.

## Where to look

- Start-up and wiring: `main.ts` builds every service from `config.ts` and passes them to `appHandlers` in `app.ts`, which orders the handlers. `cli.ts` holds the `owner-code` and `nas-id` subcommands.
- HTTP plumbing: `http.ts` (handlers, `HttpError`, bounded body reads, the server), `ranges.ts` (`Range` headers), `cors.ts`.
- Discs: `library.ts`, `manifest.ts` (a disc's file list with its metadata inlined), `disc-id.ts`, `iso.ts`.
- Titles: `titles/evidence.ts` (what a disc says about itself), `titles/folder-cover.ts` (a music release's own cover), `titles/service.ts`.
- Pairing beyond the home network: `rendezvous-client.ts` (registers codes with the [rendezvous Worker](../../rendezvous/README.md)) and `rtc/` (`peer.ts` runs the peers on werift, `udp-mux.ts` puts them all on one UDP port, `public-address.ts`, `signalling-client.ts`, `relay.ts` for the TURN relay switch and allowance).
- Quality levels: `levels/levels.ts` (the levels and the byte plan), `clpi-writer.ts` and `mpls-writer.ts`, `encoder.ts` (ffmpeg), `remux.ts`, `clip-run.ts`, `capacity.ts` (GPU leases), `backend-check.ts`, all tied together by `level-service.ts`.
- Encodes: `encodes/index-store.ts` (the folder index, reading Matroska tags through `node-reader.ts`) and `encodes/uploads.ts` (resumable uploads).
- Fansubs: `fansubs/service.ts`, `state.ts`, `picks.ts`, and `ffmpeg-decoder.ts`, the audio decoder the server injects into `@seikou/fansubs`.
