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
 * The VUI's colour description: the code points of H.273 for the primaries, transfer characteristics and matrix
 * coefficients, and whether the sample values use the full range.
 * @internal
 */
export interface ColourDescription {
  primaries: number;
  transfer: number;
  matrix: number;
  fullRange: boolean;
}

/**
 * A sample aspect ratio from the VUI.
 * @internal
 */
export interface SampleAspectRatio {
  width: number;
  height: number;
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
  /** The VUI's colour description, or null when the SPS has none. */
  colour: ColourDescription | null;
  /** The sample aspect ratio from the VUI (1:1 when the SPS has none). */
  sar: SampleAspectRatio;
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
  /** chroma_format_idc (1 when the SPS has no high-profile fields). */
  chromaFormatIdc: number;
  /** Luma bit depth (8 when the SPS has no high-profile fields). */
  bitDepthLuma: number;
  /** Chroma bit depth (8 when the SPS has no high-profile fields). */
  bitDepthChroma: number;
  /** The picture size in luma samples after frame cropping. */
  width: number;
  height: number;
  /** The VUI's colour description, or null when the SPS has none. */
  colour: ColourDescription | null;
  /** The sample aspect ratio from the VUI (1:1 when the SPS has none). */
  sar: SampleAspectRatio;
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

const SAR_TABLE: readonly [number, number][] = [
  [1, 1], [12, 11], [10, 11], [16, 11], [40, 33], [24, 11], [20, 11], [32, 11],
  [80, 33], [18, 11], [15, 11], [64, 33], [160, 99], [4, 3], [3, 2], [2, 1],
];

/**
 * Reads the start of a VUI (identical in H.264 Annex E and H.265 Annex E): the aspect ratio, overscan and video
 * signal type, which is as far as the colour description needs. A truncated VUI gives no colour and a 1:1 ratio.
 */
function readVui(r: Bits): { colour: ColourDescription | null; sar: SampleAspectRatio } {
  let colour: ColourDescription | null = null;
  let sar: SampleAspectRatio = { width: 1, height: 1 };
  try {
    if (r.u(1)) {
      const idc = r.u(8);
      if (idc === 255) {
        const width = r.u(16);
        const height = r.u(16);
        if (width > 0 && height > 0) sar = { width, height };
      } else if (idc >= 1 && idc <= 16) {
        sar = { width: SAR_TABLE[idc - 1][0], height: SAR_TABLE[idc - 1][1] };
      }
    }
    if (r.u(1)) r.u(1); // overscan_appropriate_flag
    if (r.u(1)) {
      r.u(3); // video_format
      const fullRange = r.u(1) === 1;
      if (r.u(1)) colour = { primaries: r.u(8), transfer: r.u(8), matrix: r.u(8), fullRange };
    }
  } catch (e) {
    if (!(e instanceof ParseError)) throw e;
  }
  return { colour, sar };
}

function skipScalingListData(r: Bits): void {
  for (let sizeId = 0; sizeId < 4; sizeId++) {
    for (let matrixId = 0; matrixId < 6; matrixId += sizeId === 3 ? 3 : 1) {
      if (!r.u(1)) {
        r.ue(); // scaling_list_pred_matrix_id_delta
      } else {
        if (sizeId > 1) r.se(); // scaling_list_dc_coef_minus8
        const coefNum = Math.min(64, 1 << (4 + (sizeId << 1)));
        for (let i = 0; i < coefNum; i++) r.se();
      }
    }
  }
}

/** One short-term reference picture set's picture order differences, before (S0, negative) and after (S1, positive). */
interface RefPicSet {
  readonly s0: readonly number[];
  readonly s1: readonly number[];
}

/**
 * Reads st_ref_pic_set(idx) of an SPS (H.265 §7.3.7, where RefRpsIdx is idx - 1) and derives its picture order
 * differences as §7.4.8 does, since a set predicted from it reads one flag per difference it has plus one. A predicted
 * difference that comes out 0, or on the wrong side, is dropped, so a set can have fewer than its flags say.
 */
function readShortTermRefPicSet(r: Bits, idx: number, sets: readonly RefPicSet[]): RefPicSet {
  if (idx !== 0 && r.u(1)) {
    const sign = r.u(1); // delta_rps_sign
    const deltaRps = (1 - 2 * sign) * (r.ue() + 1); // abs_delta_rps_minus1
    const ref = sets[idx - 1];
    const count = ref.s0.length + ref.s1.length;
    const useDelta: boolean[] = [];
    for (let j = 0; j <= count; j++) {
      const used = r.u(1);
      useDelta.push(used ? true : r.u(1) === 1); // use_delta_flag is 1 when absent
    }
    const s0: number[] = [];
    const s1: number[] = [];
    for (let j = ref.s1.length - 1; j >= 0; j--) {
      const d = ref.s1[j] + deltaRps;
      if (d < 0 && useDelta[ref.s0.length + j]) s0.push(d);
    }
    if (deltaRps < 0 && useDelta[count]) s0.push(deltaRps);
    for (let j = 0; j < ref.s0.length; j++) {
      const d = ref.s0[j] + deltaRps;
      if (d < 0 && useDelta[j]) s0.push(d);
    }
    for (let j = ref.s0.length - 1; j >= 0; j--) {
      const d = ref.s0[j] + deltaRps;
      if (d > 0 && useDelta[j]) s1.push(d);
    }
    if (deltaRps > 0 && useDelta[count]) s1.push(deltaRps);
    for (let j = 0; j < ref.s1.length; j++) {
      const d = ref.s1[j] + deltaRps;
      if (d > 0 && useDelta[ref.s0.length + j]) s1.push(d);
    }
    return { s0, s1 };
  }
  const negative = r.ue();
  const positive = r.ue();
  const s0: number[] = [];
  const s1: number[] = [];
  for (let i = 0; i < negative; i++) {
    s0.push((s0.at(-1) ?? 0) - (r.ue() + 1)); // delta_poc_s0_minus1
    r.u(1); // used_by_curr_pic_s0_flag
  }
  for (let i = 0; i < positive; i++) {
    s1.push((s1.at(-1) ?? 0) + r.ue() + 1); // delta_poc_s1_minus1
    r.u(1); // used_by_curr_pic_s1_flag
  }
  return { s0, s1 };
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
  const { colour, sar } = readHevcVui(r, maxSubLayersMinus1);
  return { profileSpace, tierFlag, profileIdc, compatFlags, constraintFlags, levelIdc, chromaFormatIdc, bitDepthLuma, bitDepthChroma, width, height, colour, sar };
}

/** Reads an H.265 SPS from log2_max_pic_order_cnt_lsb_minus4 on, as far as the VUI, and returns the VUI's facts. */
function readHevcVui(r: Bits, maxSubLayersMinus1: number): { colour: ColourDescription | null; sar: SampleAspectRatio } {
  const none = { colour: null, sar: { width: 1, height: 1 } };
  try {
    const log2MaxPocLsb = r.ue() + 4;
    const orderingInfoPresent = r.u(1);
    for (let i = orderingInfoPresent ? 0 : maxSubLayersMinus1; i <= maxSubLayersMinus1; i++) {
      r.ue();
      r.ue();
      r.ue();
    }
    for (let i = 0; i < 4; i++) r.ue(); // coding and transform block sizes
    r.ue(); // max_transform_hierarchy_depth_inter
    r.ue(); // max_transform_hierarchy_depth_intra
    if (r.u(1) && r.u(1)) skipScalingListData(r);
    r.u(1); // amp_enabled_flag
    r.u(1); // sample_adaptive_offset_enabled_flag
    if (r.u(1)) {
      r.u(4); // pcm_sample_bit_depth_luma_minus1
      r.u(4); // pcm_sample_bit_depth_chroma_minus1
      r.ue(); // log2_min_pcm_luma_coding_block_size_minus3
      r.ue(); // log2_diff_max_min_pcm_luma_coding_block_size
      r.u(1); // pcm_loop_filter_disabled_flag
    }
    const numSets = r.ue();
    const sets: RefPicSet[] = [];
    for (let i = 0; i < numSets; i++) sets.push(readShortTermRefPicSet(r, i, sets));
    if (r.u(1)) {
      const numLongTerm = r.ue();
      for (let i = 0; i < numLongTerm; i++) {
        r.u(log2MaxPocLsb); // lt_ref_pic_poc_lsb_sps
        r.u(1); // used_by_curr_pic_lt_sps_flag
      }
    }
    r.u(1); // sps_temporal_mvp_enabled_flag
    r.u(1); // strong_intra_smoothing_enabled_flag
    if (!r.u(1)) return none; // vui_parameters_present_flag
    return readVui(r);
  } catch (e) {
    if (e instanceof ParseError) return none;
    throw e;
  }
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
  let bitDepthLuma = 8;
  let bitDepthChroma = 8;
  if (HIGH_PROFILES.has(profileIdc)) {
    chromaFormat = r.ue();
    if (chromaFormat === 3) separatePlanes = r.u(1);
    bitDepthLuma = r.ue() + 8;
    bitDepthChroma = r.ue() + 8;
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
  let vui: { colour: ColourDescription | null; sar: SampleAspectRatio } = { colour: null, sar: { width: 1, height: 1 } };
  try {
    if (r.u(1)) vui = readVui(r); // vui_parameters_present_flag
  } catch (e) {
    if (!(e instanceof ParseError)) throw e;
  }
  return { profileIdc, constraintFlags, levelIdc, chromaFormatIdc: chromaFormat, bitDepthLuma, bitDepthChroma, width, height, ...vui };
}
