// SPDX-License-Identifier: LGPL-3.0-or-later
import { execFileSync } from 'node:child_process';

/** Splits an Annex-B H.265 stream at access unit delimiters (NAL type 35). */
function splitAccessUnits(stream: Uint8Array): Uint8Array[] {
  const starts: number[] = [];
  for (let i = 0; i + 3 < stream.length; i++) {
    if (stream[i] === 0 && stream[i + 1] === 0 && stream[i + 2] === 1 && ((stream[i + 3] >> 1) & 0x3f) === 35) {
      starts.push(i > 0 && stream[i - 1] === 0 ? i - 1 : i);
    }
  }
  return starts.map((s, k) => stream.subarray(s, k + 1 < starts.length ? starts[k + 1] : stream.length));
}

const HDR10_PARAMS =
  'hdr10=1:hdr10-opt=1:colorprim=bt2020:transfer=smpte2084:colormatrix=bt2020nc:' +
  'master-display=G(13250,34500)B(7500,3000)R(34000,16000)WP(15635,16450)L(10000000,1):max-cll=1000,400';

/**
 * HEVC Main10 test video at 24 fps: an IDR every second, no B-frames, an AUD before every access unit and the
 * parameter sets repeated at every IDR. With `hdr`, the stream carries HDR10 signalling (BT.2020, PQ, mastering
 * display and content light level). `size` is the picture's width x height (16:9 by default).
 */
export function encodeHevcTestVideo(frames: number, size = '640x360', hdr = false): Uint8Array[] {
  const params = ['keyint=24', 'min-keyint=24', 'scenecut=0', 'bframes=0', 'aud=1', 'repeat-headers=1', 'log-level=error'];
  if (hdr) params.push(HDR10_PARAMS);
  const hevc = execFileSync('ffmpeg', [
    '-v', 'error', '-f', 'lavfi', '-i', `testsrc2=size=${size}:rate=24`, '-frames:v', String(frames),
    '-c:v', 'libx265', '-pix_fmt', 'yuv420p10le', '-profile:v', 'main10',
    '-x265-params', params.join(':'), '-f', 'hevc', '-',
  ], { maxBuffer: 1 << 30 });
  const aus = splitAccessUnits(new Uint8Array(hevc));
  if (aus.length !== frames) throw new Error(`expected ${frames} access units, got ${aus.length}`);
  return aus;
}
