import { OUTPUT_SAMPLE_RATE } from '../audio/ring';
import type { PcmChunk } from './lpcm';

/** Integer-factor decimator (96/192 kHz → 48 kHz) with a Hamming-windowed sinc low-pass, stateful across chunks. */
export class Decimator {
  private readonly coeffs: Float32Array;
  private history: Float32Array;
  private phase = 0;

  constructor(
    readonly factor: number,
    tapsPerPhase = 16,
  ) {
    if (!Number.isInteger(factor) || factor < 2) throw new RangeError(`decimation factor must be an integer ≥ 2, got ${factor}`);
    const taps = tapsPerPhase * factor * 2 + 1;
    const cutoff = 0.45 / factor; // as a fraction of the input rate
    const coeffs = new Float32Array(taps);
    const mid = (taps - 1) / 2;
    let sum = 0;
    for (let n = 0; n < taps; n++) {
      const x = n - mid;
      const sinc = x === 0 ? 2 * cutoff : Math.sin(2 * Math.PI * cutoff * x) / (Math.PI * x);
      const window = 0.54 - 0.46 * Math.cos((2 * Math.PI * n) / (taps - 1));
      coeffs[n] = sinc * window;
      sum += coeffs[n];
    }
    for (let n = 0; n < taps; n++) coeffs[n] /= sum;
    this.coeffs = coeffs;
    this.history = new Float32Array((taps - 1) * 2);
  }

  process(input: PcmChunk): PcmChunk {
    if (input.sampleRate !== this.factor * OUTPUT_SAMPLE_RATE) {
      throw new RangeError(`a ×${this.factor} decimator expects ${this.factor * OUTPUT_SAMPLE_RATE} Hz input, got ${input.sampleRate} Hz`);
    }
    const f = this.factor;
    const taps = this.coeffs.length;
    const historyFrames = this.history.length / 2;
    const total = historyFrames + input.frames;
    const buf = new Float32Array(total * 2);
    buf.set(this.history);
    buf.set(input.stereo.subarray(0, input.frames * 2), this.history.length);

    const firstIndex = (f - this.phase) % f;
    const out = new Float32Array((Math.ceil(input.frames / f) + 1) * 2);
    let frames = 0;
    for (let n = firstIndex; n < input.frames; n += f) {
      const end = historyFrames + n;
      let l = 0;
      let r = 0;
      for (let k = 0; k < taps; k++) {
        const idx = (end - k) * 2;
        l += buf[idx] * this.coeffs[k];
        r += buf[idx + 1] * this.coeffs[k];
      }
      out[frames * 2] = l;
      out[frames * 2 + 1] = r;
      frames++;
    }
    this.phase = (this.phase + input.frames) % f;
    this.history = buf.slice((total - (taps - 1)) * 2);
    return {
      ptsUs: input.ptsUs + (firstIndex * 1e6) / input.sampleRate,
      sampleRate: input.sampleRate / f,
      frames,
      stereo: out.subarray(0, frames * 2),
    };
  }

  reset(): void {
    this.history.fill(0);
    this.phase = 0;
  }
}
