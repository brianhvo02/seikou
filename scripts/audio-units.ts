import { execFileSync } from 'node:child_process';
import { AudioFramer } from '@seikou/engine/decode/audio-frames';
import { CLIP_START_PTS } from '../tests/helpers/synthetic-disc';

const TICKS_PER_SAMPLE = 90_000 / 48_000;

export function encodeAudio(codec: string[], layout: 'stereo' | '5.1', seconds: number): Uint8Array {
  return new Uint8Array(execFileSync('ffmpeg', [
    '-v', 'error', '-f', 'lavfi', '-i', `sine=frequency=440:sample_rate=48000:duration=${seconds}`,
    '-af', `volume=2,pan=${layout === 'stereo' ? 'stereo|FL=c0|FR=c0' : '5.1|FL=c0|FR=c0'}`, ...codec, '-',
  ], { maxBuffer: 1 << 28 }));
}

/** One codec frame per PES, timed by sample count from the clip start. */
export function framed(bytes: Uint8Array, kind: 'ac3' | 'dts', ext?: number): Array<{ pts: number; payload: Uint8Array; streamIdExtension?: number }> {
  const frames = new AudioFramer(kind).push(bytes, 0);
  let samples = 0;
  return frames.map((f) => {
    const unit = { pts: CLIP_START_PTS + Math.round(samples * TICKS_PER_SAMPLE), payload: f.data, streamIdExtension: ext };
    samples += f.samples;
    return unit;
  });
}

/** TrueHD access units (length in the first 12 bits, in 16-bit words), 24 per PES. */
export function truehdUnits(bytes: Uint8Array): Array<{ pts: number; payload: Uint8Array; streamIdExtension: number }> {
  const aus: Uint8Array[] = [];
  for (let at = 0; at + 2 <= bytes.length; ) {
    const len = (((bytes[at] & 0x0f) << 8) | bytes[at + 1]) * 2;
    if (len === 0) break;
    aus.push(bytes.subarray(at, at + len));
    at += len;
  }
  const out = [];
  for (let i = 0; i < aus.length; i += 24) {
    const group = aus.slice(i, i + 24);
    const payload = new Uint8Array(group.reduce((n, a) => n + a.length, 0));
    let o = 0;
    for (const a of group) {
      payload.set(a, o);
      o += a.length;
    }
    out.push({ pts: CLIP_START_PTS + Math.round(i * 40 * TICKS_PER_SAMPLE), payload, streamIdExtension: 0x72 });
  }
  return out;
}
