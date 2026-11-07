import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { CodingType } from '@seikou/bdmv/stream-types';
import { clearSegments, subtitleSegments } from '../tests/helpers/pg-builders';
import { CLIP_START_PTS, buildSyntheticDisc, type SyntheticAudioStream, type SyntheticPgStream } from '../tests/helpers/synthetic-disc';
import { encodeAudio, framed, truehdUnits } from './audio-units';
import { writeFixture } from './fixture-dir';
import { encodeTestVideo } from './x264';

// The discs that the NAS's quality levels are tested with: a 1080i MPEG-2 disc, and a 1080p H.264 disc with the extra streams
// (TrueHD with an AC-3 core, an AC-3 commentary, a picture-in-picture secondary video, two PG streams) that a re-encode has to drop or keep.

const root = process.argv[2];
if (!root) {
  console.error('usage: tsx scripts/make-level-discs.ts <fixtures/synthetic>');
  process.exit(1);
}

const SECONDS = 10;
/** 1080i and 1080p format codes, and the 29.97 and 23.976 fps codes, of the STN and CLPI stream attributes. */
const FORMAT_1080I = 4;
const FORMAT_1080P = 6;
const RATE_29_97 = 4;
const RATE_23_976 = 1;
const FRAME_TICKS_29_97 = 3003;

/** Splits an MPEG-2 elementary stream into pictures; a picture takes the sequence and GOP headers in front of it. */
function splitPictures(stream: Uint8Array): Uint8Array[] {
  const starts: number[] = [];
  let hasPicture = false;
  for (let i = 0; i + 3 < stream.length; i++) {
    if (stream[i] !== 0 || stream[i + 1] !== 0 || stream[i + 2] !== 1) continue;
    const code = stream[i + 3];
    if (code === 0xb3 || code === 0xb8 || code === 0x00) {
      if (starts.length === 0 || hasPicture) {
        starts.push(i);
        hasPicture = false;
      }
      if (code === 0x00) hasPicture = true;
    }
  }
  return starts.map((s, k) => stream.subarray(s, k + 1 < starts.length ? starts[k + 1] : stream.length));
}

/** 1080i29.97 MPEG-2, top field first, a closed GOP of 30 frames (1.001 s) and no B-frames. */
function encodeMpeg2(frames: number): Uint8Array[] {
  const es = execFileSync('ffmpeg', [
    '-v', 'error', '-f', 'lavfi', '-i', 'testsrc2=size=1920x1080:rate=30000/1001', '-frames:v', String(frames),
    '-c:v', 'mpeg2video', '-pix_fmt', 'yuv420p', '-b:v', '2000k', '-maxrate', '2000k', '-bufsize', '1835008', '-qmax', '31',
    '-g', '30', '-bf', '0', '-sc_threshold', '1000000000', '-flags', '+ildct+ilme+bitexact+cgop', '-vf', 'setfield=tff','-threads', '1',
    '-f', 'mpeg2video', '-',
  ], { maxBuffer: 1 << 30 });
  const pictures = splitPictures(new Uint8Array(es));
  if (pictures.length !== frames) throw new Error(`expected ${frames} MPEG-2 pictures, got ${pictures.length}`);
  return pictures;
}

function mpeg2Disc(): Map<string, Uint8Array<ArrayBuffer>> {
  const frames = Math.round(SECONDS * 30_000 / 1001);
  const ac3 = encodeAudio(['-c:a', 'ac3', '-b:a', '192k', '-f', 'ac3', '-flags', '+bitexact'], 'stereo', SECONDS);
  return buildSyntheticDisc({
    clips: [{
      clipId: '00001',
      videoAus: encodeMpeg2(frames),
      keyIndices: Array.from({ length: Math.ceil(frames / 30) }, (_, i) => i * 30),
      startPts: CLIP_START_PTS,
      frameTicks: FRAME_TICKS_29_97,
      videoCodingType: CodingType.MPEG2_VIDEO,
      videoFormat: FORMAT_1080I,
      videoRate: RATE_29_97,
      audioStreams: [{ pid: 0x1100, codingType: CodingType.AC3, lang: 'eng', format: 3, units: framed(ac3, 'ac3') }],
    }],
    playlists: [{ id: '00000', clipIds: ['00001'], chapterEverySeconds: 5 }],
    index: { firstPlay: { kind: 'hdmv', movieObjectId: 0 }, topMenu: { kind: 'hdmv', movieObjectId: 0 }, titles: [{ kind: 'hdmv', movieObjectId: 0 }] },
  });
}

const at = (seconds: number, segments: Uint8Array[]) => segments.map((payload) => ({ pts: CLIP_START_PTS + seconds * 90_000, payload }));

function pgStream(pid: number, lang: string, x: number): SyntheticPgStream {
  return {
    pid,
    lang,
    units: [
      ...at(1, subtitleSegments({ objectId: 0, x, y: 900, w: 120, h: 40, compositionNumber: 0 })),
      ...at(3, clearSegments(1)),
      ...at(5, subtitleSegments({ objectId: 1, x, y: 880, w: 160, h: 48, compositionNumber: 2 })),
      ...at(7, clearSegments(3)),
    ],
  };
}

function levelsDisc(): Map<string, Uint8Array<ArrayBuffer>> {
  const frames = SECONDS * 24;
  const core = encodeAudio(['-c:a', 'ac3', '-b:a', '192k', '-f', 'ac3', '-flags', '+bitexact'], 'stereo', SECONDS);
  const mlp = encodeAudio(['-c:a', 'truehd', '-strict', '-2', '-f', 'truehd', '-flags', '+bitexact'], 'stereo', SECONDS);
  const commentary = encodeAudio(['-c:a', 'ac3', '-b:a', '96k', '-f', 'ac3', '-flags', '+bitexact'], 'stereo', SECONDS);
  const audioStreams: SyntheticAudioStream[] = [
    {
      pid: 0x1100,
      codingType: CodingType.TRUEHD,
      lang: 'eng',
      format: 3,
      units: [...framed(core, 'ac3', 0x76), ...truehdUnits(mlp)].sort((a, b) => a.pts - b.pts || (a.streamIdExtension === 0x76 ? -1 : 1)),
    },
    { pid: 0x1101, codingType: CodingType.AC3, lang: 'eng', format: 3, units: framed(commentary, 'ac3') },
  ];
  return buildSyntheticDisc({
    clips: [{
      clipId: '00001',
      videoAus: encodeTestVideo(frames, '1920x1080', ['-b:v', '800k', '-maxrate', '800k', '-bufsize', '1600k', '-flags', '+bitexact', '-threads', '1']),
      keyIndices: Array.from({ length: SECONDS }, (_, i) => i * 24),
      startPts: CLIP_START_PTS,
      videoFormat: FORMAT_1080P,
      videoRate: RATE_23_976,
      secondaryVideo: [{ pid: 0x1b00, videoAus: encodeTestVideo(frames, '320x180', ['-b:v', '60k', '-maxrate', '60k', '-bufsize', '120k', '-flags', '+bitexact', '-threads', '1']) }],
      audioStreams,
      pgStreams: [pgStream(0x1200, 'eng', 400), pgStream(0x1201, 'jpn', 700)],
    }],
    playlists: [{ id: '00000', clipIds: ['00001'], chapterEverySeconds: 5 }],
    index: { firstPlay: { kind: 'hdmv', movieObjectId: 0 }, topMenu: { kind: 'hdmv', movieObjectId: 0 }, titles: [{ kind: 'hdmv', movieObjectId: 0 }] },
  });
}

for (const [name, files] of [['disc-mpeg2', mpeg2Disc()], ['disc-levels', levelsDisc()]] as const) {
  writeFixture(join(root, name), files);
  console.log(`wrote ${files.size} files to ${join(root, name)}`);
}
