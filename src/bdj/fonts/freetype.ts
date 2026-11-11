/*
 * Original code for Seikou: FreeType (src/wasm/freetype/freetype.wasm) for BD-J text. The calls are the ones
 * libbluray's BD-J text natives make (bdj/native/java_awt_BDFontMetrics.c, java_awt_BDGraphics.c), with their
 * arguments, load flags and shifts, made in shim.c; this wraps them for the port of those natives.
 *
 * Copyright (C) 2026  Seikou contributors
 *
 * SPDX-License-Identifier: LGPL-2.1-or-later
 */

import { instantiateStandaloneWasm } from '@seikou/engine/util/standalone-wasm';

interface FreeTypeWasm {
  readonly memory: WebAssembly.Memory;
  ft_init(): number;
  ft_last_error(): number;
  ft_new_face(data: number, length: number, index: number): number;
  ft_done_face(face: number): void;
  ft_family_name(face: number): number;
  ft_style_name(face: number): number;
  ft_set_char_size(face: number, size: number): number;
  ft_size_metrics(face: number, out: number): void;
  ft_load_char(face: number, code: number, render: number): number;
  ft_glyph_info(face: number, out: number): void;
  ft_glyph_bitmap(face: number, out: number): void;
  ft_kerning(face: number, left: number, right: number): number;
  malloc(size: number): number;
  free(ptr: number): void;
}

/** A face's size metrics in pixels, as loadFontN sets BDFontMetrics' fields (plus the line height). */
export interface FreeTypeMetrics {
  /** ascender >> 6 */
  ascent: number;
  /** -descender >> 6 */
  descent: number;
  /** (height - ascender + descender) >> 6 */
  leading: number;
  /** max_advance >> 6 */
  maxAdvance: number;
  /** height >> 6 */
  height: number;
}

/** One glyph as drawStringN draws it after FT_Load_Char(face, c, FT_LOAD_RENDER). */
export interface FreeTypeGlyph {
  /** metrics.horiAdvance >> 6 */
  advance: number;
  /** width * rows bytes, row by row: bitmap.buffer[j * pitch + k] for k < width (8-bit coverage for gray bitmaps) */
  bitmap: Uint8Array;
  width: number;
  rows: number;
  /** bitmap_left: x offset of the bitmap from the pen */
  left: number;
  /** bitmap_top: rows of the bitmap above the baseline */
  top: number;
  /** FT_Pixel_Mode: 2 (gray) for outlines; embedded bitmaps may be 1 (mono), which libbluray reads as bytes all the same */
  pixelMode: number;
}

export interface FreeType {
  /** FT_New_Memory_Face; throws FreeTypeError when FreeType cannot open it. The bytes are copied. */
  newFace(bytes: Uint8Array, faceIndex?: number): number;
  /** family_name and style_name (getFontFamilyAndStyleN); null where the font has none. */
  familyName(face: number): string | null;
  styleName(face: number): string | null;
  /** FT_Set_Char_Size(face, 0, size << 6, 0, 0) as loadFontN calls it (size points at 72 dpi, so pixels). Returns
   * FreeType's error, which libbluray ignores (0 when it worked). */
  setSize(face: number, pixelSize: number): number;
  metrics(face: number): FreeTypeMetrics;
  /** FT_Load_Char(face, c, FT_LOAD_DEFAULT), horiAdvance >> 6 (charWidthN, stringWidthN, charsWidthN); null when the
   * load fails, where those natives add nothing. */
  advance(face: number, codepoint: number): number | null;
  /** FT_Load_Char(face, c, FT_LOAD_RENDER) (drawStringN); null when it fails, where drawStringN skips the character. */
  glyph(face: number, codepoint: number): FreeTypeGlyph | null;
  /** FT_Get_Kerning (FT_KERNING_DEFAULT) between two characters, x in 26.6 pixels. libbluray does not kern. */
  kerning(face: number, left: number, right: number): number;
  /** FT_Done_Face and the face's copy of the font. */
  free(face: number): void;
  /** The WASM memory (which never shrinks) and the faces open in it (memory accounting). */
  memoryStats(): { readonly wasmBytes: number; readonly faces: number };
}

export class FreeTypeError extends Error {
  constructor(
    readonly code: number,
    what: string,
  ) {
    super(`FreeType: ${what} failed (error ${code})`);
    this.name = 'FreeTypeError';
  }
}

/** Loads freetype.wasm from its bytes or a fetch of it and initialises the library (FT_Init_FreeType). */
export async function loadFreeType(source: Uint8Array | Promise<Response>): Promise<FreeType> {
  const wasm = await instantiateStandaloneWasm<FreeTypeWasm>(
    source instanceof Uint8Array ? (source as Uint8Array<ArrayBuffer>) : source,
    'freetype.wasm',
    'FreeType',
  );
  const err = wasm.ft_init();
  if (err !== 0) throw new FreeTypeError(err, 'FT_Init_FreeType');
  return new WasmFreeType(wasm);
}

class WasmFreeType implements FreeType {
  /** Scratch for the shim's int32 out-parameters. */
  private readonly ints: number;
  private readonly faces = new Set<number>();

  constructor(private readonly wasm: FreeTypeWasm) {
    this.ints = wasm.malloc(8 * 4);
  }

  newFace(bytes: Uint8Array, faceIndex = 0): number {
    const data = this.wasm.malloc(Math.max(bytes.length, 1));
    if (data === 0) throw new FreeTypeError(0x40, 'malloc');
    new Uint8Array(this.wasm.memory.buffer, data, bytes.length).set(bytes);
    const face = this.wasm.ft_new_face(data, bytes.length, faceIndex); // owns data from here
    if (face === 0) throw new FreeTypeError(this.wasm.ft_last_error(), 'FT_New_Memory_Face');
    this.faces.add(face);
    return face;
  }

  familyName(face: number): string | null {
    return this.cString(this.wasm.ft_family_name(this.check(face)));
  }

  styleName(face: number): string | null {
    return this.cString(this.wasm.ft_style_name(this.check(face)));
  }

  setSize(face: number, pixelSize: number): number {
    return this.wasm.ft_set_char_size(this.check(face), pixelSize);
  }

  metrics(face: number): FreeTypeMetrics {
    this.wasm.ft_size_metrics(this.check(face), this.ints);
    const m = this.readInts(5);
    return { ascent: m[0], descent: m[1], leading: m[2], maxAdvance: m[3], height: m[4] };
  }

  advance(face: number, codepoint: number): number | null {
    if (this.wasm.ft_load_char(this.check(face), codepoint, 0) !== 0) return null;
    this.wasm.ft_glyph_info(face, this.ints);
    return this.readInts(1)[0];
  }

  glyph(face: number, codepoint: number): FreeTypeGlyph | null {
    if (this.wasm.ft_load_char(this.check(face), codepoint, 1) !== 0) return null;
    this.wasm.ft_glyph_info(face, this.ints);
    const [advance, left, top, width, rows, pixelMode] = this.readInts(6);
    const size = width * rows;
    let bitmap = new Uint8Array(0);
    if (size > 0) {
      const out = this.wasm.malloc(size);
      if (out === 0) throw new FreeTypeError(0x40, 'malloc');
      this.wasm.ft_glyph_bitmap(face, out);
      bitmap = new Uint8Array(this.wasm.memory.buffer, out, size).slice();
      this.wasm.free(out);
    }
    return { advance, bitmap, width, rows, left, top, pixelMode };
  }

  kerning(face: number, left: number, right: number): number {
    return this.wasm.ft_kerning(this.check(face), left, right);
  }

  memoryStats(): { readonly wasmBytes: number; readonly faces: number } {
    return { wasmBytes: this.wasm.memory.buffer.byteLength, faces: this.faces.size };
  }

  free(face: number): void {
    this.wasm.ft_done_face(this.check(face));
    this.faces.delete(face);
  }

  private check(face: number): number {
    if (!this.faces.has(face)) throw new Error(`FreeType: no face ${face}`);
    return face;
  }

  private readInts(n: number): Int32Array {
    return new Int32Array(this.wasm.memory.buffer, this.ints, n).slice();
  }

  private cString(ptr: number): string | null {
    if (ptr === 0) return null;
    const heap = new Uint8Array(this.wasm.memory.buffer);
    let end = ptr;
    while (heap[end] !== 0) end++;
    return new TextDecoder().decode(heap.subarray(ptr, end));
  }
}
