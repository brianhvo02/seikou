// SPDX-License-Identifier: LGPL-3.0-or-later
import { avcCodecString } from '@seikou/bdmv/codecs/h264';
import { hevcCodecStrings } from '@seikou/bdmv/codecs/hevc';
import { readHdrSei } from '@seikou/bdmv/codecs/hdr-sei';
import type { ContentLight, MasteringDisplay } from '@seikou/bdmv/codecs/hdr-sei';
import { readAvcSps, readHevcSps, splitNalUnits } from '@seikou/bdmv/codecs/param-sets';
import type { ColourDescription, ParameterSets, SampleAspectRatio } from '@seikou/bdmv/codecs/param-sets';

/**
 * The timescale of the track and of every tick count in this module (the 90 kHz clock the disc's PTS uses).
 * @internal
 */
export const TIMESCALE = 90_000;

/**
 * What the init segment needs to know about a video stream.
 * @internal
 */
export interface VideoTrack {
  coding: 'avc' | 'hevc';
  params: ParameterSets;
  /** The codec string for `MediaSource.addSourceBuffer` (`avc1.…` or `hvc1.…`). */
  codec: string;
  /** The coded picture's width, after cropping. */
  width: number;
  /** The coded picture's height, after cropping. */
  height: number;
  /** The SPS's colour description, or null when it has none (written as `colr` of type `nclx`). */
  colour: ColourDescription | null;
  /** The SPS's sample aspect ratio, 1:1 when it gives none (written as `pasp`). */
  sar: SampleAspectRatio;
  /** The mastering display SEI of the first access unit (written as `mdcv`), or null. */
  mastering: MasteringDisplay | null;
  /** The content light level SEI of the first access unit (written as `clli`), or null. */
  light: ContentLight | null;
}

/**
 * Builds the track description from a stream's parameter sets (the first SPS gives the codec string, the size, the
 * colour and the aspect) and, for H.265, the HDR metadata in the prefix SEI of `accessUnit` (Annex B), the access unit
 * the parameter sets came from.
 * @internal
 */
export function videoTrack(coding: 'avc' | 'hevc', params: ParameterSets, accessUnit?: Uint8Array): VideoTrack {
  const sps = params.sps[0];
  if (!sps) throw new Error('no SPS in the parameter sets');
  if (coding === 'avc') {
    const info = readAvcSps(sps);
    return { coding, params, codec: avcCodecString(sps), width: info.width, height: info.height, colour: info.colour, sar: info.sar, mastering: null, light: null };
  }
  const info = readHevcSps(sps);
  const hdr = accessUnit ? readHdrSei(splitNalUnits(accessUnit)) : { mastering: null, light: null };
  return { coding, params, codec: hevcCodecStrings(sps)[0], width: info.width, height: info.height, colour: info.colour, sar: info.sar, ...hdr };
}

/**
 * The size the picture shows at: the coded width scaled by the sample aspect ratio (rounded), and the coded height.
 * @internal
 */
export function displaySize(track: VideoTrack): { width: number; height: number } {
  return { width: Math.round((track.width * track.sar.width) / track.sar.height), height: track.height };
}

/**
 * Media time on the video element is playlist time plus this offset, so that no MP4 decode time is negative (a play
 * item's first picture can decode before the item's IN time); the page subtracts it again.
 * @internal
 */
export const ELEMENT_TIME_OFFSET_US = 10_000_000;

/**
 * One coded picture of a media segment.
 * @internal
 */
export interface Fmp4Sample {
  /** The picture's NAL units, each with a 4-byte length in front. */
  data: Uint8Array;
  durationTicks: number;
  /** Presentation time minus decode time, in ticks (may be negative). */
  ctsOffsetTicks: number;
  sync: boolean;
}

type Part = Uint8Array | number[];

function concat(parts: readonly Uint8Array[]): Uint8Array {
  let n = 0;
  for (const p of parts) n += p.length;
  const out = new Uint8Array(n);
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

function u16(v: number): number[] {
  return [(v >>> 8) & 0xff, v & 0xff];
}

function u32(v: number): number[] {
  return [(v >>> 24) & 0xff, (v >>> 16) & 0xff, (v >>> 8) & 0xff, v & 0xff];
}

function u64(v: number): number[] {
  return [...u32(Math.floor(v / 2 ** 32)), ...u32(v % 2 ** 32)];
}

function fourcc(s: string): number[] {
  return [...s].map((c) => c.charCodeAt(0));
}

function box(type: string, ...parts: Part[]): Uint8Array {
  const bodies = parts.map((p) => (p instanceof Uint8Array ? p : Uint8Array.from(p)));
  const size = 8 + bodies.reduce((n, b) => n + b.length, 0);
  return concat([Uint8Array.from([...u32(size), ...fourcc(type)]), ...bodies]);
}

function fullBox(type: string, version: number, flags: number, ...parts: Part[]): Uint8Array {
  return box(type, [version, (flags >>> 16) & 0xff, (flags >>> 8) & 0xff, flags & 0xff], ...parts);
}

const MATRIX = [...u32(0x00010000), ...u32(0), ...u32(0), ...u32(0), ...u32(0x00010000), ...u32(0), ...u32(0), ...u32(0), ...u32(0x40000000)];

function nalList(units: readonly Uint8Array[]): Uint8Array[] {
  return units.flatMap((n) => [Uint8Array.from(u16(n.length)), n]);
}

function avcC(params: ParameterSets): Uint8Array {
  const sps = params.sps[0];
  const info = readAvcSps(sps);
  const tail: Part[] = [];
  if ([100, 110, 122, 144].includes(info.profileIdc)) {
    tail.push([0xfc | info.chromaFormatIdc, 0xf8 | (info.bitDepthLuma - 8), 0xf8 | (info.bitDepthChroma - 8), 0]);
  }
  return box(
    'avcC',
    [1, info.profileIdc, info.constraintFlags, info.levelIdc, 0xfc | 3, 0xe0 | params.sps.length],
    ...nalList(params.sps),
    [params.pps.length],
    ...nalList(params.pps),
    ...tail,
  );
}

function hvcC(params: ParameterSets): Uint8Array {
  const sps = params.sps[0];
  const info = readHevcSps(sps);
  const layers = ((sps[2] >> 1) & 7) + 1;
  const nested = sps[2] & 1;
  const arrays: Part[] = [];
  const groups: [number, Uint8Array[]][] = [[32, params.vps], [33, params.sps], [34, params.pps]];
  const present = groups.filter(([, units]) => units.length > 0);
  for (const [type, units] of present) arrays.push([0x80 | type, ...u16(units.length)], ...nalList(units));
  return box(
    'hvcC',
    [1, (info.profileSpace << 6) | (info.tierFlag << 5) | info.profileIdc, ...u32(info.compatFlags), ...info.constraintFlags, info.levelIdc],
    [0xf0, 0x00, 0xfc, 0xfc | info.chromaFormatIdc, 0xf8 | (info.bitDepthLuma - 8), 0xf8 | (info.bitDepthChroma - 8)],
    [0, 0, (layers << 3) | (nested << 2) | 3, present.length],
    ...arrays,
  );
}

/**
 * The boxes after the codec configuration in the sample entry, in the order ffmpeg's movenc writes them: `colr`
 * (nclx: primaries, transfer, matrix, then the full range flag in the top bit of a byte), `clli`, `mdcv` (the SEI's
 * payload as coded: G, B, R, white point, max and min luminance) and `pasp`.
 */
function entryExtensions(track: VideoTrack): Uint8Array[] {
  const out: Uint8Array[] = [];
  const c = track.colour;
  if (c) out.push(box('colr', fourcc('nclx'), u16(c.primaries), u16(c.transfer), u16(c.matrix), [c.fullRange ? 0x80 : 0]));
  if (track.light) out.push(box('clli', u16(track.light.maxCll), u16(track.light.maxFall)));
  const m = track.mastering;
  if (m) {
    out.push(box('mdcv', ...m.primaries.map(([x, y]) => [...u16(x), ...u16(y)]), u16(m.whitePoint[0]), u16(m.whitePoint[1]), u32(m.maxLuminance), u32(m.minLuminance)));
  }
  out.push(box('pasp', u32(track.sar.width), u32(track.sar.height)));
  return out;
}

function sampleEntry(track: VideoTrack): Uint8Array {
  const name = new Uint8Array(32);
  return box(
    track.coding === 'avc' ? 'avc1' : 'hvc1',
    new Uint8Array(6), u16(1), new Uint8Array(16),
    u16(track.width), u16(track.height), u32(0x00480000), u32(0x00480000), u32(0), u16(1), name, u16(0x0018), u16(0xffff),
    track.coding === 'avc' ? avcC(track.params) : hvcC(track.params),
    ...entryExtensions(track),
  );
}

/**
 * The initialization segment (`ftyp` and `moov`) of a one-track fragmented MP4 with track id 1; the track header
 * carries the display size, the sample entry the coded size.
 * @internal
 */
export function initSegment(track: VideoTrack): Uint8Array {
  const display = displaySize(track);
  const ftyp = box('ftyp', fourcc('isom'), u32(0x200), fourcc('isom'), fourcc('iso6'), fourcc('mp41'));
  const mvhd = fullBox('mvhd', 0, 0, u32(0), u32(0), u32(TIMESCALE), u32(0), u32(0x00010000), u16(0x0100), new Uint8Array(10), MATRIX, new Uint8Array(24), u32(2));
  const tkhd = fullBox('tkhd', 0, 3, u32(0), u32(0), u32(1), u32(0), u32(0), new Uint8Array(8), u16(0), u16(0), u16(0), u16(0), MATRIX, u32(display.width * 65536), u32(display.height * 65536));
  const mdhd = fullBox('mdhd', 0, 0, u32(0), u32(0), u32(TIMESCALE), u32(0), u16(0x55c4), u16(0));
  const hdlr = fullBox('hdlr', 0, 0, u32(0), fourcc('vide'), new Uint8Array(12), [...fourcc('VideoHandler'), 0]);
  const vmhd = fullBox('vmhd', 0, 1, u16(0), new Uint8Array(6));
  const dinf = box('dinf', fullBox('dref', 0, 0, u32(1), fullBox('url ', 0, 1)));
  const empty = (t: string): Uint8Array => fullBox(t, 0, 0, u32(0));
  const stbl = box(
    'stbl',
    fullBox('stsd', 0, 0, u32(1), sampleEntry(track)),
    empty('stts'), empty('stsc'), fullBox('stsz', 0, 0, u32(0), u32(0)), empty('stco'),
  );
  const trak = box('trak', tkhd, box('mdia', mdhd, hdlr, box('minf', vmhd, dinf, stbl)));
  const mvex = box('mvex', fullBox('trex', 0, 0, u32(1), u32(1), u32(0), u32(0), u32(0)));
  return concat([ftyp, box('moov', mvhd, trak, mvex)]);
}

/**
 * One media segment (`moof` and `mdat`) holding the samples in decode order, the first at `baseDecodeTicks`.
 * @internal
 */
export function mediaSegment(sequence: number, baseDecodeTicks: number, samples: readonly Fmp4Sample[]): Uint8Array {
  if (!Number.isInteger(baseDecodeTicks) || baseDecodeTicks < 0) throw new RangeError(`bad base decode time ${baseDecodeTicks}`);
  const build = (dataOffset: number): Uint8Array => {
    const entries: number[] = [];
    for (const s of samples) {
      entries.push(...u32(s.durationTicks), ...u32(s.data.length), ...u32(s.sync ? 0x02000000 : 0x01010000), ...u32(s.ctsOffsetTicks | 0));
    }
    return box(
      'moof',
      fullBox('mfhd', 0, 0, u32(sequence)),
      box(
        'traf',
        fullBox('tfhd', 0, 0x020000, u32(1)),
        fullBox('tfdt', 1, 0, u64(baseDecodeTicks)),
        fullBox('trun', 1, 0xf01, u32(samples.length), u32(dataOffset), entries),
      ),
    );
  };
  const moofSize = build(0).length;
  const total = samples.reduce((n, s) => n + s.data.length, 0);
  const mdatHeader = Uint8Array.from([...u32(8 + total), ...fourcc('mdat')]);
  return concat([build(moofSize + 8), mdatHeader, ...samples.map((s) => s.data)]);
}

/**
 * Turns an Annex B access unit into length-prefixed NAL units (4-byte lengths), dropping access unit delimiters (an
 * H.264 AUD is 2 bytes, an H.265 one 3) and keeping everything else.
 * @internal
 */
export function toLengthPrefixed(au: Uint8Array): Uint8Array {
  const kept = splitNalUnits(au).filter((n) => !((n.length === 2 && (n[0] & 0x9f) === 9) || (n.length === 3 && n[0] === 0x46)));
  return concat(kept.flatMap((n) => [Uint8Array.from(u32(n.length)), n]));
}
