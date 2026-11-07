/*
 * vm_trace: runs a disc through patched libbluray (see trace.patch) and prints a JSON-lines trace of
 * register writes and player events. Usage: vm_trace <disc-dir> <script-file>
 *
 * Trace and script formats: tests/vm-trace/format.ts and tests/vm-trace/script.ts.
 * Waits are state-based ("the current title is N"), and steps run only once the VM has settled, so the
 * trace does not depend on how libbluray splits its work over bd_read_ext() calls.
 */
#include <inttypes.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#include "libbluray/bluray.h"
#include "libbluray/keys.h"
#include "libbluray/decoders/overlay.h"

extern void (*bd_trace_write_cb)(int psr, int reg, uint32_t val);
extern void (*bd_trace_event_cb)(uint32_t event, uint32_t param);
extern void (*bd_trace_seek_cb)(int what, uint32_t value);
extern void bd_trace_tick(void);
extern int bd_trace_finished(BLURAY *bd);

#define READ_SIZE   6144
#define MAX_READS   10000000
#define TAIL_READS  200
#define MAX_SETTLE  100000
#define PSR_TIME    8
#define PSR_PAGE    11
#define PLANE_W     1920
#define PLANE_H     1080

/* ---- state seen through the trace callbacks ---- */

static int tracing;
static long last_title = -1, last_playlist = -1, last_page = -1;
static int menu_open, popup_open, errored, ended;
static long reads_done, reads_base;

static void emit_value(const char *kind, uint32_t v)
{
    printf("{\"k\":\"%s\",\"v\":%" PRIu32 "}\n", kind, v);
}

static void write_cb(int psr, int reg, uint32_t val)
{
    if (psr && reg == PSR_PAGE) {
        last_page = val;
    }
    if (!tracing || (psr && reg == PSR_TIME)) {
        return;
    }
    printf("{\"k\":\"%s\",\"i\":%d,\"v\":%" PRIu32 "}\n", psr ? "psr" : "gpr", reg, val);
}

static void seek_cb(int what, uint32_t value)
{
    static const char *const NAMES[] = { "item", "mark", "time" };
    if (tracing) {
        printf("{\"k\":\"seek\",\"what\":\"%s\",\"v\":%" PRIu32 "}\n", NAMES[what], value);
    }
}

static void event_cb(uint32_t event, uint32_t param)
{
    if (!tracing) {
        return;
    }
    switch (event) {
        case BD_EVENT_TITLE:
            last_title = param;
            emit_value("title", param);
            break;
        case BD_EVENT_PLAYLIST:
            last_playlist = param;
            emit_value("playlist", param);
            break;
        case BD_EVENT_PLAYITEM:
            emit_value("playitem", param);
            break;
        case BD_EVENT_CHAPTER:
            emit_value("chapter", param);
            break;
        case BD_EVENT_MENU:
            menu_open = !!param;
            emit_value("menu", !!param);
            break;
        case BD_EVENT_POPUP:
            popup_open = !!param;
            emit_value("popup", !!param);
            break;
        case BD_EVENT_UO_MASK_CHANGED:
            printf("{\"k\":\"uo\",\"v\":\"%" PRIx32 "\"}\n", param);
            break;
        case BD_EVENT_SOUND_EFFECT:
            emit_value("sound", param);
            break;
        case BD_EVENT_STILL:
            emit_value("still", !!param);
            break;
        case BD_EVENT_ERROR:
            errored = 1;
            break;
        default:
            break;
    }
}

/*
 * ---- overlays: Y,Cr,Cb,T planes with the semantics and hash of packages/pg/src/overlay-plane.ts ----
 * IG is immediate. PG is buffered: draw and wipe change pg_back, BD_OVERLAY_FLUSH copies it to pg_plane (the
 * visible plane), and INIT, CLOSE and CLEAR reset both.
 */

#define PLANE_BYTES (PLANE_W * PLANE_H * 4)

static uint8_t ig_plane[PLANE_BYTES];
static uint8_t pg_plane[PLANE_BYTES];
static uint8_t pg_back[PLANE_BYTES];

static void plane_put(uint8_t *plane, unsigned x, unsigned y, const BD_PG_PALETTE_ENTRY *pe)
{
    uint8_t *p = &plane[(y * PLANE_W + x) * 4];
    p[0] = pe ? pe->Y : 0;
    p[1] = pe ? pe->Cr : 0;
    p[2] = pe ? pe->Cb : 0;
    p[3] = pe ? pe->T : 0;
}

/* OverlayPlane.draw: RLE rows from (x, y); a zero-length element ends the row once it is full, else is skipped */
static void plane_draw(uint8_t *plane, const struct bd_overlay_s *ov)
{
    long row = ov->y, col = 0;
    unsigned i;

    if (!ov->img || !ov->palette) {
        return;
    }
    for (i = 0;; i++) {
        const BD_PG_RLE_ELEM *e = &ov->img[i];
        long c, end;
        if (row >= (long)ov->y + ov->h) {
            break;
        }
        if (e->len == 0) {
            if (col >= ov->w) {
                row++;
                col = 0;
                continue;
            }
            /* libbluray terminates img with an end-of-line after the last row; an early zero is skipped */
            continue;
        }
        end = col + e->len < ov->w ? col + e->len : ov->w;
        if (row >= 0 && row < PLANE_H) {
            for (c = col; c < end; c++) {
                long x = ov->x + c;
                if (x >= 0 && x < PLANE_W) {
                    plane_put(plane, (unsigned)x, (unsigned)row, &ov->palette[e->color]);
                }
            }
        }
        col += e->len;
    }
}

static void overlay_proc(void *handle, const struct bd_overlay_s * const ov)
{
    unsigned x, y;
    int pg;
    uint8_t *target;
    (void)handle;

    if (!ov || (ov->plane != BD_OVERLAY_IG && ov->plane != BD_OVERLAY_PG)) {
        return;
    }
    pg = ov->plane == BD_OVERLAY_PG;
    target = pg ? pg_back : ig_plane;
    switch (ov->cmd) {
        case BD_OVERLAY_INIT:
        case BD_OVERLAY_CLOSE:
        case BD_OVERLAY_CLEAR:
            memset(target, 0, PLANE_BYTES);
            if (pg) {
                memset(pg_plane, 0, PLANE_BYTES);
            }
            break;
        case BD_OVERLAY_WIPE:
            for (y = ov->y; y < (unsigned)ov->y + ov->h && y < PLANE_H; y++) {
                for (x = ov->x; x < (unsigned)ov->x + ov->w && x < PLANE_W; x++) {
                    plane_put(target, x, y, NULL);
                }
            }
            break;
        case BD_OVERLAY_DRAW:
            plane_draw(target, ov);
            break;
        case BD_OVERLAY_FLUSH:
            if (pg) {
                memcpy(pg_plane, pg_back, PLANE_BYTES);
            }
            break;
        default:
            break;
    }
}

/* FNV-1a 64 over every byte of a plane, as OverlayPlane.hash() */
static const char *plane_hash(const uint8_t *plane)
{
    static char out[17];
    uint64_t h = 0xcbf29ce484222325ull;
    size_t i;
    for (i = 0; i < PLANE_BYTES; i++) {
        h ^= plane[i];
        h *= 0x100000001b3ull;
    }
    snprintf(out, sizeof(out), "%016" PRIx64, h);
    return out;
}

/* ---- script ---- */

typedef enum { S_WAIT_TITLE, S_WAIT_PLAYLIST, S_WAIT_READS, S_WAIT_PAGE, S_WAIT_MENU, S_WAIT_POPUP, S_WAIT_END, S_KEY, S_MOUSE, S_CLICK, S_PLAY_TITLE, S_SUBS_OFF, S_SUBS_ON } step_kind;
typedef struct { step_kind kind; int a, b; } step_t;

static const struct { const char *name; uint32_t vk; } KEYS[] = {
    { "up", BD_VK_UP }, { "down", BD_VK_DOWN }, { "left", BD_VK_LEFT }, { "right", BD_VK_RIGHT },
    { "ok", BD_VK_ENTER }, { "topmenu", BD_VK_ROOT_MENU }, { "popup", BD_VK_POPUP },
};

static int parse_script(const char *path, step_t **out)
{
    FILE *f = fopen(path, "r");
    char line[256];
    int n = 0, cap = 0;
    step_t *steps = NULL;

    if (!f) {
        return -1;
    }
    while (fgets(line, sizeof(line), f)) {
        char w1[32] = "", w2[32] = "";
        int a = 0, b = 0, cnt;
        step_t s = { S_WAIT_END, 0, 0 };
        char *hash = strchr(line, '#');
        if (hash) {
            *hash = 0;
        }
        cnt = sscanf(line, "%31s %31s %d %d", w1, w2, &a, &b);
        if (cnt < 1) {
            continue;
        }
        if (!strcmp(w1, "wait") && cnt >= 2) {
            if (!strcmp(w2, "title")) { s.kind = S_WAIT_TITLE; s.a = a; }
            else if (!strcmp(w2, "playlist")) { s.kind = S_WAIT_PLAYLIST; s.a = a; }
            else if (!strcmp(w2, "reads")) { s.kind = S_WAIT_READS; s.a = a; }
            else if (!strcmp(w2, "page")) { s.kind = S_WAIT_PAGE; s.a = a; }
            else if (!strcmp(w2, "menu")) s.kind = S_WAIT_MENU;
            else if (!strcmp(w2, "popup")) s.kind = S_WAIT_POPUP;
            else if (!strcmp(w2, "end")) s.kind = S_WAIT_END;
            else goto bad;
        } else if (!strcmp(w1, "key") && cnt >= 2) {
            unsigned i;
            int found = 0;
            s.kind = S_KEY;
            if (w2[0] >= '0' && w2[0] <= '9' && !w2[1]) {
                s.a = BD_VK_0 + (w2[0] - '0');
                found = 1;
            }
            for (i = 0; !found && i < sizeof(KEYS) / sizeof(KEYS[0]); i++) {
                if (!strcmp(w2, KEYS[i].name)) {
                    s.a = (int)KEYS[i].vk;
                    found = 1;
                }
            }
            if (!found) goto bad;
        } else if ((!strcmp(w1, "mouse") || !strcmp(w1, "click")) && cnt == 3) {
            /* sscanf read "X" into w2 */
            s.kind = w1[0] == 'm' ? S_MOUSE : S_CLICK;
            s.a = atoi(w2);
            s.b = a;
        } else if (!strcmp(w1, "subs") && !strcmp(w2, "off") && cnt == 2) {
            s.kind = S_SUBS_OFF;
        } else if (!strcmp(w1, "subs") && cnt == 2 && w2[0] >= '1' && w2[0] <= '9') {
            s.kind = S_SUBS_ON;
            s.a = atoi(w2);
        } else if (!strcmp(w1, "play") && !strcmp(w2, "title") && cnt >= 3) {
            s.kind = S_PLAY_TITLE;
            s.a = a;
        } else {
            goto bad;
        }
        if (n == cap) {
            cap = cap ? cap * 2 : 16;
            steps = realloc(steps, cap * sizeof(*steps));
        }
        steps[n++] = s;
        continue;
bad:
        fprintf(stderr, "bad script line: %s", line);
        fclose(f);
        free(steps);
        return -1;
    }
    fclose(f);
    *out = steps;
    return n;
}

static int wait_met(const step_t *s)
{
    switch (s->kind) {
        case S_WAIT_TITLE: return last_title == s->a;
        case S_WAIT_PLAYLIST: return last_playlist == s->a;
        case S_WAIT_READS: return reads_done - reads_base >= s->a;
        case S_WAIT_PAGE: return last_page == s->a;
        case S_WAIT_MENU: return menu_open;
        case S_WAIT_POPUP: return popup_open;
        case S_WAIT_END: return ended;
        default: return 1;
    }
}

/* Runs the VM until it is suspended and the event queue is empty, without reading stream data. */
static void settle(BLURAY *bd)
{
    BD_EVENT ev;
    int i;
    for (i = 0; i < MAX_SETTLE; i++) {
        bd_read_ext(bd, NULL, 0, &ev);
        if (ev.event == BD_EVENT_NONE) {
            break;
        }
    }
    ended = bd_trace_finished(bd);
}

static void run_step(BLURAY *bd, const step_t *s)
{
    switch (s->kind) {
        case S_KEY: bd_user_input(bd, -1, (uint32_t)s->a); break;
        case S_MOUSE: bd_mouse_select(bd, -1, (uint16_t)s->a, (uint16_t)s->b); break;
        case S_CLICK:
            bd_mouse_select(bd, -1, (uint16_t)s->a, (uint16_t)s->b);
            bd_user_input(bd, -1, BD_VK_MOUSE_ACTIVATE);
            break;
        case S_PLAY_TITLE: bd_play_title(bd, (unsigned)s->a); break;
        /* the PG display flag off, stream 1 kept (the replay's PgStreamControl.select('off')) */
        case S_SUBS_OFF: bd_select_stream(bd, BLURAY_PG_TEXTST_STREAM, 1, 0); break;
        /* PG stream N with the display flag (the replay's PgStreamControl.select({ pg: N })) */
        case S_SUBS_ON: bd_select_stream(bd, BLURAY_PG_TEXTST_STREAM, (uint32_t)s->a, 1); break;
        default: break;
    }
}

static void finish(const char *why)
{
    printf("{\"k\":\"end\",\"why\":\"%s\"}\n", why);
    fflush(stdout);
}

int main(int argc, char **argv)
{
    static uint8_t buf[READ_SIZE];
    step_t *steps = NULL;
    int nsteps, idx = 0, tail = 0;
    long reads;
    BD_EVENT ev;
    BLURAY *bd;

    if (argc != 3) {
        fprintf(stderr, "usage: %s <disc-dir> <script-file>\n", argv[0]);
        return 2;
    }
    nsteps = parse_script(argv[2], &steps);
    if (nsteps < 0) {
        fprintf(stderr, "cannot read script %s\n", argv[2]);
        return 2;
    }
    bd = bd_open(argv[1], NULL);
    if (!bd) {
        fprintf(stderr, "bd_open(%s) failed\n", argv[1]);
        return 2;
    }

    /* PG is decoded only with this setting; it also sets PSR2's display flag (bd_set_player_setting) */
    bd_set_player_setting(bd, BLURAY_PLAYER_SETTING_DECODE_PG, 1);

    /* creates the event queue and queues libbluray's initial PSR events, which are not part of the trace */
    bd_get_event(bd, NULL);
    while (bd_get_event(bd, &ev) && ev.event != BD_EVENT_NONE) {
    }
    bd_register_overlay_proc(bd, NULL, overlay_proc);

    bd_trace_write_cb = write_cb;
    bd_trace_event_cb = event_cb;
    bd_trace_seek_cb = seek_cb;
    tracing = 1;

    if (!bd_play(bd)) {
        fprintf(stderr, "bd_play failed\n");
    }

    for (reads = 0; reads < MAX_READS; reads++) {
        settle(bd);
        while (idx < nsteps && !errored && wait_met(&steps[idx])) {
            run_step(bd, &steps[idx]);
            settle(bd);
            printf("{\"k\":\"step\",\"n\":%d,\"plane\":\"%s\",", idx, plane_hash(ig_plane));
            printf("\"pg\":\"%s\"}\n", plane_hash(pg_plane));
            reads_base = reads_done;
            idx++;
        }
        if (errored) {
            finish("error");
            return 0;
        }
        if (idx == nsteps && (ended || tail++ >= TAIL_READS)) {
            finish("eof");
            return 0;
        }

        bd_trace_tick();
        bd_read_ext(bd, buf, READ_SIZE, &ev);
        reads_done++;
    }
    finish("limit");
    free(steps);
    return 0;
}
