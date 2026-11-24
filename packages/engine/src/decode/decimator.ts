import { OUTPUT_SAMPLE_RATE } from '../audio/ring';
import type { PcmChunk } from './lpcm';

/** Integer-factor decimator (96/192 kHz → 48 kHz) with a Hamming-windowed sinc low-pass, stateful across chunks. */
export class Decimator {
  private readonly coeffs: Float32Array;
  /** The last taps − 1 input frames, interleaved, for the channel count of the last chunk. */
  private history: Float32Array;
  private channels = 2;
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
    this.history = new Float32Array((taps - 1) * this.channels);
  }

  /** Filters and decimates one chunk of any channel count (a change of channel count starts the filter afresh). */
  process(input: PcmChunk): PcmChunk {
    if (input.sampleRate !== this.factor * OUTPUT_SAMPLE_RATE) {
      throw new RangeError(`a ×${this.factor} decimator expects ${this.factor * OUTPUT_SAMPLE_RATE} Hz input, got ${input.sampleRate} Hz`);
    }
    const f = this.factor;
    const taps = this.coeffs.length;
    const ch = input.channels.length;
    if (ch !== this.channels) {
      this.channels = ch;
      this.history = new Float32Array((taps - 1) * ch);
      this.phase = 0;
    }
    const historyFrames = taps - 1;
    const total = historyFrames + input.frames;
    const buf = new Float32Array(total * ch);
    buf.set(this.history);
    buf.set(input.samples.subarray(0, input.frames * ch), this.history.length);

    const firstIndex = (f - this.phase) % f;
    const out = new Float32Array((Math.ceil(input.frames / f) + 1) * ch);
    const acc = new Float64Array(ch);
    let frames = 0;
    for (let n = firstIndex; n < input.frames; n += f) {
      const end = historyFrames + n;
      acc.fill(0);
      for (let k = 0; k < taps; k++) {
        const idx = (end - k) * ch;
        const c = this.coeffs[k];
        for (let j = 0; j < ch; j++) acc[j] += buf[idx + j] * c;
      }
      for (let j = 0; j < ch; j++) out[frames * ch + j] = acc[j];
      frames++;
    }
    this.phase = (this.phase + input.frames) % f;
    this.history = buf.slice((total - historyFrames) * ch);
    return {
      ptsUs: input.ptsUs + (firstIndex * 1e6) / input.sampleRate,
      sampleRate: input.sampleRate / f,
      frames,
      channels: input.channels,
      samples: out.subarray(0, frames * ch),
    };
  }

  reset(): void {
    this.history.fill(0);
    this.phase = 0;
  }
}
