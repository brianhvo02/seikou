/*
 * libass trace harness for Seikou: renders an ASS script at given times with the settings our renderer uses,
 * prints one JSON line per event shown (via the trace.patch hook) and writes each frame as a PNG (RGBA on #808080).
 *
 * usage: ass_trace <file.ass> <fonts dir> <times file> <out dir> [<storage w>x<storage h>]
 */
#include <ass/ass.h>
#include <stdint.h>
#include <zlib.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#define WIDTH 1920
#define HEIGHT 1080
#define BACKGROUND 0x80

extern void (*ass_trace_sink)(const char *line);

static void print_line(const char *line)
{
    fputs(line, stdout);
    fputc('\n', stdout);
}

static void quiet(int level, const char *fmt, va_list va, void *data)
{
    (void) data;
    if (level > 1)
        return;
    vfprintf(stderr, fmt, va);
    fputc('\n', stderr);
}

/* ASS_Image list over an opaque frame: alpha = (255 - a) * mask / 255, straight "over". */
static void blend(uint8_t *frame, const ASS_Image *img)
{
    for (; img; img = img->next) {
        unsigned r = img->color >> 24, g = (img->color >> 16) & 0xFF, b = (img->color >> 8) & 0xFF;
        unsigned opacity = 255 - (img->color & 0xFF);
        for (int y = 0; y < img->h; y++) {
            int fy = img->dst_y + y;
            if (fy < 0 || fy >= HEIGHT)
                continue;
            for (int x = 0; x < img->w; x++) {
                int fx = img->dst_x + x;
                if (fx < 0 || fx >= WIDTH)
                    continue;
                unsigned a = opacity * img->bitmap[y * img->stride + x];
                if (!a)
                    continue;
                uint8_t *p = frame + 4 * ((size_t) fy * WIDTH + fx);
                p[0] = (p[0] * (255 * 255 - a) + r * a + 255 * 255 / 2) / (255 * 255);
                p[1] = (p[1] * (255 * 255 - a) + g * a + 255 * 255 / 2) / (255 * 255);
                p[2] = (p[2] * (255 * 255 - a) + b * a + 255 * 255 / 2) / (255 * 255);
            }
        }
    }
}

static void put32(unsigned char *p, uint32_t v)
{
    p[0] = v >> 24; p[1] = v >> 16; p[2] = v >> 8; p[3] = v;
}

static int write_chunk(FILE *f, const char *type, const unsigned char *data, uint32_t len)
{
    unsigned char head[8];
    put32(head, len);
    memcpy(head + 4, type, 4);
    uLong crc = crc32(0, (const Bytef *) type, 4);
    if (len) crc = crc32(crc, data, len);
    unsigned char tail[4];
    put32(tail, (uint32_t) crc);
    return fwrite(head, 1, 8, f) == 8 && (!len || fwrite(data, 1, len, f) == len) && fwrite(tail, 1, 4, f) == 4;
}

/* 8-bit RGBA, filter 0 on every row: what tests/ass-trace/png.ts reads. */
static int write_png(const char *path, const uint8_t *rgba)
{
    size_t row = (size_t) WIDTH * 4 + 1;
    size_t raw_len = row * HEIGHT;
    unsigned char *raw = malloc(raw_len);
    uLongf z_len = compressBound(raw_len);
    unsigned char *z = malloc(z_len);
    if (!raw || !z)
        return 0;
    for (int y = 0; y < HEIGHT; y++) {
        raw[y * row] = 0;
        memcpy(raw + y * row + 1, rgba + (size_t) y * WIDTH * 4, (size_t) WIDTH * 4);
    }
    int ok = compress2(z, &z_len, raw, raw_len, 6) == Z_OK;
    FILE *f = ok ? fopen(path, "wb") : NULL;
    static const unsigned char sig[8] = {0x89, 'P', 'N', 'G', '\r', '\n', 0x1a, '\n'};
    unsigned char ihdr[13];
    put32(ihdr, WIDTH);
    put32(ihdr + 4, HEIGHT);
    ihdr[8] = 8; ihdr[9] = 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
    ok = f && fwrite(sig, 1, 8, f) == 8 && write_chunk(f, "IHDR", ihdr, 13) && write_chunk(f, "IDAT", z, (uint32_t) z_len) && write_chunk(f, "IEND", NULL, 0);
    if (f && fclose(f))
        ok = 0;
    free(raw);
    free(z);
    return ok;
}

int main(int argc, char **argv)
{
    if (argc != 5 && argc != 6) {
        fprintf(stderr, "usage: %s <file.ass> <fonts dir> <times file> <out dir> [WxH storage]\n", argv[0]);
        return 2;
    }
    int storage_w = WIDTH, storage_h = HEIGHT;
    if (argc == 6 && sscanf(argv[5], "%dx%d", &storage_w, &storage_h) != 2) {
        fprintf(stderr, "bad storage size %s\n", argv[5]);
        return 2;
    }

    ASS_Library *lib = ass_library_init();
    if (!lib)
        return 1;
    ass_set_message_cb(lib, quiet, NULL);
    ass_set_fonts_dir(lib, argv[2]);
    ass_set_extract_fonts(lib, 1);

    ASS_Track *track = ass_read_file(lib, argv[1], "UTF-8");
    if (!track) {
        fprintf(stderr, "cannot read %s\n", argv[1]);
        return 1;
    }
    ASS_Renderer *renderer = ass_renderer_init(lib);
    if (!renderer)
        return 1;
    ass_set_frame_size(renderer, WIDTH, HEIGHT);
    ass_set_storage_size(renderer, storage_w, storage_h);
    ass_set_font_scale(renderer, 1);
    ass_set_hinting(renderer, ASS_HINTING_NONE);
    ass_set_shaper(renderer, ASS_SHAPING_COMPLEX);
    ass_set_use_margins(renderer, 0);
    ass_set_line_position(renderer, 0);
    char default_font[4096];
    snprintf(default_font, sizeof(default_font), "%s/DejaVuSans.ttf", argv[2]);
    ass_set_fonts(renderer, default_font, "DejaVu Sans", ASS_FONTPROVIDER_NONE, NULL, 0);

    FILE *times = fopen(argv[3], "r");
    if (!times) {
        fprintf(stderr, "cannot read %s\n", argv[3]);
        return 1;
    }
    uint8_t *frame = malloc((size_t) WIDTH * HEIGHT * 4);
    if (!frame)
        return 1;
    long long t;
    ass_trace_sink = print_line;
    while (fscanf(times, "%lld", &t) == 1) {
        int changed;
        ASS_Image *img = ass_render_frame(renderer, track, t, &changed);
        for (size_t i = 0; i < (size_t) WIDTH * HEIGHT; i++) {
            frame[4 * i] = frame[4 * i + 1] = frame[4 * i + 2] = BACKGROUND;
            frame[4 * i + 3] = 0xFF;
        }
        blend(frame, img);
        char path[4096];
        snprintf(path, sizeof(path), "%s/%lld.png", argv[4], t);
        if (!write_png(path, frame)) {
            fprintf(stderr, "cannot write %s\n", path);
            return 1;
        }
    }
    fflush(stdout);
    fclose(times);
    free(frame);
    ass_free_track(track);
    ass_renderer_done(renderer);
    ass_library_done(lib);
    return 0;
}
