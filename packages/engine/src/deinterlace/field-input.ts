// SPDX-License-Identifier: LGPL-3.0-or-later

/** The pixel layouts of a decoded picture's planes: three planes (Y, U, V) or two (Y, interleaved UV). */
export type PlaneFormat = 'I420' | 'NV12';

/** The colour matrix of a picture's YUV values. */
export type PlaneMatrix = 'bt709' | 'smpte170m' | 'bt470bg';

/** A decoded picture's YUV planes in one buffer, laid out as `VideoFrame.copyTo` wrote them. */
export interface YuvPlanes {
  readonly format: PlaneFormat;
  /** The visible width in pixels. */
  readonly width: number;
  /** The visible height in pixels (both fields of an interlaced frame). */
  readonly height: number;
  /** The planes' bytes; `layout` says where each starts. */
  readonly data: Uint8Array;
  /** Offset and stride of each plane in `data`, as `VideoFrame.copyTo` reported them. */
  readonly layout: readonly PlaneLayout[];
  /** The colour matrix of the values. */
  readonly matrix: PlaneMatrix;
}

/** What a picture's bitstream says about its fields (H.264 Table D-1's pic_struct, or MPEG-2's picture coding extension). */
export interface FieldFlags {
  /** Which field is first in time, or null when the stream doesn't say. */
  readonly fieldOrder: 'tff' | 'bff' | null;
  /** True for a frame to show whole, false for fields, null when the stream doesn't say. */
  readonly progressive: boolean | null;
  /** The first field is shown again after the second (soft 3:2 pulldown). */
  readonly repeatFirstField: boolean;
}

/** One decoded interlaced picture on its way to the deinterlacer: planes, time and field flags. */
export interface FieldInput {
  readonly planes: YuvPlanes;
  /** The unit's timestamp in microseconds. */
  readonly timestampUs: number;
  /** The frame's duration in microseconds as the decoder reports it, 0 when unknown. */
  readonly durationUs: number;
  readonly flags: FieldFlags;
}

const NO_FLAGS: FieldFlags = { fieldOrder: null, progressive: null, repeatFirstField: false };

/**
 * The field flags of an H.264 pic_struct (Table D-1): 0 a progressive frame, 1 and 2 a single top or bottom field,
 * 3 and 4 a frame with the top or bottom field first, 5 and 6 the same with the first field repeated, 7 and 8 frame
 * doubling and tripling (progressive). Null, or a value beyond 8, says nothing.
 */
export function flagsFromPicStruct(picStruct: number | null): FieldFlags {
  switch (picStruct) {
    case 0:
      return { fieldOrder: null, progressive: true, repeatFirstField: false };
    case 1:
      return { fieldOrder: 'tff', progressive: false, repeatFirstField: false };
    case 2:
      return { fieldOrder: 'bff', progressive: false, repeatFirstField: false };
    case 3:
      return { fieldOrder: 'tff', progressive: false, repeatFirstField: false };
    case 4:
      return { fieldOrder: 'bff', progressive: false, repeatFirstField: false };
    case 5:
      return { fieldOrder: 'tff', progressive: false, repeatFirstField: true };
    case 6:
      return { fieldOrder: 'bff', progressive: false, repeatFirstField: true };
    case 7:
    case 8:
      return { fieldOrder: null, progressive: true, repeatFirstField: true };
    default:
      return NO_FLAGS;
  }
}

/** The colour matrix for H.264's matrix_coefficients (Table E-5), or null for a value this file doesn't map. */
export function matrixFromCoefficients(coefficients: number | null): PlaneMatrix | null {
  if (coefficients === 1) return 'bt709';
  if (coefficients === 5) return 'bt470bg';
  if (coefficients === 6) return 'smpte170m';
  return null;
}

function matrixByHeight(height: number): PlaneMatrix {
  if (height === 576) return 'bt470bg';
  return height <= 576 ? 'smpte170m' : 'bt709';
}

let scratch = new Uint8Array(0);

/**
 * Copies a frame's planes (`VideoFrame.copyTo`, I420 or NV12 as the frame is) into one buffer. The buffer is reused
 * between calls and grows only when a frame needs more, so the planes are valid until the next call: the caller
 * uses or copies them before then. The matrix is the frame's own colour space when it names one this module knows,
 * else `spsMatrix` (the SPS VUI's matrix_coefficients), else by height (576 lines or fewer is standard definition).
 * Rejects for a pixel format other than I420 and NV12.
 */
export async function framePlanes(frame: VideoFrame, spsMatrix: number | null = null): Promise<YuvPlanes> {
  const format = frame.format;
  if (format !== 'I420' && format !== 'NV12') throw new Error(`unsupported video frame format ${String(format)}`);
  const rect = frame.visibleRect;
  const width = rect?.width ?? frame.codedWidth;
  const height = rect?.height ?? frame.codedHeight;
  const size = frame.allocationSize();
  if (scratch.byteLength < size) scratch = new Uint8Array(size);
  const layout = await frame.copyTo(scratch);
  const given = frame.colorSpace?.matrix;
  const matrix = given === 'bt709' || given === 'smpte170m' || given === 'bt470bg' ? given : (matrixFromCoefficients(spsMatrix) ?? matrixByHeight(height));
  return { format, width, height, data: scratch.subarray(0, size), layout, matrix };
}
