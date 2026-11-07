/** A speech mask over a window of disc audio: energy with an adaptive floor. Pure; original code. */
import type { AudioWindow } from './disc-audio';

const FRAME_SAMPLES = 160; // 10 ms at 16 kHz
const OVER_FLOOR = 10 ** (12 / 20);
const CLOSE_GAP_FRAMES = 20; // gaps under 200 ms are closed
const MIN_RUN_FRAMES = 15; // runs under 150 ms are dropped

/** One byte per 10 ms frame from `window.startMs`: 1 where the frame is speech. */
export function speechMask(window: AudioWindow): Uint8Array {
  const { pcm } = window;
  const frames = Math.floor(pcm.length / FRAME_SAMPLES);
  const rms = new Float64Array(frames);
  for (let f = 0; f < frames; f++) {
    let sum = 0;
    for (let i = f * FRAME_SAMPLES; i < (f + 1) * FRAME_SAMPLES; i++) sum += pcm[i]! * pcm[i]!;
    rms[f] = Math.sqrt(sum / FRAME_SAMPLES);
  }
  const mask = new Uint8Array(frames);
  if (frames === 0) return mask;
  const sorted = Float64Array.from(rms).sort();
  const floor = Math.max(sorted[Math.floor((frames - 1) * 0.2)]!, 1);
  const threshold = floor * OVER_FLOOR;
  for (let f = 0; f < frames; f++) mask[f] = rms[f]! > threshold ? 1 : 0;

  // close short gaps between speech runs
  let f = 0;
  while (f < frames) {
    if (mask[f] === 1) { f++; continue; }
    let end = f;
    while (end < frames && mask[end] === 0) end++;
    if (f > 0 && end < frames && end - f < CLOSE_GAP_FRAMES) mask.fill(1, f, end);
    f = end;
  }
  // drop short runs
  f = 0;
  while (f < frames) {
    if (mask[f] === 0) { f++; continue; }
    let end = f;
    while (end < frames && mask[end] === 1) end++;
    if (end - f < MIN_RUN_FRAMES) mask.fill(0, f, end);
    f = end;
  }
  return mask;
}
