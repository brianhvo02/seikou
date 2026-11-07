import { ParseError } from '@seikou/bdmv/byte-reader';
import type { AccessUnitInfo } from './h264';
import { splitAnnexB, unescapeRbsp } from './nal';

const NAL_SPS = 33;
const IRAP_FIRST = 16;
const IRAP_LAST = 21;
const IDR_W_RADL = 19;
const IDR_N_LP = 20;

function nalType(nal: Uint8Array): number {
  return (nal[0] >> 1) & 0x3f;
}

function reverseBits32(x: number): number {
  let v = x >>> 0;
  let r = 0;
  for (let i = 0; i < 32; i++) {
    r = (r << 1) | (v & 1);
    v >>>= 1;
  }
  return r >>> 0;
}

/** ISO/IEC 14496-15 Annex E codec string from the SPS profile_tier_level. */
export function hevcCodecString(sps: Uint8Array): string {
  const r = unescapeRbsp(sps);
  if (r.length < 15) throw new ParseError(`HEVC SPS is truncated (${r.length} bytes before profile_tier_level ends)`);
  const profileSpace = r[3] >> 6;
  const tier = (r[3] >> 5) & 1;
  const profile = r[3] & 0x1f;
  const compat = ((r[4] << 24) | (r[5] << 16) | (r[6] << 8) | r[7]) >>> 0;
  const constraints = r.subarray(8, 14);
  const level = r[14];
  let s = `hev1.${['', 'A', 'B', 'C'][profileSpace]}${profile}.${reverseBits32(compat).toString(16).toUpperCase()}.${tier ? 'H' : 'L'}${level}`;
  let last = constraints.length - 1;
  while (last >= 0 && constraints[last] === 0) last--;
  for (let i = 0; i <= last; i++) s += `.${constraints[i].toString(16).toUpperCase()}`;
  return s;
}

/** The `hvc1.` form, then the `hev1.` form: browsers differ in which one they accept. */
export function hevcCodecStrings(sps: Uint8Array): readonly [string, string] {
  const hev1 = hevcCodecString(sps);
  return [hev1.replace(/^hev1/, 'hvc1'), hev1];
}

export function analyzeHevc(data: Uint8Array): AccessUnitInfo {
  let key = false;
  let idr = false;
  let sps: Uint8Array | null = null;
  for (const nal of splitAnnexB(data)) {
    const type = nalType(nal);
    if (type >= IRAP_FIRST && type <= IRAP_LAST) key = true;
    if (type === IDR_W_RADL || type === IDR_N_LP) idr = true;
    if (type === NAL_SPS) sps ??= nal;
  }
  return { key, idr, sps, pps: [], data };
}
