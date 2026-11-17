import { execFileSync } from 'node:child_process';

/** Splits an Annex-B stream at access unit delimiters (NAL type 9). */
export function splitAccessUnits(stream: Uint8Array): Uint8Array[] {
  const starts: number[] = [];
  for (let i = 0; i + 3 < stream.length; i++) {
    if (stream[i] === 0 && stream[i + 1] === 0 && stream[i + 2] === 1 && (stream[i + 3] & 0x1f) === 9) {
      starts.push(i > 0 && stream[i - 1] === 0 ? i - 1 : i);
    }
  }
  return starts.map((s, k) => stream.subarray(s, k + 1 < starts.length ? starts[k + 1] : stream.length));
}

/**
 * IDR every 24 frames, no B-frames, AUD before every access unit, SPS/PPS repeated at every IDR. `size` is the
 * picture's width x height (16:9 by default) and `rate` the source frame rate (`24`, or a fraction such as
 * `'30000/1001'`). An `-x264-params` pair in `extraArgs` is merged into the fixed parameters, since ffmpeg takes one.
 */
export function encodeTestVideo(frames: number, size = '640x360', extraArgs: string[] = [], rate: number | string = 24): Uint8Array[] {
  const args = [...extraArgs];
  let params = 'keyint=24:min-keyint=24:scenecut=0:bframes=0:aud=1:repeat-headers=1';
  const at = args.indexOf('-x264-params');
  if (at >= 0) {
    params += `:${args[at + 1]}`;
    args.splice(at, 2);
  }
  const h264 = execFileSync('ffmpeg', [
    '-v', 'error', '-f', 'lavfi', '-i', `testsrc2=size=${size}:rate=${rate}`, '-frames:v', String(frames),
    '-c:v', 'libx264', '-profile:v', 'high', '-level', '4.1', '-pix_fmt', 'yuv420p',
    '-x264-params', params, ...args, '-f', 'h264', '-',
  ], { maxBuffer: 1 << 30 });
  const aus = splitAccessUnits(new Uint8Array(h264));
  if (aus.length !== frames) throw new Error(`expected ${frames} access units, got ${aus.length}`);
  return aus;
}
