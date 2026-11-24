// SPDX-License-Identifier: LGPL-3.0-or-later

/**
 * A loudspeaker position, named as FFmpeg's `AVChannel` names it (FL front left, FC centre, LFE low frequency, BL back
 * left, SL side left, FLC front left of centre, BC back centre, WL wide left, SDL surround direct left, SSL side
 * surround left, the T… heights and LFE2).
 * @internal
 */
export type Speaker =
  | 'FL' | 'FR' | 'FC' | 'LFE' | 'BL' | 'BR' | 'FLC' | 'FRC' | 'BC' | 'SL' | 'SR'
  | 'TC' | 'TFL' | 'TFC' | 'TFR' | 'TBL' | 'TBC' | 'TBR' | 'TSL' | 'TSR'
  | 'WL' | 'WR' | 'SDL' | 'SDR' | 'SSL' | 'SSR' | 'LFE2' | 'UNKNOWN';

/**
 * The channels of a stream or output, in their order.
 * @internal
 */
export type ChannelLayout = readonly Speaker[];

/** One centre channel. @internal */
export const MONO: ChannelLayout = ['FC'];
/** Front left and right. @internal */
export const STEREO: ChannelLayout = ['FL', 'FR'];
/** Web Audio's 5.1 order (its "SL SR" are the surround pair). @internal */
export const SURROUND_51: ChannelLayout = ['FL', 'FR', 'FC', 'LFE', 'SL', 'SR'];
/** 7.1 in WAVE order, which Web Audio passes on discretely and operating systems use. @internal */
export const SURROUND_71: ChannelLayout = ['FL', 'FR', 'FC', 'LFE', 'BL', 'BR', 'SL', 'SR'];

/** The channel counts the output may have. @internal */
export type OutputChannels = 2 | 6 | 8;

/**
 * How many channels the audio output may use: `auto` as many as the device offers (8 from eight up, 6 from six, else
 * 2), `stereo` two, or a count to use as if the device offered it (capped by what it does offer; for tests).
 * @internal
 */
export type AudioChannelsChoice = 'auto' | 'stereo' | OutputChannels;

/**
 * The layout of an output with `channels` channels: stereo, Web Audio's 5.1 or WAVE 7.1.
 * @internal
 */
export function outputLayout(channels: OutputChannels): ChannelLayout {
  return channels === 8 ? SURROUND_71 : channels === 6 ? SURROUND_51 : STEREO;
}

/**
 * The largest output a device can take, from its `maxChannelCount`: 8 from eight channels up, 6 from six, else 2.
 * @internal
 */
export function outputChannelsFor(maxChannelCount: number): OutputChannels {
  return maxChannelCount >= 8 ? 8 : maxChannelCount >= 6 ? 6 : 2;
}

const AV_CHANNELS: Readonly<Record<number, Speaker>> = {
  0: 'FL', 1: 'FR', 2: 'FC', 3: 'LFE', 4: 'BL', 5: 'BR', 6: 'FLC', 7: 'FRC', 8: 'BC', 9: 'SL', 10: 'SR',
  11: 'TC', 12: 'TFL', 13: 'TFC', 14: 'TFR', 15: 'TBL', 16: 'TBC', 17: 'TBR',
  29: 'FL', 30: 'FR', // stereo downmix channels
  31: 'WL', 32: 'WR', 33: 'SDL', 34: 'SDR', 35: 'LFE2', 36: 'TSL', 37: 'TSR', 41: 'SSL', 42: 'SSR',
};

/**
 * The speaker of an FFmpeg `AVChannel` id; anything without a position here is `UNKNOWN` (dropped by the mix).
 * @internal
 */
export function speakerFromAvChannel(id: number): Speaker {
  return AV_CHANNELS[id] ?? 'UNKNOWN';
}

/** A short name of a layout for people: "mono", "stereo", "5.1", "7.1", else "N channels". @internal */
export function layoutName(layout: ChannelLayout): string {
  const n = layout.length;
  if (n === 1) return 'mono';
  if (n === 2) return 'stereo';
  const lfe = layout.includes('LFE') ? 1 : 0;
  return lfe ? `${n - 1}.1` : `${n}.0`;
}

const K = Math.SQRT1_2;

type Route = ReadonlyArray<readonly [Speaker, number]>;

function stereoRoute(s: Speaker): Route {
  switch (s) {
    case 'FL': return [['FL', 1]];
    case 'FR': return [['FR', 1]];
    case 'FC': return [['FL', K], ['FR', K]];
    case 'BC': case 'TC': case 'TFC': case 'TBC': return [['FL', 0.5], ['FR', 0.5]];
    case 'BL': case 'SL': case 'FLC': case 'WL': case 'SDL': case 'SSL': case 'TFL': case 'TBL': case 'TSL': return [['FL', K]];
    case 'BR': case 'SR': case 'FRC': case 'WR': case 'SDR': case 'SSR': case 'TFR': case 'TBR': case 'TSR': return [['FR', K]];
    default: return []; // LFE, LFE2 and unknown channels are left out of a stereo fold, as before
  }
}

function surroundRoute(s: Speaker, source: ReadonlySet<Speaker>, out: ReadonlySet<Speaker>): Route {
  const hasSides = source.has('SL') || source.has('SR');
  if (out.has(s)) {
    // 5.1 with its surrounds named back goes to the side pair of a 7.1 output (where 5.1 surrounds belong).
    if (out.size === 8 && !hasSides && (s === 'BL' || s === 'BR')) return [[s === 'BL' ? 'SL' : 'SR', 1]];
    return [[s, 1]];
  }
  switch (s) {
    case 'BL': return [['SL', hasSides ? K : 1]];
    case 'BR': return [['SR', hasSides ? K : 1]];
    case 'BC': return out.has('BL') && hasSides ? [['BL', K], ['BR', K]] : [['SL', K], ['SR', K]];
    case 'FLC': return [['FL', K], ['FC', K]];
    case 'FRC': return [['FR', K], ['FC', K]];
    case 'WL': return [['FL', K], ['SL', K]];
    case 'WR': return [['FR', K], ['SR', K]];
    case 'SDL': case 'SSL': return [['SL', 1]];
    case 'SDR': case 'SSR': return [['SR', 1]];
    case 'LFE2': return [['LFE', 1]];
    case 'TFL': return [['FL', K]];
    case 'TFR': return [['FR', K]];
    case 'TFC': case 'TC': return [['FC', K]];
    case 'TSL': return [['SL', K]];
    case 'TSR': return [['SR', K]];
    case 'TBL': return [[out.has('BL') ? 'BL' : 'SL', K]];
    case 'TBR': return [[out.has('BR') ? 'BR' : 'SR', K]];
    case 'TBC': return out.has('BL') ? [['BL', 0.5], ['BR', 0.5]] : [['SL', 0.5], ['SR', 0.5]];
    default: return [];
  }
}

/**
 * The gains that mix `source` into `output`, as an `output.length × source.length` row-major matrix. A speaker the
 * output has passes at 1; others fold (−3 dB) into their neighbours; a fold to stereo keeps the coefficients Seikou
 * has always used (centre and each surround −3 dB, back centre −6 dB, LFE left out, mono to both at full level) and its
 * one normaliser, 1 / max(1, largest row sum). A surround output normalises each speaker's row on its own (1 / its sum
 * when over 1), so a fold into the sides doesn't lower the fronts and centre; nothing folded stays at 1.
 * @internal
 */
export function mixMatrix(source: ChannelLayout, output: ChannelLayout): Float64Array {
  const m = new Float64Array(output.length * source.length);
  const outIndex = new Map<Speaker, number>();
  output.forEach((s, i) => outIndex.set(s, i));
  const sourceSet = new Set(source);
  const outSet = new Set(output);
  const stereo = output.length === 2;
  const mono = source.length === 1 && source[0] === 'FC';
  source.forEach((s, j) => {
    const route: Route = mono && stereo ? [['FL', 1], ['FR', 1]] : stereo ? stereoRoute(s) : surroundRoute(s, sourceSet, outSet);
    for (const [to, gain] of route) {
      const i = outIndex.get(to);
      if (i !== undefined) m[i * source.length + j] += gain;
    }
  });
  if (!mono && stereo) {
    // one normaliser for both sides, as Seikou always folded to stereo
    let max = 1;
    for (let i = 0; i < output.length; i++) max = Math.max(max, rowSum(m, i, source.length));
    if (max > 1) for (let k = 0; k < m.length; k++) m[k] /= max;
  } else if (!mono) {
    // per speaker: only a row that takes a fold (say the sides taking 7.1's backs) is scaled, so the fronts, the
    // centre's dialogue and the LFE keep their level
    for (let i = 0; i < output.length; i++) {
      const sum = rowSum(m, i, source.length);
      if (sum > 1) for (let j = 0; j < source.length; j++) m[i * source.length + j] /= sum;
    }
  }
  return m;
}

function rowSum(m: Float64Array, row: number, width: number): number {
  let sum = 0;
  for (let j = 0; j < width; j++) sum += m[row * width + j];
  return sum;
}

/** Whether two layouts are the same channels in the same order. @internal */
export function sameLayout(a: ChannelLayout, b: ChannelLayout): boolean {
  return a.length === b.length && a.every((s, i) => s === b[i]);
}

/**
 * Mixes `frames` interleaved frames of `sourceCount` channels through `matrix` (from mixMatrix) into a new interleaved
 * buffer of `outCount` channels.
 * @internal
 */
export function applyMix(samples: Float32Array, frames: number, sourceCount: number, matrix: Float64Array, outCount: number): Float32Array {
  const out = new Float32Array(frames * outCount);
  for (let f = 0; f < frames; f++) {
    const src = f * sourceCount;
    const dst = f * outCount;
    for (let i = 0; i < outCount; i++) {
      const row = i * sourceCount;
      let v = 0;
      for (let j = 0; j < sourceCount; j++) {
        const g = matrix[row + j];
        if (g !== 0) v += samples[src + j] * g;
      }
      out[dst + i] = v;
    }
  }
  return out;
}
