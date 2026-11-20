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
  /** The size the picture shows at (its sample aspect applied), as the frame reported it. */
  readonly displayWidth: number;
  readonly displayHeight: number;
  /**
   * Pictures were skipped just before this one (a decoder too slow for every picture skipped B pictures): the field
   * cadence breaks here, so the detector starts its cycle again, as at a cut.
   */
  readonly afterSkip?: boolean;
}

/** Whether a CLPI or STN video `format` code is interlaced: 1 (480i), 2 (576i) or 4 (1080i). */
export function isInterlacedFormat(format: number): boolean {
  return format === 1 || format === 2 || format === 4;
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

/** The colour matrix of a picture whose stream names none: standard definition (576 lines or fewer) or high. */
export function matrixByHeight(height: number): PlaneMatrix {
  if (height === 576) return 'bt470bg';
  return height <= 576 ? 'smpte170m' : 'bt709';
}

let scratch = new Uint8Array(0);
let rgbScratch = new Uint8Array(0);

/** The byte of R, G and B in a pixel of each 4-byte RGB format `VideoFrame` may have. */
const RGB_ORDER: Readonly<Record<string, readonly [number, number, number]>> = {
  RGBX: [0, 1, 2],
  RGBA: [0, 1, 2],
  BGRX: [2, 1, 0],
  BGRA: [2, 1, 0],
};

/**
 * Whether framePlanes reads frames of `format`: I420 and NV12 as they are, and the 4-byte RGB formats (Firefox on macOS
 * decodes H.264 to BGRX) converted to I420.
 */
export function readableFrameFormat(format: string | null): boolean {
  return format === 'I420' || format === 'NV12' || (format !== null && format in RGB_ORDER);
}

/**
 * Copies a frame's planes (`VideoFrame.copyTo`, I420 or NV12 as the frame is) into one buffer. The buffer is reused
 * between calls and grows only when a frame needs more, so the planes are valid until the next call: the caller
 * uses or copies them before then. The matrix is the frame's own colour space when it names one this module knows,
 * else `spsMatrix` (the SPS VUI's matrix_coefficients), else by height (576 lines or fewer is standard definition).
 * A frame in a 4-byte RGB format is converted to limited-range I420 with that matrix (rgbToI420). Rejects for any
 * other pixel format.
 */
export async function framePlanes(frame: VideoFrame, spsMatrix: number | null = null): Promise<YuvPlanes> {
  const format = frame.format;
  if (format === null || !readableFrameFormat(format)) throw new Error(`unsupported video frame format ${String(format)}`);
  const rect = frame.visibleRect;
  const width = rect?.width ?? frame.codedWidth;
  const height = rect?.height ?? frame.codedHeight;
  const given = frame.colorSpace?.matrix;
  const matrix = given === 'bt709' || given === 'smpte170m' || given === 'bt470bg' ? given : (matrixFromCoefficients(spsMatrix) ?? matrixByHeight(height));
  const order = RGB_ORDER[format];
  if (order) {
    const rgbSize = frame.allocationSize();
    if (rgbScratch.byteLength < rgbSize) rgbScratch = new Uint8Array(rgbSize);
    const [rgbLayout] = await frame.copyTo(rgbScratch);
    const size = i420Size(width, height);
    if (scratch.byteLength < size) scratch = new Uint8Array(size);
    const layout = rgbToI420(rgbScratch, rgbLayout!, order, width, height, matrix, scratch);
    return { format: 'I420', width, height, data: scratch.subarray(0, size), layout, matrix };
  }
  const size = frame.allocationSize();
  if (scratch.byteLength < size) scratch = new Uint8Array(size);
  const layout = await frame.copyTo(scratch);
  return { format: format as PlaneFormat, width, height, data: scratch.subarray(0, size), layout, matrix };
}

/** Bytes of an I420 picture of this size: a full Y plane, and U and V planes of half the width and height (rounded up). */
export function i420Size(width: number, height: number): number {
  return width * height + 2 * Math.ceil(width / 2) * Math.ceil(height / 2);
}

/** Kr and Kb of each matrix (Kg = 1 - Kr - Kb). */
const LUMA_WEIGHTS: Readonly<Record<PlaneMatrix, readonly [number, number]>> = {
  bt709: [0.2126, 0.0722],
  smpte170m: [0.299, 0.114],
  bt470bg: [0.299, 0.114],
};

/**
 * Converts full-range RGB pixels (4 bytes each, R, G and B at `order`) to limited-range I420 with `matrix`, into `out`
 * (at least i420Size bytes), and returns the planes' layout. Chroma is 4:2:0 as an interlaced picture stores it: each
 * chroma row averages two rows of one field (chroma row 2k from luma rows 4k and 4k+2, row 2k+1 from 4k+1 and 4k+3),
 * so the fields stay apart for the deinterlacer.
 */
export function rgbToI420(rgb: Uint8Array, rgbLayout: PlaneLayout, order: readonly [number, number, number], width: number, height: number, matrix: PlaneMatrix, out: Uint8Array): PlaneLayout[] {
  const [kr, kb] = LUMA_WEIGHTS[matrix];
  const kg = 1 - kr - kb;
  const ys = 219 / 255;
  const cs = 224 / 255;
  // Y = 16 + ys·(kr R + kg G + kb B); U = 128 + cs·(B − Y')/(2(1 − kb)); V = 128 + cs·(R − Y')/(2(1 − kr)), in 16-bit
  // fixed point (chroma from the sum of four pixels, so its weights are a quarter)
  const fix = (v: number): number => Math.round(v * 65536);
  const yr = fix(ys * kr);
  const yg = fix(ys * kg);
  const yb = fix(ys * kb);
  const ub = cs / (2 * (1 - kb));
  const vr0 = cs / (2 * (1 - kr));
  const ur = fix((-ub * kr) / 4);
  const ug = fix((-ub * kg) / 4);
  const uB = fix((ub * (1 - kb)) / 4);
  const vR = fix((vr0 * (1 - kr)) / 4);
  const vg = fix((-vr0 * kg) / 4);
  const vb = fix((-vr0 * kb) / 4);
  const yBias = fix(16.5);
  const cBias = fix(128.5);
  const [ri, gi, bi] = order;
  const { offset: base, stride } = rgbLayout;
  const cw = Math.ceil(width / 2);
  const ch = Math.ceil(height / 2);
  const uOffset = width * height;
  const vOffset = uOffset + cw * ch;
  for (let y = 0; y < height; y++) {
    let p = base + y * stride;
    let o = y * width;
    for (let x = 0; x < width; x++, p += 4) out[o++] = (yBias + yr * rgb[p + ri]! + yg * rgb[p + gi]! + yb * rgb[p + bi]!) >> 16;
  }
  for (let j = 0; j < ch; j++) {
    const r0 = Math.min(4 * (j >> 1) + (j & 1), height - 1);
    // the field's next row, or the same row at the bottom edge
    const r1 = r0 + 2 < height ? r0 + 2 : r0;
    const row0 = base + r0 * stride;
    const row1 = base + r1 * stride;
    let o = j * cw;
    for (let i = 0; i < cw; i++, o++) {
      const a = row0 + 8 * i;
      const b = row1 + 8 * i;
      const right = 2 * i + 1 < width ? 4 : 0;
      const r = rgb[a + ri]! + rgb[a + right + ri]! + rgb[b + ri]! + rgb[b + right + ri]!;
      const g = rgb[a + gi]! + rgb[a + right + gi]! + rgb[b + gi]! + rgb[b + right + gi]!;
      const bl = rgb[a + bi]! + rgb[a + right + bi]! + rgb[b + bi]! + rgb[b + right + bi]!;
      out[uOffset + o] = (cBias + ur * r + ug * g + uB * bl) >> 16;
      out[vOffset + o] = (cBias + vR * r + vg * g + vb * bl) >> 16;
    }
  }
  return [
    { offset: 0, stride: width },
    { offset: uOffset, stride: cw },
    { offset: vOffset, stride: cw },
  ];
}
