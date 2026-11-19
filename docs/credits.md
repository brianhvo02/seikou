# Credits

Seikou is free software under the [GNU Lesser General Public License, version 3 or later](https://www.gnu.org/licenses/lgpl-3.0.html). The source is on [GitHub](https://github.com/brianhvo02/seikou). It stands on other people's work, and this page names it: what each piece does here, who made it and the licence it comes under. The full licence text of every package bundled into this site, and the notices of the ported and vendored works, are in [third-party-licenses.txt](https://bluray.pages.dev/third-party-licenses.txt) (the NAS server's image carries its own copy). The same notices are in the NOTICE files in the source (`packages/*/NOTICE`, `packages/bdj/NOTICE`, `packages/bdj-classlib/NOTICE`, `packages/bdj/wasm/freetype/NOTICE`, `server/NOTICE`, `fixtures/NOTICE`).

## Playing discs

- [libbluray](https://www.videolan.org/developers/libbluray.html), by John Stebbins, Petri Hintukainen and the VideoLAN contributors, [LGPL 2.1 or later](https://www.gnu.org/licenses/old-licenses/lgpl-2.1.html). Seikou's readers for a disc's index, playlists, clips and menus, its menu engine and its BD-J support are ports of libbluray's code to TypeScript.
- [libudfread](https://code.videolan.org/videolan/libudfread), by VLC authors and VideoLAN, [LGPL 2.1 or later](https://www.gnu.org/licenses/old-licenses/lgpl-2.1.html). Seikou's reader for ISO disc images follows it.
- [FFmpeg](https://ffmpeg.org), by the FFmpeg developers, [LGPL 2.1 or later](https://www.gnu.org/licenses/old-licenses/lgpl-2.1.html). Its decoders, compiled to WebAssembly, play Dolby Digital, Dolby Digital Plus, DTS (and the core of TrueHD and DTS-HD) and the MPEG-2 and VC-1 video that browsers can't decode.
- [TheDiscDB](https://github.com/TheDiscDb/data), by Luke Foust and its contributors. Seikou ships an index built from its data, [MIT](https://opensource.org/license/mit), which names a disc and its episodes. Its way of fingerprinting a disc follows the code of [TheDiscDb/web](https://github.com/TheDiscDb/web), [Apache License 2.0](https://www.apache.org/licenses/LICENSE-2.0); no code is copied.

## Menus (BD-J)

- [libbluray's BD-J Java stack](https://www.videolan.org/developers/libbluray.html), [LGPL 2.1 or later](https://www.gnu.org/licenses/old-licenses/lgpl-2.1.html). The Java classes that run a BD-J disc's menus.
- [OpenJDK 8](https://openjdk.org), by Oracle and the OpenJDK contributors, [GPL version 2 with the Classpath Exception](https://openjdk.org/legal/gplv2+ce.html). The part of Java's class library BD-J discs need.
- [Apache Xerces](https://xerces.apache.org), by the Apache Software Foundation, [Apache License 2.0](https://www.apache.org/licenses/LICENSE-2.0). The XML reader inside that class library.
- [SAX](http://www.saxproject.org), by David Megginson and the SAX project, public domain. The XML interfaces inside it.
- [ICU4J](https://icu.unicode.org), by IBM and others, under the [Unicode licence](https://github.com/unicode-org/icu/blob/main/icu4c/LICENSE) today and, for the ICU4J 4.4 classes bundled here, the ICU permission notice kept in `packages/bdj-classlib/THIRD_PARTY_ICU` in the source. Text normalisation inside it.
- [FreeType](https://freetype.org), under the [FreeType License](https://freetype.org/license.html). Draws the text in BD-J menus.

Portions of this software are copyright © 2023 The FreeType Project (www.freetype.org). All rights reserved.

## Subtitles

- [libass](https://github.com/libass/libass), by the libass contributors, [ISC License](https://github.com/libass/libass/blob/master/COPYING). Seikou's ASS subtitle renderer is a port of it, so that styled subtitles look as they do in other players.
- [SeaDex](https://seadex.moe/) and [Anime Tosho](https://animetosho.org). Where the NAS finds the best fansub releases of a title and their subtitle tracks and fonts. Fansub tracks belong to the groups who made them.
- [7-Zip](https://www.7-zip.org), by Igor Pavlov, in the [7z-wasm](https://github.com/use-strict/7z-wasm) build by Alexandru Ciuca, under the GNU LGPL with the unRAR restriction ([7-Zip's licence](https://www.7-zip.org/license.txt)). Unpacks those tracks and font archives.

## Picture

- [Anime4K](https://github.com/bloc97/Anime4K), by bloc97, [MIT](https://github.com/bloc97/Anime4K/blob/master/LICENSE). The shaders and settings behind the built-in upscaling sets in the Shaders menu.

## Fonts and logo

- [Instrument Sans](https://github.com/Instrument/instrument-sans), by The Instrument Sans Project Authors, with the [Fontsource](https://fontsource.org) package, [SIL Open Font License 1.1](https://openfontlicense.org). The app's typeface.
- [DejaVu Sans](https://dejavu-fonts.github.io), by Bitstream, Tavmjong Bah (the Arev glyphs) and the DejaVu contributors, under the [DejaVu fonts licence](https://dejavu-fonts.github.io/License.html). The fallback font for subtitles and menus.
- [Noto Serif CJK JP](https://github.com/notofonts/noto-cjk) and Noto Sans CJK JP, by Google and Adobe, [SIL Open Font License 1.1](https://openfontlicense.org). The lettering of the logo (青光 and Seikou) is drawn from their glyphs.

## The app

- [React](https://react.dev), by Meta and its contributors, [MIT](https://opensource.org/license/mit). The interface.
- [qrcode-generator](https://github.com/kazuhikoarase/qrcode-generator), by Kazuhiko Arase, [MIT](https://opensource.org/license/mit). The QR codes for pairing.
- [Workbox](https://github.com/GoogleChrome/workbox), by Google, [MIT](https://opensource.org/license/mit). Keeps the app working offline.

## Test material

- "[Stumpy Lake forest in HD](https://archive.org/details/MicrodacStumpyLakeforestinHD)" by Microdac (2008), licensed under [Creative Commons Attribution 2.5 Generic](https://creativecommons.org/licenses/by/2.5/). Seikou uses a short excerpt, cut from the video without re-encoding, to time how fast this device decodes VC-1 video. It is changed from the original: a cut of 15 frames, with no audio.

## The NAS server

- [werift](https://github.com/shinyoshiaki/werift-webrtc), by shinyoshiaki, [MIT](https://opensource.org/license/mit). WebRTC, for playing from the NAS away from home.
- [FFmpeg](https://ffmpeg.org) (Debian's build, [GPL 2 or later](https://www.gnu.org/licenses/old-licenses/gpl-2.0.html)). Re-encodes a disc at a lower quality. It runs as a separate program in the server image, and its source is available as the image's notice describes.
- [Intel media driver](https://github.com/intel/media-driver) (MIT, with parts under BSD-3-Clause), and the oneVPL runtime, [vpl-gpu-rt](https://github.com/intel/vpl-gpu-rt) with its [dispatcher](https://github.com/intel/libvpl) (MIT). Let that FFmpeg use the NAS's graphics chip.
- [Node.js](https://nodejs.org), [MIT](https://github.com/nodejs/node/blob/main/LICENSE). What the server runs on.
- [AniList](https://anilist.co) ([terms](https://docs.anilist.co/guide/terms-of-use)), [TMDB](https://www.themoviedb.org), [MusicBrainz](https://musicbrainz.org) with the [Cover Art Archive](https://coverartarchive.org), and [Discogs](https://www.discogs.com). Titles, posters and covers for the library. This product uses the TMDB API but is not endorsed or certified by TMDB.

Thank you to everyone above, and to everyone whose work they build on.
