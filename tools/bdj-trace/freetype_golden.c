/*
 * Golden values for Seikou's freetype.wasm (src/wasm/freetype/), from the system FreeType that the libbluray
 * BD-J harness links. It makes the FreeType calls libbluray's BD-J text natives make
 * (bdj/native/java_awt_BDFontMetrics.c loadFontN, charWidthN, getFontFamilyAndStyleN; java_awt_BDGraphics.c
 * drawStringN) and prints their results as JSON. Run by freetype-golden.sh; the output is
 * tests/bdj/fonts/freetype-golden.json.
 *
 * Usage: freetype_golden <font file>
 *
 * Copyright (C) 2026  Seikou contributors
 * SPDX-License-Identifier: LGPL-2.1-or-later
 */

#include <ft2build.h>
#include FT_FREETYPE_H

#include <stdio.h>
#include <stdlib.h>

static const int SIZES[] = { 12, 16, 24, 36, 40, 48, 72 };
/* printable ASCII, then a few non-ASCII characters the font has, then one it lacks (U+3042, glyph 0) */
static const unsigned EXTRA[] = { 0xe9, 0xdf, 0x3a9, 0x416, 0x20ac, 0x3042 };
static const unsigned KERN_PAIRS[][2] = { { 'A', 'V' }, { 'T', 'o' }, { 'L', 'T' }, { 'a', 'b' } };

static void base64(const unsigned char *p, size_t n)
{
    static const char T[] = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    for (size_t i = 0; i < n; i += 3) {
        unsigned v = p[i] << 16 | (i + 1 < n ? p[i + 1] << 8 : 0) | (i + 2 < n ? p[i + 2] : 0);
        putchar(T[v >> 18 & 63]);
        putchar(T[v >> 12 & 63]);
        putchar(i + 1 < n ? T[v >> 6 & 63] : '=');
        putchar(i + 2 < n ? T[v & 63] : '=');
    }
}

static void glyph(FT_Face face, unsigned c, int first)
{
    FT_Error err;
    long width_advance = 0;

    /* charWidthN */
    err = FT_Load_Char(face, c, FT_LOAD_DEFAULT);
    if (!err)
        width_advance = face->glyph->metrics.horiAdvance >> 6;
    printf("%s\n      {\"code\":%u,\"widthError\":%d,\"widthAdvance\":%ld", first ? "" : ",", c, err, width_advance);

    /* drawStringN: the bytes it reads, buffer[j * pitch + k] for k < width (bounded to the buffer) */
    err = FT_Load_Char(face, c, FT_LOAD_RENDER);
    printf(",\"renderError\":%d", err);
    if (!err) {
        FT_GlyphSlot g = face->glyph;
        unsigned rows = g->bitmap.rows, width = g->bitmap.width;
        long size = (long)(g->bitmap.pitch < 0 ? -g->bitmap.pitch : g->bitmap.pitch) * rows;
        unsigned char *bytes = malloc(rows * width + 1);
        for (unsigned j = 0; j < rows; j++)
            for (unsigned k = 0; k < width; k++) {
                long i = (long)j * g->bitmap.pitch + k;
                bytes[j * width + k] = i >= 0 && i < size ? g->bitmap.buffer[i] : 0;
            }
        printf(",\"advance\":%ld,\"left\":%d,\"top\":%d,\"width\":%u,\"rows\":%u,\"pixelMode\":%d,\"bitmap\":\"",
               g->metrics.horiAdvance >> 6, g->bitmap_left, g->bitmap_top, width, rows, g->bitmap.pixel_mode);
        base64(bytes, (size_t)rows * width);
        putchar('"');
        free(bytes);
    }
    putchar('}');
}

int main(int argc, char **argv)
{
    FT_Library lib;
    FT_Face face;
    FT_Int major, minor, patch;

    if (argc != 2) {
        fprintf(stderr, "usage: %s <font file>\n", argv[0]);
        return 2;
    }
    if (FT_Init_FreeType(&lib) || FT_New_Face(lib, argv[1], 0, &face)) {
        fprintf(stderr, "cannot open %s\n", argv[1]);
        return 1;
    }
    FT_Library_Version(lib, &major, &minor, &patch);
    printf("{\n  \"freetype\": \"%d.%d.%d\",\n  \"family\": \"%s\",\n  \"style\": \"%s\",\n  \"sizes\": [",
           major, minor, patch, face->family_name, face->style_name);
    FT_Done_Face(face);

    for (size_t s = 0; s < sizeof SIZES / sizeof SIZES[0]; s++) {
        int size = SIZES[s];
        /* loadFontN: one face per font object, opened from the file and sized like this */
        if (FT_New_Face(lib, argv[1], 0, &face))
            return 1;
        FT_Set_Char_Size(face, 0, size << 6, 0, 0);
        FT_Size_Metrics *m = &face->size->metrics;
        printf("%s\n    {\n      \"size\": %d,\n", s ? "," : "", size);
        printf("      \"metrics\": {\"ascent\":%ld,\"descent\":%ld,\"leading\":%ld,\"maxAdvance\":%ld,\"height\":%ld},\n",
               m->ascender >> 6, -m->descender >> 6, (m->height - m->ascender + m->descender) >> 6,
               m->max_advance >> 6, m->height >> 6);
        printf("      \"kerning\": [");
        for (size_t k = 0; k < sizeof KERN_PAIRS / sizeof KERN_PAIRS[0]; k++) {
            FT_Vector v = { 0, 0 };
            FT_Get_Kerning(face, FT_Get_Char_Index(face, KERN_PAIRS[k][0]), FT_Get_Char_Index(face, KERN_PAIRS[k][1]),
                           FT_KERNING_DEFAULT, &v);
            printf("%s{\"left\":%u,\"right\":%u,\"x\":%ld}", k ? "," : "", KERN_PAIRS[k][0], KERN_PAIRS[k][1], v.x);
        }
        printf("],\n      \"glyphs\": [");
        int first = 1;
        for (unsigned c = 32; c < 127; c++, first = 0)
            glyph(face, c, first);
        for (size_t e = 0; e < sizeof EXTRA / sizeof EXTRA[0]; e++)
            glyph(face, EXTRA[e], 0);
        printf("\n      ]\n    }");
        FT_Done_Face(face);
    }
    printf("\n  ]\n}\n");
    FT_Done_FreeType(lib);
    return 0;
}
