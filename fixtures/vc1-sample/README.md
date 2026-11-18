<!-- SPDX-License-Identifier: LGPL-3.0-or-later -->
<!-- interlaced.vc1 is not: it is CC BY 2.5, by Microdac (2008); see "Source and licence". -->

# VC-1 sample

`interlaced.vc1` is a VC-1 Advanced Profile elementary stream, interlaced 1080i, for the tests of the WASM MPEG-2 and
VC-1 decoder. ffmpeg can't encode VC-1, so it is cut, with no re-encode, from footage published by its author under a
Creative Commons licence. It holds video only.

## Source and licence

- Work: "Stumpy Lake forest in HD" by Microdac, 2008
- Page: https://archive.org/details/MicrodacStumpyLakeforestinHD
- File: https://archive.org/download/MicrodacStumpyLakeforestinHD/Stumpy.wmv (186,127,308 bytes, MD5
  `829d239c4c0a3d6ba9e32c00f76aa4fd`)
- Licence: Creative Commons Attribution 2.5 Generic (CC BY 2.5), https://creativecommons.org/licenses/by/2.5/ . The
  page shows "Attribution" with the CC badge linking to that licence; the item's metadata names Microdac as creator and
  copyright holder (`copyrightHolder: microdac`, `other_copyright_holders: false`, uploaded by the author), and the file
  record reads "microdac 2008 . Licensed to the public under http://creativecommons.org/licenses/by/2.5/".

## What was changed

`interlaced.vc1` is frames 1800 to 1979 (0-based, 180 frames, three whole 60-frame groups of pictures) of the file's
WVC1 video track, from 63.130 s to 69.136 s of the original, about 6 s at 29.97 frames a second. The audio was left
out. The coded pictures are the original's bytes: the stream is the track's sequence and entry-point headers (the ASF
extradata without its first byte) followed by each frame's payload behind a frame start code (`00 00 01 0D`), the SMPTE
421M Annex E form Blu-ray carries. ffmpeg's `vc1` raw muxer (`-c copy -f vc1`) copies the ASF payloads as they are,
with no headers or frame start codes, so the cut was put together from its output with a short script that adds them.
Decoded with ffmpeg, its 180 pictures are bit-identical (framemd5) to frames 1800 to 1979 decoded from the original.

## Facts

- 3,764,425 bytes, SHA-256 `38c707009843f067dad1e8e3994da0c39a81ea22a31a1533ff1342b3789b1100`
- VC-1 Advanced Profile, level 3, 1920x1080, square pixels (16:9)
- Interlaced, top field first; every picture is field-coded (FCM field interlace): each group starts with an I/P field
  pair and the rest are P/P field pairs; no B pictures
- The stream carries no timing; the original is 30000/1001 frames a second (ffprobe reads a raw `.vc1` as 25)

No progressive VC-1 Advanced Profile sample with a stated licence was found, so there is no `progressive.vc1`.
