/*
 * libbluray's BD-J font and text natives over FreeType (src/wasm/freetype/freetype.wasm, through fonts/freetype.ts).
 * Ported from libbluray src/libbluray/bdj/native/java_awt_BDFontMetrics.c (Java_java_awt_BDFontMetrics_initN,
 * destroyN, unloadFontConfigN, resolveFontN, getFontFamilyAndStyleN, loadFontN, destroyFontN, charWidthN,
 * stringWidthN, charsWidthN) and java_awt_BDGraphics.c (Java_java_awt_BDGraphics_drawStringN, registered for
 * java.awt.BDGraphicsBase).
 * Copyright (C) 2012  libbluray
 *
 * Ported to TypeScript and modified for bluray-web, 2026: FT_New_Face reads the font file from the JVM's Vfs, and
 * FreeType itself is loaded the first time a font file is opened (initN does not need it); the "fontconfig" that
 * resolveFontN asks is the bundled fallback font (tools/bdj-trace/README.md, Fonts).
 *
 * SPDX-License-Identifier: LGPL-2.1-or-later
 */

import type { FreeType, FreeTypeGlyph } from '../../fonts/freetype';
import { FreeTypeError } from '../../fonts/freetype';
import { Invoke, Suspend } from '../interpreter';
import type { NativeResult } from '../interpreter';
import type { JClass, JMethod } from '../loader';
import type { JArray, JObject, JValue } from '../values';
import type { NativeContext, NativeTable } from './index';
import { absolute, readVfsFile } from './io';

export interface FontNativeDeps {
  /**
   * FreeType, loaded the first time a font file is opened; calls may share one load. Without it the natives behave
   * as libbluray built without FreeType (no HAVE_FT2): initN returns 0 and nothing is measured or drawn. A load that
   * fails is not tried again: every later font fails at once (loadFontN returns 0, so Java throws AWTError), instead of
   * each waiting up to the fetch's timeout under BDFontMetrics's class lock.
   */
  readonly loadFreeType?: () => Promise<FreeType>;
  /**
   * What resolveFontN returns for every family and style, as fontconfig would with only the fallback font installed
   * (fonts/system-fonts.ts DEFAULT_FONT_PATH). Without it resolveFontN returns null, as libbluray built without
   * fontconfig does.
   */
  readonly fallbackFontPath?: string;
  /** libbluray's BD_DEBUG(DBG_BDJ | DBG_CRIT) lines, and a failed FreeType load. */
  readonly log?: (line: string) => void;
}

/** The FT_Library handle initN returns (FreeType itself is loaded later). */
const LIB = 1n;

export function registerFontNatives(table: NativeTable, deps: FontNativeDeps = {}): void {
  const log = deps.log ?? (() => {});
  let ft: FreeType | null = null;
  let loading: Promise<void> | null = null;
  /** FreeType could not be loaded: not tried again in this JVM. */
  let failed = false;
  /** Live faces: the handle Java holds (FT_Face) to FreeType's face. */
  const faces = new Map<bigint, number>();

  const faceOf = (handle: JValue): number | null => (handle === 0n ? null : (faces.get(handle as bigint) ?? null));

  /** Runs `k` with FreeType, loading it first (the calling thread parks meanwhile); null when it cannot be loaded. */
  const withFreeType = (k: (ft: FreeType | null) => NativeResult): NativeResult => {
    if (ft || failed || !deps.loadFreeType) return k(ft);
    const load = deps.loadFreeType;
    loading ??= load().then(
      (loaded) => {
        ft = loaded;
      },
      (e: unknown) => {
        failed = true; // later fonts fail at once
        log(`BD-J: FreeType could not be loaded: ${e instanceof Error ? e.message : String(e)}`);
      },
    );
    return new Suspend(
      loading.then(() => undefined),
      () => k(ft),
    );
  };

  /** FT_New_Face(lib, name, 0): the file from the Vfs, then FreeType; null when either fails. */
  const newFace = (ctx: NativeContext, name: JValue, k: (ft: FreeType, face: number) => NativeResult, failed: () => NativeResult): NativeResult => {
    const jvm = ctx.jvm;
    const path = jvm.heap.jsString(name as JObject | null);
    if (path === null) return jvm.throwNew('java/lang/NullPointerException');
    const vfs = jvm.opts.vfs;
    if (!vfs) return failed();
    return readVfsFile(vfs, absolute(path), (bytes) =>
      bytes === null
        ? failed()
        : withFreeType((freeType) => {
            if (!freeType) return failed();
            let face: number;
            try {
              face = freeType.newFace(bytes, 0);
            } catch (e) {
              if (e instanceof FreeTypeError) return failed();
              throw e;
            }
            return k(freeType, face);
          }),
    );
  };

  const string = (ctx: NativeContext, s: JValue): string | null => ctx.jvm.heap.jsString(s as JObject | null);

  table.register({
    'java/awt/BDFontMetrics.unloadFontConfigN()V': () => undefined,

    'java/awt/BDFontMetrics.resolveFontN(Ljava/lang/String;I)Ljava/lang/String;': (ctx) => {
      if (deps.fallbackFontPath === undefined) {
        log('BD-J font config support not compiled in');
        return null;
      }
      return ctx.jvm.heap.newString(deps.fallbackFontPath);
    },

    'java/awt/BDFontMetrics.initN()J': () => {
      if (deps.loadFreeType) return LIB;
      log('BD-J font support not compiled in');
      return 0n;
    },

    'java/awt/BDFontMetrics.destroyN(J)V': (_ctx, lib) => {
      if (!deps.loadFreeType || lib === 0n) return undefined;
      // FT_Done_FreeType destroys the faces still open
      for (const face of faces.values()) ft?.free(face);
      faces.clear();
      return undefined;
    },

    'java/awt/BDFontMetrics.getFontFamilyAndStyleN(JLjava/lang/String;)[Ljava/lang/String;': (ctx, lib, name) => {
      const jvm = ctx.jvm;
      const array = jvm.heap.newArray(jvm.loader.arrayOf(jvm.bootClass('java/lang/String')), 2);
      if (!deps.loadFreeType) return array;
      if (lib === 0n) return null;
      return newFace(
        ctx,
        name,
        (freeType, face) => {
          const family = freeType.familyName(face);
          const style = freeType.styleName(face);
          freeType.free(face);
          // NewStringUTF(NULL) is null
          (array.data as JValue[])[0] = family === null ? null : jvm.heap.newString(family);
          (array.data as JValue[])[1] = style === null ? null : jvm.heap.newString(style);
          return array;
        },
        () => null,
      );
    },

    'java/awt/BDFontMetrics.loadFontN(JLjava/lang/String;I)J': (ctx, self, lib, name, size) => {
      if (!deps.loadFreeType || lib === 0n) return 0n;
      return newFace(
        ctx,
        name,
        (freeType, face) => {
          freeType.setSize(face, size as number); // FT_Set_Char_Size(face, 0, size << 6, 0, 0); its error is ignored
          const m = freeType.metrics(face);
          const jvm = ctx.jvm;
          const o = self as JObject;
          jvm.setField(o, 'ascent', 'I', m.ascent);
          jvm.setField(o, 'descent', 'I', m.descent);
          jvm.setField(o, 'leading', 'I', m.leading);
          jvm.setField(o, 'maxAdvance', 'I', m.maxAdvance);
          const handle = BigInt(face);
          faces.set(handle, face);
          return handle;
        },
        () => 0n,
      );
    },

    'java/awt/BDFontMetrics.destroyFontN(J)V': (_ctx, _self, handle) => {
      const face = faceOf(handle);
      if (face === null) return undefined;
      ft!.free(face);
      faces.delete(handle as bigint);
      return undefined;
    },

    'java/awt/BDFontMetrics.charWidthN(JC)I': (_ctx, _self, handle, c) => {
      const face = faceOf(handle);
      if (face === null) return 0;
      return ft!.advance(face, c as number) ?? 0;
    },

    'java/awt/BDFontMetrics.stringWidthN(JLjava/lang/String;)I': (ctx, _self, handle, s) => {
      const face = faceOf(handle);
      if (face === null) return 0;
      const chars = string(ctx, s);
      if (chars === null) return ctx.jvm.throwNew('java/lang/NullPointerException');
      let width = 0;
      for (let i = 0; i < chars.length; i++) width = (width + (ft!.advance(face, chars.charCodeAt(i)) ?? 0)) | 0;
      return width;
    },

    'java/awt/BDFontMetrics.charsWidthN(J[CII)I': (ctx, _self, handle, charArray, offset, length) => {
      const face = faceOf(handle);
      if (face === null) return 0;
      const off = offset as number;
      const len = length as number;
      // malloc(sizeof(jchar) * length) fails for a negative length
      if (len < 0) return 0;
      if (charArray === null) return ctx.jvm.throwNew('java/lang/NullPointerException');
      const chars = (charArray as JArray).data as Uint16Array;
      // GetCharArrayRegion throws; the native sees the exception and returns 0
      if (off < 0 || off + len > chars.length) return ctx.jvm.throwNew('java/lang/ArrayIndexOutOfBoundsException');
      let width = 0;
      for (let i = 0; i < len; i++) width = (width + (ft!.advance(face, chars[off + i]!) ?? 0)) | 0;
      return width;
    },

    'java/awt/BDGraphicsBase.drawStringN(JLjava/lang/String;III)V': (ctx, self, handle, s, x, y, rgb) => {
      const face = faceOf(handle);
      if (face === null) return undefined;
      const jvm = ctx.jvm;
      const chars = string(ctx, s);
      if (chars === null) return jvm.throwNew('java/lang/NullPointerException');
      if (chars.length <= 0) return undefined;
      const drawPoint = findMethod(self as JObject, 'drawPoint(III)V');
      if (!drawPoint) return jvm.throwNew('java/lang/NoSuchMethodError', 'drawPoint');
      const lib = ft!;
      const a = ((rgb as number) >>> 24) & 0xff;
      const c = (rgb as number) & 0xffffff;
      let penX = x as number;
      const penY = y as number;
      let i = 0;
      let glyph: FreeTypeGlyph | null = null;
      let p = 0;
      // CallVoidMethod(obj, drawPoint, x + bitmap_left + k, y - bitmap_top + j, pixel) for every pixel of every glyph
      const step = (): NativeResult => {
        for (;;) {
          if (glyph !== null) {
            if (p < glyph.bitmap.length) {
              const j = (p / glyph.width) | 0;
              const k = p - j * glyph.width;
              const pixel = glyph.bitmap[p++]!;
              const argb = ((((a * pixel) / 255) | 0) << 24) | c;
              return new Invoke(drawPoint, [self, (penX + glyph.left + k) | 0, (penY - glyph.top + j) | 0, argb], step);
            }
            penX = (penX + glyph.advance) | 0;
            glyph = null;
          }
          if (i >= chars.length) return undefined;
          glyph = lib.glyph(face, chars.charCodeAt(i++)); // a character that fails to load is skipped, pen and all
          p = 0;
        }
      };
      return step();
    },
  });
}

/** GetMethodID(GetObjectClass(obj), name, sig): the class's own method or its superclasses'. */
function findMethod(obj: JObject, key: string): JMethod | null {
  for (let c: JClass | null = obj.cls; c; c = c.superClass) {
    const m = c.methods.get(key);
    if (m) return m;
  }
  return null;
}
