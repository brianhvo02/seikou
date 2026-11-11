# Documentation

Seikou's documentation, by module. The player pages are also on the site under [/help](https://bluray.pages.dev/help).

## Player

For people watching discs in the browser.

- [Getting started](getting-started.md): supported browsers, opening a disc, installing the app, offline use.
- [Playing discs](playing-discs.md): menus, audio and subtitles, shaders, controls, resume.
- [Troubleshooting](troubleshooting.md): the notices the player shows and what to do about each.
- Code: [src/README.md](../src/README.md), and the engine packages below.

## NAS server and pairing

For people who stream a library from a NAS, and for whoever runs the server.

- [NAS](nas.md): pairing, the title library, the Encodes library, quality levels, playing from away, and the owner's settings.
- [Run your own server](self-hosting.md): Docker, HTTPS, the rendezvous Worker and the optional relay.
- Code: [server/README.md](../server/README.md) and [rendezvous/README.md](../rendezvous/README.md).

## Encoder

For turning a disc's episodes into AV1 and Opus MKVs, and sending them to the NAS.

- [encoder/README.md](../encoder/README.md): requirements, the commands, the app, pairing with the NAS, and the guides the encode settings follow.
- One README per part: [audio](../encoder/src/audio/README.md), [disc](../encoder/src/disc/README.md), [mux](../encoder/src/mux/README.md), [nas](../encoder/src/nas/README.md), [package](../encoder/src/package/README.md), [pipeline](../encoder/src/pipeline/README.md), [plan](../encoder/src/plan/README.md), [server](../encoder/src/server/README.md), [subs](../encoder/src/subs/README.md) and the [web app](../encoder/web/README.md).
- Design specs and plans: [encoder/docs/superpowers/](../encoder/docs/superpowers).

## Packages

The `@seikou/*` packages, each with what it does, its modules, what a consumer provides and its references.

- [@seikou/bdmv](../packages/bdmv/README.md): the Blu-ray format, ISO images and the M2TS demuxer.
- [@seikou/engine](../packages/engine/README.md): the player engine.
- [@seikou/pg](../packages/pg/README.md): PG subtitles.
- [@seikou/ass](../packages/ass/README.md): the ASS renderer.
- [@seikou/matroska](../packages/matroska/README.md): Matroska and WebM writing and reading.
- [@seikou/titles](../packages/titles/README.md): library naming and metadata.
- [@seikou/fansubs](../packages/fansubs/README.md): finding and timing fansub subtitles.
- [@seikou/nas](../packages/nas/README.md): the wire contract between the server, the app and the Worker.

## Development tools

- [tools/vm-trace](../tools/vm-trace/README.md), [tools/bdj-trace](../tools/bdj-trace/README.md) and [tools/ass-trace](../tools/ass-trace/README.md): compare our HDMV, BD-J and ASS ports with libbluray and libass.
- [tools/bdj-library](../tools/bdj-library/README.md): the BD-J library check.
- [tools/disc-server](../tools/disc-server/README.md): a development server that speaks the NAS's disc API.
- [tools/devices](../tools/devices/README.md): device automation over WebDriver.

## The project

- [Contributing](contributing.md): commands, tests and conventions.
- [Roadmap](roadmap.md): what comes next.
- [Known issues](known-issues.md): limits left open on purpose, and resolved ones.
- Design specs: [docs/superpowers/specs/](superpowers/specs) for the player, server and packages.
- [CLAUDE.md](../CLAUDE.md): the layout and conventions in depth.
