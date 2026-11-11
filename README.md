<p align="center"><img src="public/logo.svg" alt="Seikou" width="200"></p>

# Seikou

[![CI](https://github.com/brianhvo02/seikou/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/brianhvo02/seikou/actions/workflows/ci.yml)
[![WASM](https://github.com/brianhvo02/seikou/actions/workflows/wasm.yml/badge.svg?branch=main)](https://github.com/brianhvo02/seikou/actions/workflows/wasm.yml)
[![VM trace](https://github.com/brianhvo02/seikou/actions/workflows/vm-trace.yml/badge.svg?branch=main)](https://github.com/brianhvo02/seikou/actions/workflows/vm-trace.yml)
[![BD-J trace](https://github.com/brianhvo02/seikou/actions/workflows/bdj-trace.yml/badge.svg?branch=main)](https://github.com/brianhvo02/seikou/actions/workflows/bdj-trace.yml)
[![BD-J class library](https://github.com/brianhvo02/seikou/actions/workflows/bdj-classlib.yml/badge.svg?branch=main)](https://github.com/brianhvo02/seikou/actions/workflows/bdj-classlib.yml)
[![ASS trace](https://github.com/brianhvo02/seikou/actions/workflows/ass-trace.yml/badge.svg?branch=main)](https://github.com/brianhvo02/seikou/actions/workflows/ass-trace.yml)
[![License: LGPL-3.0-or-later](https://img.shields.io/badge/license-LGPL--3.0--or--later-blue)](LICENSE)
[![Try it](https://img.shields.io/badge/try%20it-bluray.pages.dev-brightgreen)](https://bluray.pages.dev)

Seikou (青光, "blue light": a pun on Blu-ray) is a Blu-ray player that runs in your browser. It plays decrypted disc folders with their menus (HDMV and BD-J), subtitles and audio tracks, on desktop and on phones. Nothing is uploaded: the disc is read on your device, and an optional server on your own NAS can stream a whole library to it.

The repository also holds an encoder, `seikou-encode`, which cuts a disc's playlist into episodes and encodes each one to AV1 and Opus in an MKV, with chapters, the disc's subtitles and lined-up fansub subtitles. It can send the episodes to the NAS, where the player's Encodes library plays them.

## Get started

1. Open [bluray.pages.dev](https://bluray.pages.dev).
2. Pick a disc folder (a decrypted `BDMV` disc, or the folder that holds it).
3. Or pair the player with a NAS server, if you or a friend run one.

Supported browsers: Safari 26 (macOS, iOS, iPadOS), Chrome and Firefox on desktop (stable and stable−2), and Chrome on Android. Firefox on Android is not supported. The player works by touch, installs as an app and runs offline.

## What's in the repository

| Module | What it does | Read more |
| --- | --- | --- |
| Player app ([`src/`](src)) | The web app at bluray.pages.dev: screens, the NAS client, help pages, the service worker, and the BD-J runtime (a JVM in TypeScript that runs a disc's Java menus). | [src/README.md](src/README.md) |
| [`@seikou/bdmv`](packages/bdmv) | Reads the Blu-ray format: index, playlists, clip info, movie and BD-J objects, ISO images (UDF), and the M2TS demuxer. | [README](packages/bdmv/README.md) |
| [`@seikou/engine`](packages/engine) | The player engine: navigation, HDMV menus, decoding with WebCodecs, audio, subtitles and shaders, in a worker. | [README](packages/engine/README.md) |
| [`@seikou/pg`](packages/pg) | Blu-ray PG (bitmap) subtitles: decoding and drawing. | [README](packages/pg/README.md) |
| [`@seikou/ass`](packages/ass) | An ASS/SSA subtitle renderer ported from libass. | [README](packages/ass/README.md) |
| [`@seikou/matroska`](packages/matroska) | Writes and reads Matroska and WebM files. | [README](packages/matroska/README.md) |
| [`@seikou/titles`](packages/titles) | Names a disc library: folder-name parsing, AniList, TMDB, TheDiscDB and music lookups, and the catalogue of shows. | [README](packages/titles/README.md) |
| [`@seikou/fansubs`](packages/fansubs) | Finds fansub subtitles (SeaDex, Anime Tosho) and lines them up with a disc's audio. | [README](packages/fansubs/README.md) |
| [`@seikou/nas`](packages/nas) | The wire contract the server, the app and the Worker share: API types, disc keys, pairing codes, WebRTC framing. | [README](packages/nas/README.md) |
| NAS server ([`server/`](server)) | Serves your discs and encodes over HTTPS or WebRTC, sorts them into titles, re-encodes at lower quality on the GPU, and keeps each person's places and saved data. | [server/README.md](server/README.md) |
| Rendezvous Worker ([`rendezvous/`](rendezvous)) | A Cloudflare Worker that turns a pairing code into the NAS's address and relays WebRTC signalling. | [rendezvous/README.md](rendezvous/README.md) |
| Encoder ([`encoder/`](encoder)) | `seikou-encode`: episodes from a disc to AV1 and Opus MKVs, with a local web app for grouping chapters, subtitles and the encode queue. | [encoder/README.md](encoder/README.md) |
| Tools ([`tools/`](tools)) | Comparison harnesses against libbluray and libass, the BD-J library check, the development disc server and device automation. | Each folder's README |

## Documentation

The [documentation index](docs/README.md) lists every page by module. In short:

- Player: [Getting started](docs/getting-started.md), [Playing discs](docs/playing-discs.md) and [Troubleshooting](docs/troubleshooting.md). These pages are also on the site under [/help](https://bluray.pages.dev/help).
- NAS server: [NAS](docs/nas.md) for pairing, the title library, quality levels and playing from away; [Run your own server](docs/self-hosting.md); and [server/README.md](server/README.md) for the code.
- Encoder: [encoder/README.md](encoder/README.md) covers its use, and each folder under [`encoder/src/`](encoder/src) has a README of its own.
- Packages: each package's README, linked in the table above, and the [integration guide](docs/integrating.md) for using them in your own page or tool.
- The project: [Contributing](docs/contributing.md), the [roadmap](docs/roadmap.md), [known issues](docs/known-issues.md), the design specs in [`docs/superpowers/specs/`](docs/superpowers/specs) and [`encoder/docs/superpowers/specs/`](encoder/docs/superpowers/specs), and [CLAUDE.md](CLAUDE.md), which describes the layout and conventions in depth.

## Run your own server

The NAS server runs in Docker next to your discs, behind your own HTTPS address. It serves discs, lists them by title and keeps each person's resume points and saved data. See [docs/self-hosting.md](docs/self-hosting.md).

## Encode episodes

The encoder runs on your computer with VapourSynth (with BestSource), SvtAv1EncApp and opusenc installed. `npm run seikou-encode -- app` opens its web app: pick a disc (from a folder or from a paired NAS), group its chapters into episodes while the playlist plays, choose subtitles, and queue the encode. See [encoder/README.md](encoder/README.md).

## Contributing

Commands and tests are in [docs/contributing.md](docs/contributing.md). [CLAUDE.md](CLAUDE.md) describes how the project is laid out, and its conventions, in depth.

## Built on

Seikou stands on a lot of other work. Each entry links to the project and, where one applies, names its licence.

### Ported from

Code this project translates to TypeScript (the files are listed in the NOTICE files of [packages/bdmv](packages/bdmv/NOTICE), [packages/pg](packages/pg/NOTICE), [packages/ass](packages/ass/NOTICE) and [packages/engine](packages/engine/NOTICE), and in [src/bdj/NOTICE](src/bdj/NOTICE)).

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
- [Instrument Sans](https://github.com/Instrument/instrument-sans) (through `@fontsource-variable/instrument-sans`), SIL Open Font License 1.1: the app's typeface, bundled with the site.
- libbluray's BD-J Java stack, as jars (`libbluray-j2se`, `libbluray-awt-j2se`), LGPL-2.1-or-later.
- The `cacerts` keystore in the class library, generated from Ubuntu's ca-certificates ([src/bdj-classlib/NOTICE](src/bdj-classlib/NOTICE)).
- [TheDiscDB data](https://github.com/TheDiscDb/data), MIT: the server's disc index (`server/data/discdb-index.json`).
- [React](https://react.dev) (with react-dom), MIT: the user interface.
- [qrcode-generator](https://github.com/kazuhikoarase/qrcode-generator), MIT: pairing QR codes.
- [werift](https://github.com/shinyoshiaki/werift-webrtc), MIT: WebRTC in the server, with the packages it uses, under their own licences (see [server/NOTICE](server/NOTICE)).
- [Workbox](https://github.com/GoogleChrome/workbox) (precaching and routing), MIT: the service worker.
- [FFmpeg](https://ffmpeg.org) 7.1, Debian's GPL-2.0-or-later build, in the server image for quality levels. It runs as a separate process. [server/deploy/IMAGE-NOTICE](server/deploy/IMAGE-NOTICE) says where its source is.
- [Intel media driver](https://github.com/intel/media-driver) and [oneVPL](https://github.com/intel/libvpl), MIT: hardware encoding for that ffmpeg.
- [Node.js](https://nodejs.org), MIT: the server image's base.
- [7z-wasm](https://github.com/use-strict/7z-wasm), 7-Zip compiled to WebAssembly under 7-Zip's licence (GNU LGPL with the unRAR restriction): unpacks fansub tracks and font archives on the server and in the encoder.

### Run by the encoder

The encoder starts these as separate processes and links none of them. They are installed by the user, not shipped.

- [VapourSynth](https://www.vapoursynth.com) ([docs](https://www.vapoursynth.com/doc/)), LGPL-2.1-or-later, with [BestSource](https://github.com/vapoursynth/bestsource), MIT: frame-exact decoding of the disc's video and audio.
- [SVT-AV1](https://gitlab.com/AOMediaCodec/SVT-AV1), BSD-3-Clause-Clear with the AOMedia patent licence: the AV1 encoder (`SvtAv1EncApp`).
- [opus-tools](https://opus-codec.org/docs/opus-tools/opusenc.html), BSD-2-Clause: the Opus encoder (`opusenc`).

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
- [SeaDex](https://releases.moe) (its API at seadex.moe) and [Anime Tosho](https://animetosho.org): the best fansub releases of a title, and their subtitle tracks and fonts.
- [Cloudflare](https://www.cloudflare.com): Pages (the site), Workers and Durable Objects (the pairing rendezvous) and TURN (the optional relay).

### Guides and specifications

Documentation the design follows, beyond the upstream code above.

- [JET Encoding Guide](https://jaded-encoding-thaumaturgy.github.io/JET-guide/master/): the encoder's SVT-AV1 settings (presets, variance boost, film grain, tiles, `--sharpness 1 --luminance-qp-bias 25`) and the filter order planned for later.
- [Codec Wiki](https://wiki.x266.mov/): its SVT-AV1 deep dives on an anime corpus ([part 1](https://wiki.x266.mov/blog/svt-av1-fourth-deep-dive-p1), [part 2](https://wiki.x266.mov/blog/svt-av1-fourth-deep-dive-p2)), the [Opus](https://wiki.x266.mov/docs/audio/Opus) page and the [colorimetry](https://wiki.x266.mov/docs/colorimetry/intro) pages.
- [SilentAperture's Advanced Encoding Guide](https://silentaperture.gitlab.io/mdbook-guide/): the method behind the encoder's [test encodes](https://silentaperture.gitlab.io/mdbook-guide/encoding/testing.html).
- [guide.encode.moe](https://guide.encode.moe/) (Irrational Encoding Wizardry): the Opus rates for stereo and 5.1, and never re-encoding lossy audio.
- [Matroska element specification](https://www.matroska.org/technical/elements.html) (RFC 9559) and [WebM](https://www.webmproject.org/docs/container/): what `@seikou/matroska` writes and reads.
- [WebCodecs](https://www.w3.org/TR/webcodecs/): the decoders the engine uses.
- [AniList API](https://docs.anilist.co) and [TMDB API](https://developer.themoviedb.org): title lookups.

### Tools

- [Vite](https://vite.dev) with [vite-plugin-pwa](https://github.com/vite-pwa/vite-plugin-pwa) and [@vitejs/plugin-react](https://github.com/vitejs/vite-plugin-react), [TypeScript](https://www.typescriptlang.org), [esbuild](https://esbuild.github.io), [tsx](https://github.com/privatenumber/tsx) and [marked](https://marked.js.org) (the help pages): the build.
- [Emscripten](https://emscripten.org) (`emscripten/emsdk`): builds the two WASM modules.
- [Docker](https://www.docker.com) with Ubuntu 24.04 images, and [OpenJDK 8](https://openjdk.org) (HotSpot): the libbluray, libass and class library harnesses.
- [Wrangler](https://developers.cloudflare.com/workers/wrangler/): deploys the Worker.

## License

LGPL-3.0-or-later for everything that doesn't carry its own licence (see [LICENSE](LICENSE), and [COPYING](COPYING) for the GNU GPL it supplements). Files ported from libbluray, libudfread and FFmpeg stay LGPL-2.1-or-later, as their upstreams released them, and the libass ports are `LGPL-2.1-or-later AND ISC`; their headers say so. Files marked LGPL-2.1-or-later are under the LGPL 2.1 ([LICENSES/LGPL-2.1.txt](LICENSES/LGPL-2.1.txt)) or, at your option, any later version, which lets the whole be distributed under version 3. Other third-party files keep their own licences (see Built on and the NOTICE files). Exceptions by directory:

- `src/bdj-classlib/`: GPLv2 with the Classpath Exception, with the Apache, SAX and ICU notices its [NOTICE](src/bdj-classlib/NOTICE) lists.
- `src/wasm/freetype/`: the FreeType License.
- `src/ui/anime4k/` and `fixtures/shaders/anime4k/`: MIT (Anime4K).
- `packages/ass/src/default-font.ttf` and `fixtures/ass/fonts/`: the DejaVu licence.
- `fixtures/bdj-fonts/` and `fixtures/synthetic/disc-bdj-menu/` (Source Sans 3): SIL Open Font License 1.1.
- `server/data/discdb-index.json`: MIT (TheDiscDB data).
- `public/tmdb-logo.svg`: TMDB's logo, used for attribution only.
- `public/logo.svg` and `public/favicon.svg`: the lettering is outlines of [Noto Serif CJK JP](https://github.com/notofonts/noto-cjk) Black (青光) and Noto Sans CJK JP Bold (Seikou), SIL Open Font License 1.1.

The server image also contains ffmpeg (GPL-2.0-or-later); see [server/deploy/IMAGE-NOTICE](server/deploy/IMAGE-NOTICE).
