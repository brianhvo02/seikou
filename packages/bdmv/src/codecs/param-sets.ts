// SPDX-License-Identifier: LGPL-3.0-or-later
import { ParseError } from '../byte-reader';
import { splitAnnexB, unescapeRbsp } from './nal';

/**
 * The parameter sets of a stream, each NAL unit without a start code and with its NAL unit header. H.264 has no VPS.
 * @internal
 */
export interface ParameterSets {
  vps: Uint8Array[];
  sps: Uint8Array[];
  pps: Uint8Array[];
}

/**
 * Splits an Annex B byte stream into NAL units with the start codes removed (each unit keeps its NAL unit header).
 * @internal
 */
export function splitNalUnits(au: Uint8Array): Uint8Array[] {
  return splitAnnexB(au);
}

/**
 * Collects the parameter sets of an access unit: H.264 SPS (type 7) and PPS (8), H.265 VPS (32), SPS (33) and PPS (34).
 * @internal
 */
export function findParameterSets(au: Uint8Array, coding: 'avc' | 'hevc'): ParameterSets {
  const out: ParameterSets = { vps: [], sps: [], pps: [] };
  for (const nal of splitNalUnits(au)) {
    if (coding === 'avc') {
      const type = nal[0] & 0x1f;
      if (type === 7) out.sps.push(nal);
      else if (type === 8) out.pps.push(nal);
    } else {
      const type = (nal[0] >> 1) & 0x3f;
      if (type === 32) out.vps.push(nal);
      else if (type === 33) out.sps.push(nal);
      else if (type === 34) out.pps.push(nal);
    }
  }
  return out;
}

/**
 * What an H.265 SPS says that an `hvcC` box and a `hvc1` sample entry need (H.265 §7.3.2.2 and §7.3.3).
 * @internal
 */
export interface HevcSpsInfo {
  profileSpace: number;
  tierFlag: number;
  profileIdc: number;
  /** general_profile_compatibility_flags as a 32-bit number, flag 0 in the top bit (the order `hvcC` stores). */
  compatFlags: number;
  /** The 6 bytes holding the progressive, interlaced, non-packed and frame-only flags and the reserved bits. */
  constraintFlags: Uint8Array;
  levelIdc: number;
  chromaFormatIdc: number;
  bitDepthLuma: number;
  bitDepthChroma: number;
  /** The picture size in luma samples after the conformance window. */
  width: number;
  height: number;
}

/**
 * What an H.264 SPS says that an `avcC` box and an `avc1` sample entry need (H.264 §7.3.2.1.1).
 * @internal
 */
export interface AvcSpsInfo {
  profileIdc: number;
  /** The byte holding constraint_set0..5_flag and the two reserved bits. */
  constraintFlags: number;
  levelIdc: number;
  /** The picture size in luma samples after frame cropping. */
  width: number;
  height: number;
}

class Bits {
  private bit = 0;
  constructor(private readonly data: Uint8Array) {}

  u(n: number): number {
    let v = 0;
    for (let i = 0; i < n; i++) {
      const byte = this.bit >> 3;
      if (byte >= this.data.length) throw new ParseError('SPS is truncated');
      v = v * 2 + ((this.data[byte] >> (7 - (this.bit & 7))) & 1);
      this.bit++;
    }
    return v;
  }

  skip(n: number): void {
    for (let i = 0; i < n; i += 8) this.u(Math.min(8, n - i));
  }

  ue(): number {
    let zeros = 0;
    while (this.u(1) === 0) if (++zeros > 31) throw new ParseError('SPS has an invalid Exp-Golomb code');
    return 2 ** zeros - 1 + this.u(zeros);
  }

  se(): number {
    const k = this.ue();
    return k & 1 ? (k + 1) / 2 : -k / 2;
  }
}

function skipScalingList(r: Bits, size: number): void {
  let last = 8;
  let next = 8;
  for (let i = 0; i < size; i++) {
    if (next !== 0) next = (last + r.se() + 256) % 256;
    last = next === 0 ? last : next;
  }
}

/**
 * Reads an H.265 SPS NAL unit (with its header): profile_tier_level with `sps_max_sub_layers_minus1` sub-layers, the
 * chroma format, the picture size less the conformance window and the bit depths. Throws a ParseError when the SPS
 * is truncated.
 * @internal
 */
export function readHevcSps(sps: Uint8Array): HevcSpsInfo {
  const r = new Bits(unescapeRbsp(sps.subarray(2)));
  r.u(4); // sps_video_parameter_set_id
  const maxSubLayersMinus1 = r.u(3);
  r.u(1); // sps_temporal_id_nesting_flag
  const profileSpace = r.u(2);
  const tierFlag = r.u(1);
  const profileIdc = r.u(5);
  const compatFlags = r.u(32);
  const constraintFlags = new Uint8Array(6);
  for (let i = 0; i < 6; i++) constraintFlags[i] = r.u(8);
  const levelIdc = r.u(8);
  const profilePresent: number[] = [];
  const levelPresent: number[] = [];
  for (let i = 0; i < maxSubLayersMinus1; i++) {
    profilePresent.push(r.u(1));
    levelPresent.push(r.u(1));
  }
  if (maxSubLayersMinus1 > 0) r.skip(2 * (8 - maxSubLayersMinus1)); // reserved_zero_2bits
  for (let i = 0; i < maxSubLayersMinus1; i++) {
    if (profilePresent[i]) r.skip(88);
    if (levelPresent[i]) r.skip(8);
  }
  r.ue(); // sps_seq_parameter_set_id
  const chromaFormatIdc = r.ue();
  const separatePlanes = chromaFormatIdc === 3 ? r.u(1) : 0;
  let width = r.ue();
  let height = r.ue();
  if (r.u(1)) {
    const subW = chromaFormatIdc === 1 || chromaFormatIdc === 2 ? 2 : 1;
    const subH = chromaFormatIdc === 1 ? 2 : 1;
    const unitX = separatePlanes ? 1 : subW;
    const unitY = separatePlanes ? 1 : subH;
    const left = r.ue();
    const right = r.ue();
    const top = r.ue();
    const bottom = r.ue();
    width -= (left + right) * unitX;
    height -= (top + bottom) * unitY;
  }
  const bitDepthLuma = r.ue() + 8;
  const bitDepthChroma = r.ue() + 8;
  return { profileSpace, tierFlag, profileIdc, compatFlags, constraintFlags, levelIdc, chromaFormatIdc, bitDepthLuma, bitDepthChroma, width, height };
}

const HIGH_PROFILES = new Set([100, 110, 122, 244, 44, 83, 86, 118, 128, 138, 139, 134, 135]);

/**
 * Reads an H.264 SPS NAL unit (with its header): profile, constraint flags, level and the picture size less frame
 * cropping. Throws a ParseError when the SPS is truncated.
 * @internal
 */
export function readAvcSps(sps: Uint8Array): AvcSpsInfo {
  const r = new Bits(unescapeRbsp(sps.subarray(1)));
  const profileIdc = r.u(8);
  const constraintFlags = r.u(8);
  const levelIdc = r.u(8);
  r.ue(); // seq_parameter_set_id
  let chromaFormat = 1;
  let separatePlanes = 0;
  if (HIGH_PROFILES.has(profileIdc)) {
    chromaFormat = r.ue();
    if (chromaFormat === 3) separatePlanes = r.u(1);
    r.ue(); // bit_depth_luma_minus8
    r.ue(); // bit_depth_chroma_minus8
    r.u(1); // qpprime_y_zero_transform_bypass_flag
    if (r.u(1)) {
      for (let i = 0; i < (chromaFormat !== 3 ? 8 : 12); i++) if (r.u(1)) skipScalingList(r, i < 6 ? 16 : 64);
    }
  }
  r.ue(); // log2_max_frame_num_minus4
  const pocType = r.ue();
  if (pocType === 0) {
    r.ue();
  } else if (pocType === 1) {
    r.u(1);
    r.se();
    r.se();
    const cycle = r.ue();
    for (let i = 0; i < cycle; i++) r.se();
  }
  r.ue(); // max_num_ref_frames
  r.u(1); // gaps_in_frame_num_value_allowed_flag
  const mbsWide = r.ue() + 1;
  const mapUnitsHigh = r.ue() + 1;
  const frameMbsOnly = r.u(1);
  if (!frameMbsOnly) r.u(1); // mb_adaptive_frame_field_flag
  r.u(1); // direct_8x8_inference_flag
  let width = mbsWide * 16;
  let height = (2 - frameMbsOnly) * mapUnitsHigh * 16;
  if (r.u(1)) {
    const chromaArrayType = separatePlanes ? 0 : chromaFormat;
    const unitX = chromaArrayType === 0 ? 1 : chromaArrayType === 3 ? 1 : 2;
    const unitY = (chromaArrayType === 0 || chromaArrayType >= 2 ? 1 : 2) * (2 - frameMbsOnly);
    const left = r.ue();
    const right = r.ue();
    const top = r.ue();
    const bottom = r.ue();
    width -= (left + right) * unitX;
    height -= (top + bottom) * unitY;
  }
  return { profileIdc, constraintFlags, levelIdc, width, height };
}
