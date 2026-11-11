# NAS server

The NAS server is a Node program that serves a Blu-ray library to the Seikou player. It scans disc folders and ISO images, reads byte ranges for playback, groups discs into titles, and keeps per-person data such as resume points and BD-J saved data. It can also re-encode a disc at a lower quality on the GPU and file encoded episodes into an Encodes library. It has no native dependencies: `server/build.mjs` bundles it into one `server/dist/server.mjs` that runs on plain Node.js.

The player pairs with the server by code, QR code or link, over HTTPS or over a WebRTC data channel (through the [rendezvous Worker](../rendezvous/README.md)). Disc files are never copied elsewhere, and the library mounts are read-only.

## Running it

Commands run from the repository root:

```sh
npm run server:build    # bundle server/ into server/dist/server.mjs
npm run server:dev      # build, then serve fixtures/synthetic as root "syn" on port 4192 (data in .cache/server-data)
npm run server:deploy   # the owner's deploy: build the image, ship it over ssh, restart the service
```

`server:deploy` runs [`deploy/deploy.sh`](deploy/deploy.sh). The ssh host and Caddy site come from `BLURAY_NAS_HOST` and `BLURAY_CADDY_SITE` in the environment or a gitignored `.env.local`. `deploy.sh --owner-code` prints a fresh owner pairing code, and `deploy.sh --nas-id` prints the NAS's rendezvous id.

Other people run the published image `ghcr.io/brianhvo02/bluray-server` (linux/amd64) with [`deploy/compose.yaml`](deploy/compose.yaml) and [`deploy/.env.example`](deploy/.env.example). The [`Dockerfile`](Dockerfile) builds it from Debian 13's Node image with Debian's own ffmpeg and Intel's media driver. [`deploy/compose.gpu.yaml`](deploy/compose.gpu.yaml) adds the render node for hardware encoding, and [`deploy/compose.encodes.yaml`](deploy/compose.encodes.yaml) adds the writable Encodes folder.

## Settings

Settings come from environment variables, read in [`src/config.ts`](src/config.ts). [`deploy/.env.example`](deploy/.env.example) lists them with their meaning. `PUBLIC_BASE` is required: the server and its subcommands refuse to start without it.

## Modules

[`src/README.md`](src/README.md) explains how the code fits together: the handler chain, people and sessions, the data directory and the routes. Top level of [`src/`](src):

| File | What it does |
| --- | --- |
| `main.ts`, `app.ts`, `cli.ts`, `config.ts` | Start-up, the request handler that joins the routes behind the token guard, the subcommands (`owner-code`, `nas-id`) and the settings. |
| `http.ts`, `ranges.ts`, `cors.ts` | Handler types, bounded body reads, `Range` parsing and CORS headers. |
| `library.ts`, `manifest.ts`, `disc-id.ts`, `disc-activity.ts` | The library scan of the roots, disc manifests, stable disc ids, and a note of when a disc was last read. |
| `iso.ts` | Reads `.iso` discs through the UDF reader of `@seikou/bdmv`. |
| `auth.ts`, `store.ts`, `codes.ts`, `rendezvous-client.ts` | People, devices, pairing codes and session tokens; the atomic file store behind them; registering codes with the Worker. |
| `bdj-store.ts`, `tar.ts` | Each person's BD-J saved data, one ustar file per scope. |
| `playback-store.ts`, `player-settings-store.ts` | Each person's resume points and player settings. |
| `subtitle-store.ts`, `subtitle-index.ts` | Uploaded and fansub subtitles with their fonts. |

Folders:

- [`src/routes/`](src/routes): the HTTP routes under `/api/`: pairing, library and folders, discs (manifest, file ranges, probe, quality levels), titles and art, admin actions, resume points, player settings, BD-J saved data, subtitles, Encodes and fansubs.
- [`src/titles/`](src/titles): the title service, which matches discs to titles after each scan, with the disc evidence it reads (`evidence.ts`) and release folder covers (`folder-cover.ts`). The matching rules live in `@seikou/titles`.
- [`src/levels/`](src/levels): quality levels. Level definitions and the byte plan, CLPI and MPLS writers, the ffmpeg encoder and re-muxer, the segment cache, GPU capacity leases and the backend self-test.
- [`src/encodes/`](src/encodes): the Encodes library. The folder index (`index-store.ts`) with its Matroska tag reader, and resumable uploads (`uploads.ts`).
- [`src/fansubs/`](src/fansubs): finding fansub subtitles for a title and lining them up with the owner's discs. It includes the ffmpeg-backed audio decoder the `@seikou/fansubs` package takes as an injected dependency.
- [`src/rtc/`](src/rtc): the WebRTC route: request dispatch from a data channel, peers (werift), one UDP port for every peer, public address discovery, the Worker signalling client and the optional TURN relay switch.

The server uses the workspace packages `@seikou/nas` (the wire contract), `@seikou/titles`, `@seikou/fansubs`, `@seikou/bdmv`, and parts of `@seikou/engine` and `@seikou/ass`. The rest of the server's behaviour is described in [`CLAUDE.md`](../CLAUDE.md).

## Documentation

User and operator docs:

- [`docs/self-hosting.md`](../docs/self-hosting.md): installing the server on your own machine.
- [`docs/nas.md`](../docs/nas.md): using the NAS from the player.

Design specs in [`docs/superpowers/specs/`](../docs/superpowers/specs):

- [`2026-10-17-nas-server-design.md`](../docs/superpowers/specs/2026-10-17-nas-server-design.md): the server, pairing and disc reads.
- [`2026-10-17-nas-library-titles-design.md`](../docs/superpowers/specs/2026-10-17-nas-library-titles-design.md): the title library.
- [`2026-10-18-webrtc-people-design.md`](../docs/superpowers/specs/2026-10-18-webrtc-people-design.md): people, invites, BD-J saved data and the WebRTC route.
- [`2026-10-19-lower-quality-design.md`](../docs/superpowers/specs/2026-10-19-lower-quality-design.md): quality levels.
- [`2026-10-20-permalinks-resume-design.md`](../docs/superpowers/specs/2026-10-20-permalinks-resume-design.md): resume points and the subtitle store.
- [`2026-10-22-music-shelf-design.md`](../docs/superpowers/specs/2026-10-22-music-shelf-design.md): the Music shelf.
- [`2026-10-22-self-hosting-design.md`](../docs/superpowers/specs/2026-10-22-self-hosting-design.md): the published image and self-hosting.
- [`2026-10-23-fansubs-design.md`](../docs/superpowers/specs/2026-10-23-fansubs-design.md): fansub subtitles.
- [`2026-11-08-encodes-library-design.md`](../docs/superpowers/specs/2026-11-08-encodes-library-design.md): the Encodes library.

Licences: [`NOTICE`](NOTICE) covers the server's bundle and the TheDiscDB data, and [`deploy/IMAGE-NOTICE`](deploy/IMAGE-NOTICE) covers the GPL software in the image.

External:

- [Node.js](https://nodejs.org/docs/latest/api/)
- [werift](https://github.com/shinyoshiaki/werift-webrtc), the WebRTC implementation behind `src/rtc/`
- [FFmpeg](https://ffmpeg.org/documentation.html), the encoder behind quality levels
- [Intel media driver](https://github.com/intel/media-driver), for Quick Sync encoding
