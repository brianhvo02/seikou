/*
 * Golden values for bluray-web's BD-J font and text natives (src/bdj/jvm/natives/fonts.ts), made by libbluray's
 * own natives: this program links the harness image's compiled bdj/native/java_awt_BDFontMetrics.c and
 * java_awt_BDGraphics.c objects (from the libbluray build in /src/libbluray/build, the same code libbluray.so
 * carries, against the same system FreeType) and calls them through their JNINativeMethod tables with a small fake
 * JNIEnv that records what they do. Run by text-golden.sh; the output is tests/bdj/fonts/text-golden.json.
 *
 * For each font and size: the fields loadFontN sets, charWidthN of characters 0-255 (BDFontMetrics.loadWidths) and a
 * few more, stringWidthN and charsWidthN of some strings, and drawStringN of some strings: the drawPoint(x, y, argb)
 * calls it makes, and the int[] back buffer those calls leave when BDGraphicsBase.drawPoint runs them with the default
 * composite (AlphaComposite.SrcOver) over a fixed background. That last step is a transliteration of libbluray's Java
 * (java/awt/BDGraphicsBase.java drawPoint, drawPointN, drawSpanN, applyComposite and alphaBlend, for a graphics whose
 * clip is the whole buffer and whose origin is 0, 0), so the Vitest side can run the real Java in bluray-web's JVM and
 * compare.
 *
 * Usage: text_golden <fallback font path> <disc font path> <missing path> <non-font file>
 *
 * Copyright (C) 2026  bluray-web contributors
 * SPDX-License-Identifier: LGPL-2.1-or-later
 */

#include <jni.h>

#include <stdarg.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

/* libbluray's tables (bdj/native/java_awt_BDFontMetrics.c, java_awt_BDGraphics.c) */
extern const JNINativeMethod Java_java_awt_BDFontMetrics_methods[];
extern const int Java_java_awt_BDFontMetrics_methods_count;
extern const JNINativeMethod Java_java_awt_BDGraphics_methods[];
extern const int Java_java_awt_BDGraphics_methods_count;

/* What the objects link against from the rest of libbluray: logging (off) and bdj/native/util.c's bdj_make_array. */
uint32_t debug_mask = 0;
void bdpriv_debug(const char *file, int line, uint32_t mask, const char *format, ...);
void bdpriv_debug(const char *file, int line, uint32_t mask, const char *format, ...)
{
    (void)file, (void)line, (void)mask, (void)format;
}

enum kind { K_STRING = 1, K_METRICS, K_ARRAY, K_CHARS, K_GRAPHICS };

typedef struct { enum kind kind; } obj_t;
typedef struct { obj_t o; const jchar *u16; jsize len; const char *utf; } string_t;
typedef struct { obj_t o; jint ascent, descent, leading, maxAdvance; } metrics_t;
typedef struct { obj_t o; jobject items[8]; jsize count; } array_t;
typedef struct { obj_t o; const jchar *chars; jsize len; } chars_t;
typedef struct { obj_t o; int32_t *calls; size_t n, cap; } graphics_t;

static int pending_exception;
static int bad_call;
static const char *FIELDS[] = { "ascent", "descent", "leading", "maxAdvance" };
static int DRAW_POINT;

jobjectArray bdj_make_array(JNIEnv *env, const char *name, int count);
jobjectArray bdj_make_array(JNIEnv *env, const char *name, int count)
{
    (void)env;
    array_t *a = calloc(1, sizeof *a);
    if (strcmp(name, "java/lang/String") || count < 0 || count > 8)
        bad_call = 1;
    a->o.kind = K_ARRAY;
    a->count = count;
    return (jobjectArray)a;
}

static jclass JNICALL get_object_class(JNIEnv *env, jobject obj)
{
    (void)env;
    return (jclass)obj;
}

static jmethodID JNICALL get_method_id(JNIEnv *env, jclass cls, const char *name, const char *sig)
{
    (void)env;
    if (((obj_t *)cls)->kind != K_GRAPHICS || strcmp(name, "drawPoint") || strcmp(sig, "(III)V")) {
        bad_call = 1;
        return NULL;
    }
    return (jmethodID)&DRAW_POINT;
}

static void JNICALL call_void_method(JNIEnv *env, jobject obj, jmethodID mid, ...)
{
    (void)env;
    graphics_t *g = (graphics_t *)obj;
    va_list ap;
    if (g->o.kind != K_GRAPHICS || mid != (jmethodID)&DRAW_POINT) {
        bad_call = 1;
        return;
    }
    if (g->n + 3 > g->cap) {
        g->cap = g->cap ? g->cap * 2 : 4096;
        g->calls = realloc(g->calls, g->cap * sizeof *g->calls);
    }
    va_start(ap, mid);
    for (int i = 0; i < 3; i++)
        g->calls[g->n++] = va_arg(ap, jint);
    va_end(ap);
}

static jfieldID JNICALL get_field_id(JNIEnv *env, jclass cls, const char *name, const char *sig)
{
    (void)env;
    if (((obj_t *)cls)->kind != K_METRICS || strcmp(sig, "I"))
        bad_call = 1;
    for (size_t i = 0; i < sizeof FIELDS / sizeof FIELDS[0]; i++)
        if (!strcmp(name, FIELDS[i]))
            return (jfieldID)&FIELDS[i];
    bad_call = 1;
    return NULL;
}

static void JNICALL set_int_field(JNIEnv *env, jobject obj, jfieldID fid, jint val)
{
    (void)env;
    metrics_t *m = (metrics_t *)obj;
    if (fid == (jfieldID)&FIELDS[0]) m->ascent = val;
    else if (fid == (jfieldID)&FIELDS[1]) m->descent = val;
    else if (fid == (jfieldID)&FIELDS[2]) m->leading = val;
    else if (fid == (jfieldID)&FIELDS[3]) m->maxAdvance = val;
    else bad_call = 1;
}

static jsize JNICALL get_string_length(JNIEnv *env, jstring s)
{
    (void)env;
    return ((string_t *)s)->len;
}

static const jchar *JNICALL get_string_critical(JNIEnv *env, jstring s, jboolean *is_copy)
{
    (void)env;
    if (is_copy) *is_copy = JNI_FALSE;
    return ((string_t *)s)->u16;
}

static void JNICALL release_string_critical(JNIEnv *env, jstring s, const jchar *chars)
{
    (void)env, (void)s, (void)chars;
}

static const char *JNICALL get_string_utf_chars(JNIEnv *env, jstring s, jboolean *is_copy)
{
    (void)env;
    if (is_copy) *is_copy = JNI_FALSE;
    return ((string_t *)s)->utf;
}

static void JNICALL release_string_utf_chars(JNIEnv *env, jstring s, const char *chars)
{
    (void)env, (void)s, (void)chars;
}

static jstring JNICALL new_string_utf(JNIEnv *env, const char *utf)
{
    (void)env;
    if (!utf)
        return NULL;
    string_t *s = calloc(1, sizeof *s);
    s->o.kind = K_STRING;
    s->utf = strdup(utf);
    return (jstring)s;
}

static void JNICALL set_object_array_element(JNIEnv *env, jobjectArray array, jsize index, jobject val)
{
    (void)env;
    array_t *a = (array_t *)array;
    if (index < 0 || index >= a->count) {
        bad_call = 1;
        return;
    }
    a->items[index] = val;
}

static void JNICALL get_char_array_region(JNIEnv *env, jcharArray array, jsize start, jsize len, jchar *buf)
{
    (void)env;
    chars_t *c = (chars_t *)array;
    if (start < 0 || len < 0 || (int64_t)start + len > c->len) {
        pending_exception = 1; /* ArrayIndexOutOfBoundsException */
        return;
    }
    memcpy(buf, c->chars + start, (size_t)len * sizeof *buf);
}

static jboolean JNICALL exception_check(JNIEnv *env)
{
    (void)env;
    return pending_exception ? JNI_TRUE : JNI_FALSE;
}

static struct JNINativeInterface_ functions;
static JNIEnv env_value = &functions;
static JNIEnv *env = &env_value;

static void *native(const JNINativeMethod *table, int count, const char *name)
{
    for (int i = 0; i < count; i++)
        if (!strcmp(table[i].name, name))
            return table[i].fnPtr;
    fprintf(stderr, "no native %s\n", name);
    exit(1);
}

static jlong (*initN)(JNIEnv *, jclass);
static jobjectArray (*getFontFamilyAndStyleN)(JNIEnv *, jclass, jlong, jstring);
static jlong (*loadFontN)(JNIEnv *, jobject, jlong, jstring, jint);
static void (*destroyFontN)(JNIEnv *, jobject, jlong);
static jint (*charWidthN)(JNIEnv *, jobject, jlong, jchar);
static jint (*stringWidthN)(JNIEnv *, jobject, jlong, jstring);
static jint (*charsWidthN)(JNIEnv *, jobject, jlong, jcharArray, jint, jint);
static void (*drawStringN)(JNIEnv *, jobject, jlong, jstring, jint, jint, jint);

static jstring u16_string(const jchar *u16, jsize len)
{
    string_t *s = calloc(1, sizeof *s);
    s->o.kind = K_STRING;
    s->u16 = u16;
    s->len = len;
    return (jstring)s;
}

static jstring path_string(const char *path)
{
    string_t *s = calloc(1, sizeof *s);
    s->o.kind = K_STRING;
    s->utf = path;
    return (jstring)s;
}

/* The strings (UTF-16 code units, as Java passes them). */
static const jchar S_PLAY[] = { 'P', 'L', 'A', 'Y' };
/* "Menü – Ωé€ あ😀": non-ASCII, a character the fonts lack (U+3042) and a surrogate pair */
static const jchar S_MIXED[] = { 'M', 'e', 'n', 0xfc, ' ', 0x2013, ' ', 0x3a9, 0xe9, 0x20ac, ' ', 0x3042, 0xd83d, 0xde00 };
static const jchar S_CLIP[] = { 'C', 'l', 'i', 'p' };
static const jchar S_EDGE[] = { 'E', 'd', 'g', 'e' };
static const jchar S_KERN[] = { 'A', 'V', ' ', 'T', 'o' };
static const jchar S_CHARS[] = { 'x', 'x', 'P', 'L', 'A', 'Y', 'x', 'x' };

typedef struct { const char *name; const jchar *u16; jsize len; } text_t;
static const text_t TEXTS[] = {
    { "PLAY", S_PLAY, 4 },
    { "mixed", S_MIXED, 14 },
    { "empty", S_PLAY, 0 },
    { "kern", S_KERN, 5 },
    { "clip", S_CLIP, 4 },
    { "edge", S_EDGE, 4 },
};

typedef struct { int text; jint x, y; uint32_t rgb; int points; } draw_t;
static const draw_t DRAWS[] = {
    { 0, 70, 40, 0xffffffffu, 1 },   /* across the transparent / opaque boundary at x 80 */
    { 1, 150, 44, 0xc0ffd700u, 0 },  /* translucent, across the semi-transparent bands */
    { 4, -7, 8, 0x80102030u, 0 },    /* clipped at the left and top */
    { 5, 290, 70, 0x00ffffffu, 0 },  /* alpha 0, clipped at the right and bottom */
};

static const int SIZES[] = { 16, 24, 36, 40, 48, 72 };
static const unsigned EXTRA_CHARS[] = { 0x3042, 0x20ac, 0xd83d, 0xffff };
typedef struct { jint offset, length; } span_t;
static const span_t CHAR_SPANS[] = { { 2, 4 }, { 0, 0 }, { 0, 8 }, { 6, 4 }, { -1, 2 }, { 0, -1 } };

/* The back buffer: 320 x 64, in four bands of background. */
#define BUF_W 320
#define BUF_H 64

static int32_t background(int x)
{
    if (x < BUF_W / 4) return 0;
    if (x < BUF_W / 2) return (int32_t)0xff203040u;
    if (x < BUF_W * 3 / 4) return (int32_t)0x80ff0000u;
    return (int32_t)0x40ffffffu;
}

/* java/awt/BDGraphicsBase.java alphaBlend, in Java int arithmetic (>>> on the int's bits) */
static int32_t alpha_blend(int32_t dest, int32_t src)
{
    int32_t As = (int32_t)((uint32_t)src >> 24);
    if (As == 0)
        return dest;
    if (As == 255)
        return src;
    int32_t Ad = (int32_t)((uint32_t)dest >> 24);
    if (Ad == 0)
        return src;
    int32_t R, G, B;
    R = (int32_t)(((uint32_t)src >> 16) & 255) * As * 255;
    G = (int32_t)(((uint32_t)src >> 8) & 255) * As * 255;
    B = (src & 255) * As * 255;
    Ad = Ad * (255 - As);
    As = As * 255 + Ad;
    R = (R + (int32_t)(((uint32_t)dest >> 16) & 255) * Ad) / As;
    G = (G + (int32_t)(((uint32_t)dest >> 8) & 255) * Ad) / As;
    B = (B + (dest & 255) * Ad) / As;
    R = R < 255 ? R : 255;
    G = G < 255 ? G : 255;
    B = B < 255 ? B : 255;
    Ad = As / 255;
    Ad = Ad < 255 ? Ad : 255;
    return (int32_t)(((uint32_t)Ad << 24) | ((uint32_t)R << 16) | ((uint32_t)G << 8) | (uint32_t)B);
}

/* drawPoint(x, y, rgb) with originX = originY = 0 and actualClip = (0, 0, BUF_W, BUF_H): actualClip.contains, then
 * drawSpanN(x, y, 1, rgb) with AlphaComposite.SrcOver (rule SRC_OVER, extraAlpha 1.0f, so applyComposite keeps rgb) */
static void draw_point(int32_t *buf, int32_t x, int32_t y, int32_t rgb)
{
    if (x < 0 || y < 0 || x >= BUF_W || y >= BUF_H)
        return;
    int32_t alpha = (int32_t)(float)((float)((uint32_t)rgb >> 24) * 1.0f);
    rgb = (int32_t)(((uint32_t)alpha << 24) | ((uint32_t)rgb & 0x00ffffffu));
    buf[y * BUF_W + x] = alpha_blend(buf[y * BUF_W + x], rgb);
}

/* FNV-1a 32 over the words' little-endian bytes (tools/bdj-trace/README.md, Planes) */
static uint32_t fnv(const int32_t *words, size_t n)
{
    uint32_t h = 0x811c9dc5u;
    for (size_t i = 0; i < n; i++)
        for (int b = 0; b < 32; b += 8)
            h = (h ^ (((uint32_t)words[i] >> b) & 0xff)) * 0x01000193u;
    return h;
}

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

static void print_u16(const jchar *u16, jsize len)
{
    putchar('[');
    for (jsize i = 0; i < len; i++)
        printf("%s%u", i ? "," : "", u16[i]);
    putchar(']');
}

static void print_family(jlong lib, const char *path)
{
    array_t *a = (array_t *)getFontFamilyAndStyleN(env, NULL, lib, path_string(path));
    if (!a) {
        printf("null");
        return;
    }
    printf("[");
    for (jsize i = 0; i < a->count; i++) {
        string_t *s = (string_t *)a->items[i];
        if (s) printf("%s\"%s\"", i ? "," : "", s->utf);
        else printf("%snull", i ? "," : "");
    }
    printf("]");
}

static void font(jlong lib, const char *label, const char *path, int first)
{
    printf("%s\n    {\n      \"name\": \"%s\",\n      \"familyAndStyle\": ", first ? "" : ",", label);
    print_family(lib, path);
    printf(",\n      \"sizes\": [");
    for (size_t s = 0; s < sizeof SIZES / sizeof SIZES[0]; s++) {
        metrics_t m = { { K_METRICS }, 0, 0, 0, 0 };
        jlong face = loadFontN(env, (jobject)&m, lib, path_string(path), SIZES[s]);
        if (!face) {
            fprintf(stderr, "loadFontN %s failed\n", path);
            exit(1);
        }
        printf("%s\n        {\n          \"size\": %d,\n", s ? "," : "", SIZES[s]);
        printf("          \"metrics\": {\"ascent\":%d,\"descent\":%d,\"leading\":%d,\"maxAdvance\":%d},\n", m.ascent, m.descent,
               m.leading, m.maxAdvance);
        printf("          \"charWidths\": [");
        for (unsigned c = 0; c < 256; c++)
            printf("%s%d", c ? "," : "", charWidthN(env, (jobject)&m, face, (jchar)c));
        printf("],\n          \"extraCharWidths\": [");
        for (size_t i = 0; i < sizeof EXTRA_CHARS / sizeof EXTRA_CHARS[0]; i++)
            printf("%s{\"code\":%u,\"width\":%d}", i ? "," : "", EXTRA_CHARS[i], charWidthN(env, (jobject)&m, face, (jchar)EXTRA_CHARS[i]));
        printf("],\n          \"stringWidths\": [");
        for (size_t i = 0; i < 4; i++) {
            printf("%s{\"text\":", i ? "," : "");
            print_u16(TEXTS[i].u16, TEXTS[i].len);
            printf(",\"width\":%d}", stringWidthN(env, (jobject)&m, face, u16_string(TEXTS[i].u16, TEXTS[i].len)));
        }
        printf("],\n          \"charsWidths\": [");
        chars_t chars = { { K_CHARS }, S_CHARS, 8 };
        for (size_t i = 0; i < sizeof CHAR_SPANS / sizeof CHAR_SPANS[0]; i++) {
            pending_exception = 0;
            jint w = charsWidthN(env, (jobject)&m, face, (jcharArray)&chars, CHAR_SPANS[i].offset, CHAR_SPANS[i].length);
            printf("%s{\"offset\":%d,\"length\":%d,\"width\":%d,\"exception\":%s}", i ? "," : "", CHAR_SPANS[i].offset,
                   CHAR_SPANS[i].length, w, pending_exception ? "true" : "false");
            pending_exception = 0;
        }
        printf("],\n          \"draws\": [");
        for (size_t d = 0; d < sizeof DRAWS / sizeof DRAWS[0]; d++) {
            const draw_t *dr = &DRAWS[d];
            const text_t *t = &TEXTS[dr->text];
            graphics_t g = { { K_GRAPHICS }, NULL, 0, 0 };
            drawStringN(env, (jobject)&g, face, u16_string(t->u16, t->len), dr->x, dr->y, (jint)dr->rgb);
            static int32_t buf[BUF_W * BUF_H];
            for (int y = 0; y < BUF_H; y++)
                for (int x = 0; x < BUF_W; x++)
                    buf[y * BUF_W + x] = background(x);
            for (size_t i = 0; i < g.n; i += 3)
                draw_point(buf, g.calls[i], g.calls[i + 1], g.calls[i + 2]);
            printf("%s\n            {\"text\":", d ? "," : "");
            print_u16(t->u16, t->len);
            printf(",\"x\":%d,\"y\":%d,\"rgb\":%d,\"calls\":%zu,\"callsHash\":\"%08x\",\"bufferHash\":\"%08x\"", dr->x, dr->y,
                   (jint)dr->rgb, g.n / 3, fnv(g.calls, g.n), fnv(buf, BUF_W * BUF_H));
            if (dr->points) {
                /* the calls themselves, as little-endian int32 x, y, argb triples */
                unsigned char *bytes = malloc(g.n * 4 + 1);
                for (size_t i = 0; i < g.n; i++)
                    for (int b = 0; b < 4; b++)
                        bytes[i * 4 + b] = ((uint32_t)g.calls[i] >> (8 * b)) & 0xff;
                printf(",\"callList\":\"");
                base64(bytes, g.n * 4);
                putchar('"');
                free(bytes);
            }
            putchar('}');
            free(g.calls);
        }
        printf("\n          ]\n        }");
        destroyFontN(env, (jobject)&m, face);
    }
    printf("\n      ]\n    }");
}

int main(int argc, char **argv)
{
    if (argc != 5) {
        fprintf(stderr, "usage: %s <fallback font> <disc font> <missing path> <non-font file>\n", argv[0]);
        return 2;
    }
    functions.GetObjectClass = get_object_class;
    functions.GetMethodID = get_method_id;
    functions.CallVoidMethod = call_void_method;
    functions.GetFieldID = get_field_id;
    functions.SetIntField = set_int_field;
    functions.GetStringLength = get_string_length;
    functions.GetStringCritical = get_string_critical;
    functions.ReleaseStringCritical = release_string_critical;
    functions.GetStringUTFChars = get_string_utf_chars;
    functions.ReleaseStringUTFChars = release_string_utf_chars;
    functions.NewStringUTF = new_string_utf;
    functions.SetObjectArrayElement = set_object_array_element;
    functions.GetCharArrayRegion = get_char_array_region;
    functions.ExceptionCheck = exception_check;

    const JNINativeMethod *fm = Java_java_awt_BDFontMetrics_methods;
    int fmc = Java_java_awt_BDFontMetrics_methods_count;
    initN = native(fm, fmc, "initN");
    getFontFamilyAndStyleN = native(fm, fmc, "getFontFamilyAndStyleN");
    loadFontN = native(fm, fmc, "loadFontN");
    destroyFontN = native(fm, fmc, "destroyFontN");
    charWidthN = native(fm, fmc, "charWidthN");
    stringWidthN = native(fm, fmc, "stringWidthN");
    charsWidthN = native(fm, fmc, "charsWidthN");
    drawStringN = native(Java_java_awt_BDGraphics_methods, Java_java_awt_BDGraphics_methods_count, "drawStringN");

    jlong lib = initN(env, NULL);
    if (!lib) {
        fprintf(stderr, "initN failed\n");
        return 1;
    }

    metrics_t m = { { K_METRICS }, 0, 0, 0, 0 };
    printf("{\n  \"buffer\": {\"width\":%d,\"height\":%d},\n", BUF_W, BUF_H);
    printf("  \"missing\": {\"familyAndStyle\": ");
    print_family(lib, argv[3]);
    printf(", \"loadFont\": %lld},\n", (long long)loadFontN(env, (jobject)&m, lib, path_string(argv[3]), 24));
    printf("  \"notAFont\": {\"familyAndStyle\": ");
    print_family(lib, argv[4]);
    printf(", \"loadFont\": %lld},\n", (long long)loadFontN(env, (jobject)&m, lib, path_string(argv[4]), 24));
    printf("  \"fonts\": [");
    font(lib, "fallback", argv[1], 1);
    font(lib, "disc", argv[2], 0);
    printf("\n  ]\n}\n");
    if (bad_call) {
        fprintf(stderr, "a native made a JNI call the fake JNIEnv does not expect\n");
        return 1;
    }
    return 0;
}
