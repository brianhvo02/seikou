# HDR labels in the NAS library

Status: approved by the owner on 2026-11-16 (short design).

## Intent

The owner browses the NAS title library and wants to see which discs, and which titles, are HDR, telling
Dolby Vision apart from HDR10 (and HDR10+, which the disc flags too). It is a browsing aid for the whole library, not only a way to find test discs for the
element path.

## Goals and non-goals

- Goal: a "DV", "HDR10+" or "HDR10" badge on title tiles and on each disc, read from what the disc itself records.
- Non-goal: Encodes (the encoder writes AV1 SDR). Logos (trademarks): text badges only.
- Anti-goal: a full re-match of the library, or reading clip streams during the scan. The scan stays on small metadata
  files.

## Approaches

- **Chosen: the CLPI's `dynamic_range_type`** of the main playlist's video streams, read during the evidence scan
  and `hdr_plus_flag` (libbluray `clpi_parse.c` `_parse_stream_attr`, HEVC only: `dynamic_range_type` 4 bits, 0 SDR,
  1 HDR10, 2 Dolby Vision, `bluray.h` `bd_dynamic_range_type_e`; then `color_space` 4 bits, `hdr_plus_flag` 1 bit). On
  a Dolby Vision UHD disc the base layer says HDR10 and the enhancement layer's stream says Dolby Vision.
- Rejected: `index.bdmv`'s `initial_dynamic_range_type` (what the disc starts in, not what its main title is).
- Rejected: reading the video's SEI for HDR10+ (needs clip reads in the scan; the CLPI's flag says it).

## Design

- **Scan** (`server/src/titles/evidence.ts`): besides playlists, read the CLPI of each clip of the disc's main title
  (libbluray's choice, `chooseMainTitle`, as the pre-flight uses; CLPI files are a few KB) and record `dynamicRange: 'dv' | 'hdr10plus' | 'hdr10' | null` in the disc's
  evidence: `dv` when any HEVC video stream says 2, else `hdr10plus` when one says 1 with `hdr_plus_flag` set, else
  `hdr10` when one says 1, else null. The CLPI parser in `@seikou/bdmv` gains `dynamicRange` and `hdrPlus` on
  `ProgramStream`, ported from that function.
- **No re-match:** the title service's evidence key (`evidenceKey` in `server/src/titles/service.ts`) leaves
  `dynamicRange` out, so adding it changes no match. Cached evidence without the field is read again once by the next
  scan (small files, at the scan's pace).
- **API** (`@seikou/nas`): `DiscRef` gains `dynamicRange: DynamicRange | null` (`'dv' | 'hdr10plus' | 'hdr10'`);
  `TitleSummary` gains `dynamicRange`, the best of its discs' (`dv` over `hdr10plus` over `hdr10`). Older servers send neither; the app reads a missing
  field as null.
- **Catalogue** (`@seikou/titles`): fills both from the evidence.
- **UI:** a small text badge ("DV", "HDR10+", "HDR10") in the existing badge style on title tiles (the library grid, related
  titles, Continue watching where a title card shows), on disc rows of the season and film screens, and in the NAS
  folder listing and pre-flight, which take it from the disc's manifest (its inlined CLPIs) as they take UHD.
- **Deploy:** the server change ships with a server deploy, which the owner runs.

## Left to the builder

The badge's exact placement on each card; whether the server's level code moves onto the parser's new fields (the server's
`clpiStreamAttrs` or `@seikou/bdmv`'s parser); tests on synthetic discs (`disc-hdr` is HDR10; a DV case can be
a CLPI built by the test builders).
