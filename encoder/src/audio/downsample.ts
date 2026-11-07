// SPDX-License-Identifier: LGPL-3.0-or-later

// Alignment compares speech in 16 kHz mono, and VapourSynth has no resampler, so the conversion is
// done here: average the channels, low-pass, keep every `factor`-th sample. The low-pass is a
// windowed-sinc FIR (the ideal low-pass impulse response sin(2πfc·n)/(πn), truncated and shaped by
// a Hamming window; see Smith, "The Scientist and Engineer's Guide to Digital Signal Processing",
// chapter 16, "Windowed-Sinc Filters"). Its
// cutoff of 7 kHz sits below the new Nyquist frequency of 8 kHz, so the Hamming window's transition
// band (about 3.3 / taps of the source rate wide) ends near 8 kHz and what would alias is
// attenuated by some 50 dB. Speech detection only needs the band up to about 4 kHz.
//
// The filter is applied centred (zero phase): output sample n is the filtered input at sample
// n·factor, with silence assumed before the start and after the end, so timing is exact and the
// output has ceil(input / factor) samples.

/** The output rate, in Hz. */
const TARGET_RATE = 16_000;
const CUTOFF_HZ = 7_000;
/** Taps per unit of decimation factor; the transition band is then about 1.6 kHz wide at any source rate. */
const TAPS_PER_FACTOR = 32;

function lowPass(sourceRate: number, factor: number): Float32Array {
  const taps = TAPS_PER_FACTOR * Math.max(2, factor) + 1;
  const mid = (taps - 1) / 2;
  const fc = CUTOFF_HZ / sourceRate;
  const h = new Float64Array(taps);
  let sum = 0;
  for (let i = 0; i < taps; i++) {
    const n = i - mid;
    const sinc = n === 0 ? 2 * fc : Math.sin(2 * Math.PI * fc * n) / (Math.PI * n);
    const hamming = 0.54 - 0.46 * Math.cos((2 * Math.PI * i) / (taps - 1));
    h[i] = sinc * hamming;
    sum += h[i];
  }
  // Unity gain at 0 Hz, so speech keeps its level.
  return Float32Array.from(h, (v) => v / sum);
}

/**
 * Streams multichannel audio down to 16 kHz mono 16-bit PCM: channels averaged, low-passed at
 * 7 kHz with a windowed-sinc filter (at least 65 taps), decimated by `sourceRate / 16000`. Output
 * sample n lines up with input frame `n × factor` (no filter delay), and the whole stream gives
 * `ceil(frames / factor)` samples once `flush` has been called. Feed it `push`, then `flush` once.
 */
export class Downsampler16k {
  private readonly factor: number;
  private readonly h: Float32Array;
  private readonly half: number;
  /** Mono input not yet consumed; `pending[0]` is input frame `pendingStart` (negative while it holds the leading silence). */
  private pending = new Float32Array(0);
  private pendingLength = 0;
  private pendingStart: number;
  /** Input frames pushed so far. */
  private consumed = 0;
  /** Index of the next output sample. */
  private nextOut = 0;

  /** Throws `RangeError` unless `sourceRate` is a positive multiple of 16 kHz (48, 96 and 192 kHz are). */
  constructor(sourceRate: number) {
    const factor = sourceRate / TARGET_RATE;
    if (!Number.isInteger(factor) || factor < 1) {
      throw new RangeError(`Cannot decimate ${sourceRate} Hz to 16 kHz: the rate is not a whole multiple of 16000`);
    }
    this.factor = factor;
    this.h = lowPass(sourceRate, factor);
    this.half = (this.h.length - 1) / 2;
    // Leading silence, so the first outputs are centred on frame 0.
    this.append(new Float32Array(this.half));
    this.pendingStart = -this.half;
  }

  /** Takes one plane per channel (all the same length) and returns the 16 kHz samples now complete. */
  push(planar: Float32Array[]): Int16Array {
    const frames = planar[0]?.length ?? 0;
    const mono = new Float32Array(frames);
    for (const plane of planar) for (let i = 0; i < frames; i++) mono[i] += plane[i];
    if (planar.length > 1) for (let i = 0; i < frames; i++) mono[i] /= planar.length;
    this.consumed += frames;
    this.append(mono);
    return this.drain(this.pendingStart + this.pendingLength);
  }

  /** Returns the last samples, treating the input as followed by silence. Call once, after the last `push`. */
  flush(): Int16Array {
    this.append(new Float32Array(this.half));
    const out = this.drain(this.pendingStart + this.pendingLength, Math.ceil(this.consumed / this.factor));
    this.pendingLength = 0;
    return out;
  }

  private append(samples: Float32Array): void {
    if (this.pendingLength + samples.length > this.pending.length) {
      const grown = new Float32Array(Math.max(this.pendingLength + samples.length, this.pending.length * 2));
      grown.set(this.pending.subarray(0, this.pendingLength));
      this.pending = grown;
    }
    this.pending.set(samples, this.pendingLength);
    this.pendingLength += samples.length;
  }

  /** Computes every output whose filter span ends before input frame `available`, up to output `limit`. */
  private drain(available: number, limit = Infinity): Int16Array {
    const { factor, h, half } = this;
    const taps = h.length;
    const outputs: number[] = [];
    for (;;) {
      const centre = this.nextOut * factor;
      if (this.nextOut >= limit || centre + half >= available) break;
      const at = centre - half - this.pendingStart;
      let acc = 0;
      for (let k = 0; k < taps; k++) acc += h[k] * this.pending[at + k];
      outputs.push(acc >= 1 ? 32767 : acc <= -1 ? -32767 : Math.round(acc * 32767));
      this.nextOut++;
    }
    // Drop input no later output needs.
    const keepFrom = this.nextOut * factor - half - this.pendingStart;
    if (keepFrom > 0) {
      const drop = Math.min(keepFrom, this.pendingLength);
      this.pending.copyWithin(0, drop, this.pendingLength);
      this.pendingLength -= drop;
      this.pendingStart += drop;
    }
    return Int16Array.from(outputs);
  }
}
