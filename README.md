# 青光 Seikou

[![CI](https://github.com/brianhvo02/seikou/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/brianhvo02/seikou/actions/workflows/ci.yml)
[![WASM](https://github.com/brianhvo02/seikou/actions/workflows/wasm.yml/badge.svg?branch=main)](https://github.com/brianhvo02/seikou/actions/workflows/wasm.yml)
[![VM trace](https://github.com/brianhvo02/seikou/actions/workflows/vm-trace.yml/badge.svg?branch=main)](https://github.com/brianhvo02/seikou/actions/workflows/vm-trace.yml)
[![BD-J trace](https://github.com/brianhvo02/seikou/actions/workflows/bdj-trace.yml/badge.svg?branch=main)](https://github.com/brianhvo02/seikou/actions/workflows/bdj-trace.yml)
[![BD-J class library](https://github.com/brianhvo02/seikou/actions/workflows/bdj-classlib.yml/badge.svg?branch=main)](https://github.com/brianhvo02/seikou/actions/workflows/bdj-classlib.yml)
[![ASS trace](https://github.com/brianhvo02/seikou/actions/workflows/ass-trace.yml/badge.svg?branch=main)](https://github.com/brianhvo02/seikou/actions/workflows/ass-trace.yml)
[![License: LGPL-2.1-or-later](https://img.shields.io/badge/license-LGPL--2.1--or--later-blue)](LICENSE)
[![Try it](https://img.shields.io/badge/try%20it-bluray.pages.dev-brightgreen)](https://bluray.pages.dev)

**青光** (*Seikou*, "blue light": a pun on Blu-ray) is a Blu-ray player that runs in your browser. It plays decrypted disc folders with their menus (HDMV and BD-J), subtitles and audio tracks, on desktop and on phones. Nothing is uploaded: the disc is read on your device, and an optional server on your own NAS can stream a whole library to it.

## Get started

1. Open [bluray.pages.dev](https://bluray.pages.dev).
2. Pick a disc folder (a decrypted `BDMV` disc, or the folder that holds it).
3. Or pair the player with a NAS server, if you or a friend run one.

Supported browsers: Safari 26 (macOS, iOS, iPadOS), Chrome and Firefox on desktop (stable and stable−2), and Chrome on Android. Firefox on Android is not supported. The player works by touch, installs as an app and runs offline.

## Documentation

- [Getting started](docs/getting-started.md): browsers, opening a disc, installing, offline use.
- [Playing discs](docs/playing-discs.md): menus, audio and subtitles, shaders, controls, resume.
- [NAS](docs/nas.md): pairing, the title library, quality levels, playing from away.
- [Troubleshooting](docs/troubleshooting.md): the notices you may see and what to do.
- [Run your own server](docs/self-hosting.md)
- [Contributing](docs/contributing.md)
- [Roadmap](docs/roadmap.md): what comes next.

The player pages (all but Contributing) are also on the site under [/help](https://bluray.pages.dev/help); Contributing stays on GitHub.

## Run your own server

The NAS server runs in Docker next to your discs, behind your own HTTPS address. It serves discs, lists them by title and keeps each person's resume points and saved data. See [docs/self-hosting.md](docs/self-hosting.md).

## Contributing

Commands and tests are in [docs/contributing.md](docs/contributing.md). [CLAUDE.md](CLAUDE.md) describes how the project is laid out, and its conventions, in depth.

## Built on

Seikou stands on a lot of other work. Each entry links to the project and, where one applies, names its licence.

### Ported from

Code this project translates to TypeScript (the files are listed in [src/engine/NOTICE](src/engine/NOTICE)).

- [libbluray](https://www.videolan.org/developers/libbluray.html), LGPL-2.1-or-later: the C library's disc parsing, navigation, HDMV virtual machine, menus, and BD-J glue and natives.
- [libudfread](https://code.videolan.org/videolan/libudfread), LGPL-2.1-or-later: the UDF reader for ISO discs.
- [libass](https://github.com/libass/libass), ISC: the ASS subtitle renderer.
- [DoppioJVM](https://github.com/plasma-umass/doppio), MIT: parts of the JVM.
- fdlibm 5.3, the C library behind the JDK's StrictMath (Sun Microsystems, free to use with its notice): `exp` and `remainder` in the JVM.
- [FFmpeg](https://ffmpeg.org), LGPL-2.1-or-later: the Blu-ray LPCM decoder.

Followed, with no code copied: [libplacebo](https://code.videolan.org/videolan/libplacebo) (mpv user shader behaviour) and [TheDiscDB](https://github.com/TheDiscDb/web) (Apache-2.0; the disc fingerprint algorithm).

### Bundled

Shipped inside the app, the server image or the Worker.

- [FFmpeg](https://ffmpeg.org) n9.0.2 AC-3, E-AC-3 and DTS decoders, LGPL-2.1-or-later, compiled to `audio.wasm`.
- [FreeType](https://freetype.org) 2.13.2, FreeType License, compiled to `freetype.wasm` for BD-J text.
- The OpenJDK 8 class library (GPLv2 with the Classpath Exception), trimmed for BD-J, with [Apache Xerces](https://xerces.apache.org) (Apache-2.0), the [SAX](http://www.saxproject.org) classes (public domain notice) and ICU4J-derived classes ([ICU](https://icu.unicode.org)), as listed in [src/bdj-classlib/NOTICE](src/bdj-classlib/NOTICE).
- [Anime4K](https://github.com/bloc97/Anime4K) v4.0.1, MIT: the shaders and mode definitions behind the built-in shader sets.
- [DejaVu Sans](https://dejavu-fonts.github.io) 2.37, Bitstream Vera / DejaVu licence: the fallback font for ASS subtitles and BD-J text.
- libbluray's BD-J Java stack, as jars (`libbluray-j2se`, `libbluray-awt-j2se`), LGPL-2.1-or-later.
- The `cacerts` keystore in the class library, generated from Ubuntu's ca-certificates ([src/bdj-classlib/NOTICE](src/bdj-classlib/NOTICE)).
- [TheDiscDB data](https://github.com/TheDiscDb/data), MIT: the server's disc index (`server/data/discdb-index.json`).
- [React](https://react.dev) (with react-dom), MIT: the user interface.
- [qrcode-generator](https://github.com/kazuhikoarase/qrcode-generator), MIT: pairing QR codes.
- [werift](https://github.com/shinyoshiaki/werift-webrtc), MIT: WebRTC in the server, with the packages it uses, under their own licences (see [server/NOTICE](server/NOTICE)).
- [Workbox](https://github.com/GoogleChrome/workbox) (precaching and routing), MIT: the service worker.
- [jellyfin-ffmpeg](https://github.com/jellyfin/jellyfin-ffmpeg) 7, GPL-3.0-or-later, in the server image for quality levels. It runs as a separate process. [server/deploy/IMAGE-NOTICE](server/deploy/IMAGE-NOTICE) has the source and its bundled libraries, and the server image is not to be redistributed.
- [Intel media driver](https://github.com/intel/media-driver) and [oneVPL](https://github.com/intel/libvpl), MIT: hardware encoding inside jellyfin-ffmpeg.
- [Node.js](https://nodejs.org), MIT: the server image's base.

### Used in tests

In the repository, not shipped.

- [DejaVu fonts](https://dejavu-fonts.github.io), Bitstream Vera / DejaVu licence: ASS test fonts in `fixtures/ass/`.
- [Source Sans 3](https://github.com/adobe-fonts/source-sans), SIL Open Font License 1.1: the BD-J test disc's font in `fixtures/bdj-fonts/`.
- [Anime4K](https://github.com/bloc97/Anime4K), MIT: shader parser test data in `fixtures/shaders/anime4k/`.
- [TheDiscDB data](https://github.com/TheDiscDb/data), MIT: test vectors.
- [Playwright](https://playwright.dev), [Vitest](https://vitest.dev), [pixelmatch](https://github.com/mapbox/pixelmatch) and [fake-indexeddb](https://github.com/dumbmatter/fakeIndexedDB): the test runners and helpers.

### Services and data

- [AniList](https://anilist.co): anime titles and art, under its [terms](https://docs.anilist.co/guide/terms-of-use).
- [TMDB](https://www.themoviedb.org): film and series titles and art. This product uses the TMDB API but is not endorsed or certified by TMDB.
- [TheDiscDB](https://github.com/TheDiscDb/data): disc fingerprints to titles, MIT.
- [MusicBrainz](https://musicbrainz.org), the [Cover Art Archive](https://coverartarchive.org) and [Discogs](https://www.discogs.com): music lookups and covers.
- [Cloudflare](https://www.cloudflare.com): Pages (the site), Workers and Durable Objects (the pairing rendezvous) and TURN (the optional relay).

### Tools

- [Vite](https://vite.dev) with [vite-plugin-pwa](https://github.com/vite-pwa/vite-plugin-pwa) and [@vitejs/plugin-react](https://github.com/vitejs/vite-plugin-react), [TypeScript](https://www.typescriptlang.org), [esbuild](https://esbuild.github.io), [tsx](https://github.com/privatenumber/tsx) and [marked](https://marked.js.org) (the help pages): the build.
- [Emscripten](https://emscripten.org) (`emscripten/emsdk`): builds the two WASM modules.
- [Docker](https://www.docker.com) with Ubuntu 24.04 images, and [OpenJDK 8](https://openjdk.org) (HotSpot): the libbluray, libass and class library harnesses.
- [Wrangler](https://developers.cloudflare.com/workers/wrangler/): deploys the Worker.

## License

LGPL-2.1-or-later for everything that doesn't carry its own licence (see [LICENSE](LICENSE)). Third-party files keep theirs (see Built on and the NOTICE files). Exceptions by directory:

- `src/bdj-classlib/`: GPLv2 with the Classpath Exception, with the Apache, SAX and ICU notices its [NOTICE](src/bdj-classlib/NOTICE) lists.
- `src/wasm/freetype/`: the FreeType License.
- `src/ui/anime4k/` and `fixtures/shaders/anime4k/`: MIT (Anime4K).
- `src/engine/ass/default-font.ttf` and `fixtures/ass/fonts/`: the DejaVu licence.
- `fixtures/bdj-fonts/` and `fixtures/synthetic/disc-bdj-menu/` (Source Sans 3): SIL Open Font License 1.1.
- `server/data/discdb-index.json`: MIT (TheDiscDB data).
- `public/tmdb-logo.svg`: TMDB's logo, used for attribution only.

The server image also contains jellyfin-ffmpeg (GPL-3.0); see [server/deploy/IMAGE-NOTICE](server/deploy/IMAGE-NOTICE).
