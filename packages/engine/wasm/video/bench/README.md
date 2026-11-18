<!-- SPDX-License-Identifier: LGPL-3.0-or-later -->
<!-- vc1-1080i.vc1 is not: it is CC BY 2.5, by Microdac (2008); see "vc1-1080i.vc1". -->

# Speed probe clips

Two short clips of 1080i video for the video decoder's speed probe: a device decodes them with `video.wasm` to
tell whether it can keep up with a disc's MPEG-2 or VC-1 picture (one untimed pass to warm the module up, then two timed
passes, the better counting). They ship with the package because the engine fetches them at run time.
`npm run fixture:synthetic` rewrites the MPEG-2 clip; the VC-1 clip comes from `scripts/make-vc1-disc.ts`.

## mpeg2-1080i.m2v

An MPEG-2 video elementary stream (`scripts/make-mpeg2-interlaced-disc.ts`): 36 pictures (1.2 s) at 29.97, 1920x1080,
interlaced, top field first, at about 25 Mb/s as a disc's video is (3.8 MB), with two B pictures between reference
pictures and open GOPs of 12. It is ffmpeg's `mpeg2video` over the test source `testsrc2` with temporal noise, so the
bits are real picture data and not stuffing. It was generated for this repository and has no third-party content.

## vc1-1080i.vc1

A VC-1 Advanced Profile elementary stream (15 frames, 0.5 s, 1920x1080 interlaced, top field first, about 5 Mb/s, 368 KB; a disc's is 25 to 35, so the probe asks 2 times the frame rate of it) in SMPTE 421M Annex E form (`scripts/make-vc1-disc.ts`): the first 15 frames
of `fixtures/vc1-sample/interlaced.vc1`, from its sequence and entry point headers through the end of
the 15th frame, with no re-encode. Every picture is field-coded. The stream carries no timing; read it at 30000/1001.

- Work: "Stumpy Lake forest in HD" by Microdac, 2008
- Source: https://archive.org/details/MicrodacStumpyLakeforestinHD
- Licence: Creative Commons Attribution 2.5 Generic, http://creativecommons.org/licenses/by/2.5/
- Changes: the video was cut from the original file and shortened to 15 frames (the cut was made by Seikou; the
  sample's own README, in `fixtures/vc1-sample/`, says how its source was cut).
