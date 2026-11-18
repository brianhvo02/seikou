import { execFileSync } from 'node:child_process';

const SEQUENCE_HEADER = 0xb3;
const GOP_HEADER = 0xb8;
const PICTURE = 0x00;

/**
 * Splits an MPEG-2 video elementary stream into access units: each starts at its picture start code, or at the sequence
 * or GOP header in front of it.
 */
export function splitPictures(stream: Uint8Array): Uint8Array[] {
  const starts: number[] = [];
  let headerAt = -1;
  for (let i = 0; i + 3 < stream.length; i++) {
    if (stream[i] !== 0 || stream[i + 1] !== 0 || stream[i + 2] !== 1) continue;
    const code = stream[i + 3];
    if ((code === SEQUENCE_HEADER || code === GOP_HEADER) && headerAt < 0) headerAt = i;
    if (code === PICTURE) {
      starts.push(headerAt >= 0 ? headerAt : i);
      headerAt = -1;
    }
  }
  return starts.map((s, k) => stream.subarray(s, k + 1 < starts.length ? starts[k + 1] : stream.length));
}

/**
 * MPEG-2 video (ffmpeg's mpeg2video, which browsers can't decode): an I picture every second at 24 fps with a sequence
 * header before it, no B pictures (decode order is display order). `size` is width x height.
 */
export function encodeMpeg2TestVideo(frames: number, size = '640x360'): Uint8Array[] {
  const es = execFileSync('ffmpeg', [
    '-v', 'error', '-f', 'lavfi', '-i', `testsrc2=size=${size}:rate=24`, '-frames:v', String(frames),
    '-c:v', 'mpeg2video', '-pix_fmt', 'yuv420p', '-g', '24', '-bf', '0', '-q:v', '10', '-f', 'mpeg2video', '-',
  ], { maxBuffer: 1 << 30 });
  const aus = splitPictures(new Uint8Array(es));
  if (aus.length !== frames) throw new Error(`expected ${frames} pictures, got ${aus.length}`);
  for (let i = 0; i < frames; i += 24) {
    if (aus[i]![3] !== SEQUENCE_HEADER) throw new Error(`picture ${i} does not start a GOP with a sequence header`);
  }
  return aus;
}
