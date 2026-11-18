// SPDX-License-Identifier: LGPL-3.0-or-later
/**
 * Writes the elementary streams the WASM video decoder's unit tests read, into packages/engine/src/decode/fixtures/:
 * three one-second MPEG-2 streams from ffmpeg's mpeg2video (1080p at 23.976, 1080i at 29.97 top field first and bottom
 * field first, each with B pictures), and for each, and for fixtures/vc1-sample/interlaced.vc1, the pictures ffprobe
 * reports (`<name>.json`). The 1080p stream's first picture also gets the SHA-256 of its Y plane as ffmpeg's C code
 * decodes it (`-cpuflags 0`, the IDCT video.wasm has; `mpeg2-1080p.first-y.sha256`). Needs ffmpeg and ffprobe on PATH.
 * Usage: npx tsx scripts/make-mpeg2-es.ts
 */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = join(ROOT, 'packages/engine/src/decode/fixtures');
const VC1 = join(ROOT, 'fixtures/vc1-sample/interlaced.vc1');
const VC1_RATE = '30000/1001';

/** One picture as the tests expect it, in presentation order. */
interface ExpectedPicture {
  readonly ptsUs: number;
  readonly interlaced: boolean;
  readonly topFieldFirst: boolean;
  readonly repeatPict: number;
  readonly pictType: string;
  readonly keyFrame: boolean;
}

interface Stream {
  readonly name: string;
  readonly rate: string;
  readonly frames: number;
  readonly field: 'tff' | 'bff' | null;
}

const STREAMS: readonly Stream[] = [
  { name: 'mpeg2-1080p', rate: '24000/1001', frames: 24, field: null },
  { name: 'mpeg2-1080i-tff', rate: '30000/1001', frames: 30, field: 'tff' },
  { name: 'mpeg2-1080i-bff', rate: '30000/1001', frames: 30, field: 'bff' },
];

/** The test picture scripts/mpeg2-video.ts encodes (ffmpeg's testsrc2), at 1080 lines; interlaced streams are coded as fields. */
function encode(s: Stream): Buffer {
  const interlace = s.field ? ['-vf', `setfield=${s.field}`, '-flags', '+ilme+ildct'] : [];
  return execFileSync('ffmpeg', [
    '-v', 'error', '-f', 'lavfi', '-i', `testsrc2=size=1920x1080:rate=${s.rate}`, '-frames:v', String(s.frames),
    ...interlace,
    '-c:v', 'mpeg2video', '-pix_fmt', 'yuv420p', '-g', '12', '-bf', '2', '-q:v', '12', '-f', 'mpeg2video', '-',
  ], { maxBuffer: 1 << 28 });
}

interface ProbeFrame {
  key_frame: number;
  pict_type: string;
  interlaced_frame: number;
  top_field_first: number;
  repeat_pict: number;
}

/** The pictures ffprobe decodes, in presentation order. */
function probe(path: string, inputArgs: readonly string[]): ProbeFrame[] {
  const out = execFileSync('ffprobe', [
    '-v', 'error', ...inputArgs, '-i', path,
    '-show_frames', '-show_entries', 'frame=key_frame,pict_type,interlaced_frame,top_field_first,repeat_pict', '-of', 'json',
  ], { maxBuffer: 1 << 28 });
  return (JSON.parse(out.toString()) as { frames: ProbeFrame[] }).frames;
}

/**
 * The expected pictures. An elementary stream carries no times and ffprobe's are guesses (it puts an open GOP's last
 * I picture before the first), so each picture is timed by its place in presentation order at the stream's rate.
 */
function expected(frames: readonly ProbeFrame[], rate: string): ExpectedPicture[] {
  const [num, den] = rate.split('/').map(Number);
  return frames.map((f, i) => ({
    ptsUs: Math.round((i * 1e6 * den!) / num!),
    interlaced: f.interlaced_frame === 1,
    topFieldFirst: f.top_field_first === 1,
    repeatPict: f.repeat_pict,
    pictType: f.pict_type,
    keyFrame: f.key_frame === 1,
  }));
}

mkdirSync(OUT, { recursive: true });
for (const s of STREAMS) {
  const path = join(OUT, `${s.name}.m2v`);
  writeFileSync(path, encode(s));
  const frames = probe(path, []);
  if (frames.length !== s.frames) throw new Error(`${s.name}: ffprobe saw ${frames.length} pictures, not ${s.frames}`);
  const pictures = expected(frames, s.rate);
  writeFileSync(join(OUT, `${s.name}.json`), `${JSON.stringify(pictures, null, 1)}\n`);
}

const raw = execFileSync('ffmpeg', [
  '-v', 'error', '-cpuflags', '0', '-i', join(OUT, 'mpeg2-1080p.m2v'), '-frames:v', '1', '-f', 'rawvideo', '-pix_fmt', 'yuv420p', '-',
], { maxBuffer: 1 << 28 });
const y = raw.subarray(0, 1920 * 1080);
writeFileSync(join(OUT, 'mpeg2-1080p.first-y.sha256'), `${createHash('sha256').update(y).digest('hex')}\n`);

// The raw VC-1 stream is read at 29.97. It has no B pictures, so the tests push it in decode order with these times.
const vc1 = probe(VC1, ['-framerate', VC1_RATE, '-f', 'vc1']);
if (vc1.some((f) => f.pict_type === 'B')) throw new Error('the VC-1 sample has B pictures; the tests would push them out of order');
const vc1Pictures = expected(vc1, VC1_RATE);
writeFileSync(join(OUT, 'vc1-interlaced.json'), `${JSON.stringify(vc1Pictures, null, 1)}\n`);
