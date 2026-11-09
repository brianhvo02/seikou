// SPDX-License-Identifier: LGPL-3.0-or-later

// AV1 from Matroska: the track's CodecPrivate is an AV1CodecConfigurationRecord (av1C, AV1-ISOBMFF §2.3), whose
// first four bytes give the profile, level, tier and bit depth the codec string (AV1-ISOBMFF Annex A, "Codecs
// Parameter String") is built from. Blocks hold temporal units as low-overhead OBUs, which WebCodecs takes as they are.

/**
 * The engine's coding number for AV1 video. Blu-ray coding types (`CodingType`) are one byte; this lies outside them,
 * so it never names a disc stream.
 */
export const CODING_AV1 = 0x1_0001;

/** The fields of an av1C record the codec string needs. */
export interface Av1Config {
  /** seq_profile: 0 main, 1 high, 2 professional. */
  readonly profile: number;
  /** seq_level_idx_0 (0–31; 31 is "no level"). */
  readonly level: number;
  /** seq_tier_0: false main, true high. */
  readonly highTier: boolean;
  /** 8, 10 or 12. */
  readonly bitDepth: number;
  readonly monochrome: boolean;
}

/** Reads an av1C record; null when it is too short or its marker and version are not 1 and 1. */
export function parseAv1C(record: Uint8Array): Av1Config | null {
  if (record.length < 4 || record[0] !== 0x81) return null;
  const b1 = record[1]!;
  const b2 = record[2]!;
  const profile = b1 >> 5;
  const highBitdepth = (b2 & 0x40) !== 0;
  const twelveBit = (b2 & 0x20) !== 0;
  return {
    profile,
    level: b1 & 0x1f,
    highTier: (b2 & 0x80) !== 0,
    bitDepth: highBitdepth ? (profile === 2 && twelveBit ? 12 : 10) : 8,
    monochrome: (b2 & 0x10) !== 0,
  };
}

/** The short codec string `av01.P.LLT.DD` of an av1C record (the colour fields are optional and left out). */
export function av1CodecString(record: Uint8Array): string {
  const c = parseAv1C(record);
  if (!c) throw new Error('the AV1 track has no usable av1C record');
  return `av01.${c.profile}.${String(c.level).padStart(2, '0')}${c.highTier ? 'H' : 'M'}.${String(c.bitDepth).padStart(2, '0')}`;
}
