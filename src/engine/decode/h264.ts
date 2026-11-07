import { ParseError } from '@seikou/bdmv/byte-reader';
import { joinAnnexB, splitAnnexB, unescapeRbsp } from './nal';

export interface AccessUnitInfo {
  readonly key: boolean;
  readonly idr: boolean;
  readonly sps: Uint8Array | null;
  /** The PPS NAL units the access unit carries. */
  readonly pps: readonly Uint8Array[];
  /** The access unit to decode (MVC NAL units removed for AVC). */
  readonly data: Uint8Array;
}

const NAL_IDR = 5;
const NAL_SEI = 6;
const NAL_SPS = 7;
const NAL_PPS = 8;
/** Prefix NAL, subset SPS, coded slice extension: MVC dependent-view data that a 2D decoder must not see. */
const MVC_TYPES = new Set([14, 15, 20]);
const SEI_RECOVERY_POINT = 6;
/** profile_idc values whose SPS carries chroma_format_idc, bit depths and scaling matrices (H.264 7.3.2.1.1). */
const HIGH_PROFILES = new Set([100, 110, 122, 244, 44, 83, 86, 118, 128, 138, 139, 134, 135]);

export function avcCodecString(sps: Uint8Array): string {
  if (sps.length < 4) throw new ParseError(`H.264 SPS is truncated (${sps.length} bytes)`);
  const hex = (b: number): string => b.toString(16).padStart(2, '0');
  return `avc1.${hex(sps[1])}${hex(sps[2])}${hex(sps[3])}`;
}

/**
 * frame_mbs_only_flag == 0: the stream may hold field pictures or MBAFF frames (1080i on Blu-ray). An SPS too short
 * to reach the flag counts as progressive.
 */
export function avcIsInterlaced(sps: Uint8Array): boolean {
  const r = new ExpGolomb(unescapeRbsp(sps.subarray(1)));
  try {
    const profile = r.u(8);
    r.u(16); // constraint flags, level_idc
    r.ue(); // seq_parameter_set_id
    if (HIGH_PROFILES.has(profile)) {
      const chromaFormat = r.ue();
      if (chromaFormat === 3) r.u(1); // separate_colour_plane_flag
      r.ue(); // bit_depth_luma_minus8
      r.ue(); // bit_depth_chroma_minus8
      r.u(1); // qpprime_y_zero_transform_bypass_flag
      if (r.u(1)) {
        // seq_scaling_matrix_present_flag
        for (let i = 0; i < (chromaFormat !== 3 ? 8 : 12); i++) if (r.u(1)) skipScalingList(r, i < 6 ? 16 : 64);
      }
    }
    r.ue(); // log2_max_frame_num_minus4
    const pocType = r.ue();
    if (pocType === 0) {
      r.ue(); // log2_max_pic_order_cnt_lsb_minus4
    } else if (pocType === 1) {
      r.u(1); // delta_pic_order_always_zero_flag
      r.se(); // offset_for_non_ref_pic
      r.se(); // offset_for_top_to_bottom_field
      const cycle = r.ue();
      for (let i = 0; i < cycle; i++) r.se();
    }
    r.ue(); // max_num_ref_frames
    r.u(1); // gaps_in_frame_num_value_allowed_flag
    r.ue(); // pic_width_in_mbs_minus1
    r.ue(); // pic_height_in_map_units_minus1
    return r.u(1) === 0;
  } catch (err) {
    if (err instanceof ParseError) return false;
    throw err;
  }
}

/** pic_parameter_set_id of a PPS NAL unit, or null when it is too short to hold one. */
export function avcPpsId(pps: Uint8Array): number | null {
  try {
    return new ExpGolomb(unescapeRbsp(pps.subarray(1))).ue();
  } catch (err) {
    if (err instanceof ParseError) return null;
    throw err;
  }
}

function skipScalingList(r: ExpGolomb, size: number): void {
  let last = 8;
  let next = 8;
  for (let j = 0; j < size; j++) {
    if (next !== 0) next = (last + r.se() + 256) % 256;
    last = next === 0 ? last : next;
  }
}

class ExpGolomb {
  private bit = 0;
  constructor(private readonly data: Uint8Array) {}

  u(n: number): number {
    let v = 0;
    for (let i = 0; i < n; i++) {
      const byte = this.bit >> 3;
      if (byte >= this.data.length) throw new ParseError('H.264 SPS is truncated');
      v = v * 2 + ((this.data[byte] >> (7 - (this.bit & 7))) & 1);
      this.bit++;
    }
    return v;
  }

  ue(): number {
    let zeros = 0;
    while (this.u(1) === 0) {
      if (++zeros > 31) throw new ParseError('H.264 SPS has an invalid Exp-Golomb code');
    }
    return 2 ** zeros - 1 + this.u(zeros);
  }

  se(): number {
    const k = this.ue();
    return k & 1 ? (k + 1) / 2 : -k / 2;
  }
}

export function analyzeAvc(data: Uint8Array): AccessUnitInfo {
  const nals = splitAnnexB(data);
  let idr = false;
  let recovery = false;
  let sps: Uint8Array | null = null;
  const pps: Uint8Array[] = [];
  let hasMvc = false;
  for (const nal of nals) {
    const type = nal[0] & 0x1f;
    if (MVC_TYPES.has(type)) {
      hasMvc = true;
    } else if (type === NAL_IDR) {
      idr = true;
    } else if (type === NAL_SPS) {
      sps ??= nal;
    } else if (type === NAL_PPS) {
      pps.push(nal);
    } else if (type === NAL_SEI && seiHasRecoveryPoint(nal)) {
      recovery = true;
    }
  }
  const out = hasMvc ? joinAnnexB(nals.filter((n) => !MVC_TYPES.has(n[0] & 0x1f))) : data;
  return { key: idr || recovery, idr, sps, pps, data: out };
}

function seiHasRecoveryPoint(nal: Uint8Array): boolean {
  const rbsp = unescapeRbsp(nal.subarray(1));
  let i = 0;
  while (i < rbsp.length && rbsp[i] !== 0x80) {
    let type = 0;
    while (rbsp[i] === 0xff) {
      type += 255;
      i++;
    }
    type += rbsp[i++];
    let size = 0;
    while (rbsp[i] === 0xff) {
      size += 255;
      i++;
    }
    size += rbsp[i++];
    if (type === SEI_RECOVERY_POINT) return true;
    i += size;
  }
  return false;
}
