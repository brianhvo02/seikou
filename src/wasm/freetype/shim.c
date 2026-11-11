/*
 * FreeType for Seikou's BD-J text: the calls libbluray's BD-J natives make (bdj/native/java_awt_BDFontMetrics.c,
 * java_awt_BDGraphics.c), with the same arguments and load flags, so that src/engine/bdj/fonts/freetype.ts can give
 * the port of those natives FreeType's results unchanged.
 *
 *   loadFontN       FT_New_Face (here from memory, face index 0 unless asked), FT_Set_Char_Size(face, 0, size << 6,
 *                   0, 0) and the size metrics shifted as libbluray shifts them
 *   charWidthN etc. FT_Load_Char(face, c, FT_LOAD_DEFAULT), metrics.horiAdvance >> 6
 *   drawStringN     FT_Load_Char(face, c, FT_LOAD_RENDER), then bitmap.buffer[j * pitch + k] for k < width
 *   getFontFamilyAndStyleN  family_name, style_name
 *
 * Copyright (C) 2026  Seikou contributors
 * SPDX-License-Identifier: LGPL-2.1-or-later
 */

#include <ft2build.h>
#include FT_FREETYPE_H

#include <stdint.h>
#include <stdlib.h>
#include <string.h>

#define EXPORT __attribute__((used, visibility("default")))

typedef struct {
    FT_Face face;
    unsigned char *data; /* the font file; FreeType reads it for as long as the face lives */
} Face;

static FT_Library lib;
static int last_error;

/* FT_Init_FreeType once; 0 or the FreeType error. */
EXPORT int ft_init(void)
{
    if (lib)
        return 0;
    return FT_Init_FreeType(&lib);
}

/* The error of the last ft_new_face that returned 0. */
EXPORT int ft_last_error(void)
{
    return last_error;
}

/* Opens a face from a malloc'd font file, which the face then owns (freed by ft_done_face, or here on failure). */
EXPORT Face *ft_new_face(unsigned char *data, int length, int index)
{
    Face *h = calloc(1, sizeof *h);
    if (!h) {
        free(data);
        last_error = FT_Err_Out_Of_Memory;
        return 0;
    }
    last_error = FT_New_Memory_Face(lib, data, length, index, &h->face);
    if (last_error) {
        free(data);
        free(h);
        return 0;
    }
    h->data = data;
    return h;
}

EXPORT void ft_done_face(Face *h)
{
    FT_Done_Face(h->face);
    free(h->data);
    free(h);
}

EXPORT const char *ft_family_name(Face *h)
{
    return h->face->family_name;
}

EXPORT const char *ft_style_name(Face *h)
{
    return h->face->style_name;
}

/* loadFontN's size: size points at the default 72 dpi. */
EXPORT int ft_set_char_size(Face *h, int size)
{
    return FT_Set_Char_Size(h->face, 0, (FT_F26Dot6)size << 6, 0, 0);
}

/* out: ascent, descent, leading, maxAdvance (loadFontN's fields, its expressions) and height, in pixels. */
EXPORT void ft_size_metrics(Face *h, int32_t *out)
{
    FT_Size_Metrics *m = &h->face->size->metrics;
    out[0] = (int32_t)(m->ascender >> 6);
    out[1] = (int32_t)(-m->descender >> 6);
    out[2] = (int32_t)((m->height - m->ascender + m->descender) >> 6);
    out[3] = (int32_t)(m->max_advance >> 6);
    out[4] = (int32_t)(m->height >> 6);
}

/* FT_Load_Char with FT_LOAD_RENDER (render != 0) or FT_LOAD_DEFAULT; 0 or the FreeType error. */
EXPORT int ft_load_char(Face *h, uint32_t c, int render)
{
    return FT_Load_Char(h->face, c, render ? FT_LOAD_RENDER : FT_LOAD_DEFAULT);
}

/* After ft_load_char. out: horiAdvance >> 6, bitmap_left, bitmap_top, bitmap width, rows, pixel_mode. */
EXPORT void ft_glyph_info(Face *h, int32_t *out)
{
    FT_GlyphSlot g = h->face->glyph;
    out[0] = (int32_t)(g->metrics.horiAdvance >> 6);
    out[1] = g->bitmap_left;
    out[2] = g->bitmap_top;
    out[3] = (int32_t)g->bitmap.width;
    out[4] = (int32_t)g->bitmap.rows;
    out[5] = g->bitmap.pixel_mode;
}

/*
 * After ft_load_char with render: the width * rows bytes drawStringN reads, buffer[j * pitch + k] for k < width.
 * That is the coverage of a gray bitmap; for other pixel modes it is what libbluray reads too, bounded to the buffer
 * (0 past it, where libbluray would read beyond).
 */
EXPORT void ft_glyph_bitmap(Face *h, uint8_t *out)
{
    FT_Bitmap *b = &h->face->glyph->bitmap;
    long size = (long)(b->pitch < 0 ? -b->pitch : b->pitch) * b->rows;
    for (unsigned j = 0; j < b->rows; j++)
        for (unsigned k = 0; k < b->width; k++) {
            long i = (long)j * b->pitch + k;
            out[j * b->width + k] = i >= 0 && i < size ? b->buffer[i] : 0;
        }
}

/* FT_Get_Kerning (FT_KERNING_DEFAULT) between two characters: the x of the vector, 26.6 pixels; 0 on error. */
EXPORT int32_t ft_kerning(Face *h, uint32_t left, uint32_t right)
{
    FT_Vector v = { 0, 0 };
    if (FT_Get_Kerning(h->face, FT_Get_Char_Index(h->face, left), FT_Get_Char_Index(h->face, right),
                       FT_KERNING_DEFAULT, &v))
        return 0;
    return (int32_t)v.x;
}
