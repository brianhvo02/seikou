// SPDX-License-Identifier: LGPL-3.0-or-later
import { BitReader } from './bit-reader';

export interface Obu {
  type: number;
  /** OBU header bytes including the extension byte and the obu_size field, when present. */
  header: Uint8Array;
  payload: Uint8Array;
}

export const ObuType = {
  SEQUENCE_HEADER: 1,
  TEMPORAL_DELIMITER: 2,
  FRAME_HEADER: 3,
  TILE_GROUP: 4,
  METADATA: 5,
  FRAME: 6,
  REDUNDANT_FRAME_HEADER: 7,
  PADDING: 15,
} as const;

/** Splits a temporal unit (Section 5 low-overhead format) into OBUs. */
export function splitObus(temporalUnit: Uint8Array): Obu[] {
  const obus: Obu[] = [];
  let pos = 0;
  while (pos < temporalUnit.length) {
    const start = pos;
    const first = temporalUnit[pos++]!;
    const type = (first >> 3) & 0x0f;
    const hasExtension = (first & 0x04) !== 0;
    const hasSize = (first & 0x02) !== 0;
    if (hasExtension) pos++;
    let size: number;
    if (hasSize) {
      const r = new BitReader(temporalUnit, pos * 8);
      size = r.leb128();
      pos = r.bitPosition >> 3;
    } else {
      size = temporalUnit.length - pos;
    }
    if (pos > temporalUnit.length || pos + size > temporalUnit.length) {
      throw new RangeError('AV1: OBU extends past the end of the temporal unit');
    }
    obus.push({
      type,
      header: temporalUnit.subarray(start, pos),
      payload: temporalUnit.subarray(pos, pos + size),
    });
    pos += size;
  }
  return obus;
}

export interface SequenceHeaderInfo {
  seqProfile: number;
  seqLevelIdx0: number;
  seqTier0: number;
  highBitdepth: boolean;
  twelveBit: boolean;
  monoChrome: boolean;
  subsamplingX: number;
  subsamplingY: number;
  chromaSamplePosition: number;
  reducedStillPictureHeader: boolean;
}

/** Parses sequence_header_obu() (AV1 spec 5.5.1) up to and including color_config() (5.5.2). */
export function parseSequenceHeader(payload: Uint8Array): SequenceHeaderInfo {
  const r = new BitReader(payload);
  const seqProfile = r.f(3);
  r.f(1); // still_picture
  const reducedStillPictureHeader = r.f(1) === 1;

  let seqLevelIdx0 = 0;
  let seqTier0 = 0;

  if (reducedStillPictureHeader) {
    seqLevelIdx0 = r.f(5);
  } else {
    const timingInfoPresent = r.f(1) === 1;
    let decoderModelInfoPresent = false;
    let bufferDelayLength = 0;
    if (timingInfoPresent) {
      r.f(32); // num_units_in_display_tick
      r.f(32); // time_scale
      if (r.f(1) === 1) r.uvlc(); // equal_picture_interval -> num_ticks_per_picture_minus_1
      decoderModelInfoPresent = r.f(1) === 1;
      if (decoderModelInfoPresent) {
        bufferDelayLength = r.f(5) + 1; // buffer_delay_length_minus_1
        r.f(32); // num_units_in_decoding_tick
        r.f(5); // buffer_removal_time_length_minus_1
        r.f(5); // frame_presentation_time_length_minus_1
      }
    }
    const initialDisplayDelayPresent = r.f(1) === 1;
    const operatingPointsCnt = r.f(5) + 1;
    for (let i = 0; i < operatingPointsCnt; i++) {
      r.f(12); // operating_point_idc
      const level = r.f(5);
      const tier = level > 7 ? r.f(1) : 0;
      if (i === 0) {
        seqLevelIdx0 = level;
        seqTier0 = tier;
      }
      if (decoderModelInfoPresent) {
        if (r.f(1) === 1) {
          // operating_parameters_info
          r.f(bufferDelayLength); // decoder_buffer_delay
          r.f(bufferDelayLength); // encoder_buffer_delay
          r.f(1); // low_delay_mode_flag
        }
      }
      if (initialDisplayDelayPresent) {
        if (r.f(1) === 1) r.f(4); // initial_display_delay_minus_1
      }
    }
  }

  const frameWidthBits = r.f(4) + 1;
  const frameHeightBits = r.f(4) + 1;
  r.f(frameWidthBits); // max_frame_width_minus_1
  r.f(frameHeightBits); // max_frame_height_minus_1

  if (!reducedStillPictureHeader) {
    if (r.f(1) === 1) {
      // frame_id_numbers_present_flag
      r.f(4); // delta_frame_id_length_minus_2
      r.f(3); // additional_frame_id_length_minus_1
    }
  }
  r.f(1); // use_128x128_superblock
  r.f(1); // enable_filter_intra
  r.f(1); // enable_intra_edge_filter
  if (!reducedStillPictureHeader) {
    r.f(1); // enable_interintra_compound
    r.f(1); // enable_masked_compound
    r.f(1); // enable_warped_motion
    r.f(1); // enable_dual_filter
    const enableOrderHint = r.f(1) === 1;
    if (enableOrderHint) {
      r.f(1); // enable_jnt_comp
      r.f(1); // enable_ref_frame_mvs
    }
    const seqChooseScreenContentTools = r.f(1) === 1;
    const seqForceScreenContentTools = seqChooseScreenContentTools ? 2 : r.f(1);
    if (seqForceScreenContentTools > 0) {
      if (r.f(1) === 0) r.f(1); // seq_choose_integer_mv ? SELECT : seq_force_integer_mv
    }
    if (enableOrderHint) r.f(3); // order_hint_bits_minus_1
  }
  r.f(1); // enable_superres
  r.f(1); // enable_cdef
  r.f(1); // enable_restoration

  // color_config()
  const highBitdepth = r.f(1) === 1;
  let twelveBit = false;
  if (seqProfile === 2 && highBitdepth) twelveBit = r.f(1) === 1;
  const monoChrome = seqProfile === 1 ? false : r.f(1) === 1;
  let colorPrimaries = 2;
  let transferCharacteristics = 2;
  let matrixCoefficients = 2;
  if (r.f(1) === 1) {
    colorPrimaries = r.f(8);
    transferCharacteristics = r.f(8);
    matrixCoefficients = r.f(8);
  }
  let subsamplingX: number;
  let subsamplingY: number;
  let chromaSamplePosition = 0;
  if (monoChrome) {
    r.f(1); // color_range
    subsamplingX = 1;
    subsamplingY = 1;
  } else if (colorPrimaries === 1 && transferCharacteristics === 13 && matrixCoefficients === 1) {
    subsamplingX = 0;
    subsamplingY = 0;
  } else {
    r.f(1); // color_range
    if (seqProfile === 0) {
      subsamplingX = 1;
      subsamplingY = 1;
    } else if (seqProfile === 1) {
      subsamplingX = 0;
      subsamplingY = 0;
    } else if (twelveBit) {
      subsamplingX = r.f(1);
      subsamplingY = subsamplingX === 1 ? r.f(1) : 0;
    } else {
      subsamplingX = 1;
      subsamplingY = 0;
    }
    if (subsamplingX === 1 && subsamplingY === 1) chromaSamplePosition = r.f(2);
  }

  return {
    seqProfile,
    seqLevelIdx0,
    seqTier0,
    highBitdepth,
    twelveBit,
    monoChrome,
    subsamplingX,
    subsamplingY,
    chromaSamplePosition,
    reducedStillPictureHeader,
  };
}

/** True when the first frame (header) OBU of the temporal unit is a shown or hidden key frame. */
export function isKeyframe(temporalUnit: Uint8Array, seq: SequenceHeaderInfo): boolean {
  const frameObu = splitObus(temporalUnit).find(
    (o) => o.type === ObuType.FRAME_HEADER || o.type === ObuType.FRAME,
  );
  if (frameObu === undefined) return false;
  if (seq.reducedStillPictureHeader) return true;
  const r = new BitReader(frameObu.payload);
  if (r.f(1) === 1) return false; // show_existing_frame
  return r.f(2) === 0; // frame_type === KEY_FRAME
}

/** AV1CodecConfigurationRecord: 4 bytes followed by the sequence header OBU. */
export function buildAv1C(seqObu: Obu, seq: SequenceHeaderInfo): Uint8Array {
  const out = new Uint8Array(4 + seqObu.header.length + seqObu.payload.length);
  out[0] = 0x81;
  out[1] = (seq.seqProfile << 5) | seq.seqLevelIdx0;
  out[2] =
    (seq.seqTier0 << 7) |
    (seq.highBitdepth ? 0x40 : 0) |
    (seq.twelveBit ? 0x20 : 0) |
    (seq.monoChrome ? 0x10 : 0) |
    (seq.subsamplingX << 3) |
    (seq.subsamplingY << 2) |
    seq.chromaSamplePosition;
  out[3] = 0x00;
  out.set(seqObu.header, 4);
  out.set(seqObu.payload, 4 + seqObu.header.length);
  return out;
}
