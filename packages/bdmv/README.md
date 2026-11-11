# @seikou/bdmv

The Blu-ray disc format, read without a player. This package parses a disc's files and demuxes its video and audio, so a browser player, a server and the tests can all read a disc with the same code. It takes its input as bytes or a `ByteSource`, so it runs in a page, a worker or Node.

The reference, with an example for every function, is at [/developers/bdmv](https://bluray.pages.dev/developers/bdmv).

## Modules

All of it lives in `src/`. The package root exports the names listed in `public-api.txt`; every module can also be imported by path (`@seikou/bdmv/<module>`), and what the root leaves out is internal and can change without notice.

| Module | What it does |
| --- | --- |
| `index-parser.ts` (`parseIndex`) | `index.bdmv`: the disc's titles and its First Play and Top Menu objects. |
| `mpls-parser.ts` (`parseMpls`) | Playlists (`.mpls`): play items, sub paths, marks and the stream tables. |
| `clpi-parser.ts` (`parseClpi`) | Clip information (`.clpi`): stream attributes and the EP map used to seek. |
| `mobj-parser.ts` (`parseMovieObjects`) | `MovieObject.bdmv`: HDMV navigation commands. |
| `bdjo-parser.ts` (`parseBdjo`) | BD-J object files. |
| `sound-parser.ts` (`parseSoundBdmv`) | `sound.bdmv`: menu sounds. |
| `bdid-parser.ts` (`parseBdid`) | `id.bdmv`: the disc ID. |
| `version.ts`, `stream-types.ts` | The file header check (internal) and the `CodingType` constants for stream coding types. |
| `byte-reader.ts`, `byte-source.ts` | `ParseError`, which the parsers throw (their internal `ByteReader` reads through `@seikou/bdmv/byte-reader`), and the `ByteSource` interface through which disc bytes are read. |
| `udf.ts` (`readUdf`, `UdfImage`) | A read-only UDF reader for ISO images. |
| `demux/` | The M2TS demuxer: 192-byte source packets (`parseSourcePacket`), TS packets, and `PesAssembler`, driven by `M2tsReader`. |
| `codecs/` | The H.264 and HEVC parameter-set readers that name a WebCodecs codec (`avcCodecString`, `hevcCodecString`); NAL unit scanning is internal. |

## What a consumer must provide

Nothing beyond the bytes. Pass a `Uint8Array` to a parser, or implement `ByteSource` (`exists`, `size`, `list`, `read`, and an optional `peek`) to read a disc from folders, a server or an ISO.

## Usage

```ts
import { readFile } from 'node:fs/promises';
import { parseClpi, parseIndex, parseMpls, readUdf } from '@seikou/bdmv';

const bytes = async (path: string) => new Uint8Array(await readFile(`${disc}/${path}`)); // disc: a folder that holds BDMV/
const index = parseIndex(await bytes('BDMV/index.bdmv')); // index.firstPlay, index.titles
const playlist = parseMpls(await bytes('BDMV/PLAYLIST/00000.mpls'));
for (const item of playlist.playItems) {
  const clip = parseClpi(await bytes(`BDMV/CLIPINF/${item.clipId}.clpi`)); // clip.programs, clip.epMaps
  console.log(item.clipId, (item.outTime - item.inTime) / 45_000, 'seconds'); // 45 kHz clip time
}

// An ISO image: read(offset, length) returns that range of the image.
const files = await readUdf(read); // [{ path: 'BDMV/INDEX.BDMV', size, extents }, ...]
```

## Documentation

- Using the packages in your own page or tool: the integration guide, [`docs/integrating.md`](../../docs/integrating.md).
- The design spec is `docs/superpowers/specs/2026-10-12-bluray-web-player-design.md`, and the package split is in `docs/superpowers/specs/2026-11-07-packages-design.md` (both in the Seikou repository).
- `NOTICE` lists each file derived from [libbluray](https://www.videolan.org/developers/libbluray.html) and from [libudfread](https://code.videolan.org/videolan/libudfread). `byte-reader.ts` is original.
