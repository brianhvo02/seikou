/* BD-J trace harness: plays a disc headless through patched libbluray with BD-J enabled. The patch prints one JSONL
 * line per JNI native call to stdout. With --keys or --planes this program adds its own lines there: one per ARGB
 * overlay flush (and, with --keys, one per script step and one at the end). Diagnostics go to stderr.
 * usage: bdj_trace <disc> [--seconds N] [--planes] [--keys FILE] [--tail S] [--wait-timeout S] [--dump-planes DIR]
 * Exit status 3 when a script wait times out or the run ends with script steps left.
 * Reads the stream no faster than real time, so BD-J timers and playback progress behave roughly as on a player. */
#include <libbluray/bluray.h>
#include <libbluray/keys.h>
#include <libbluray/overlay.h>
#include <png.h>
#include <pthread.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <time.h>
#include <unistd.h>

#define PLANE_W 1920
#define PLANE_H 1080

static struct timespec t0;
static double now_s(void)
{
  struct timespec t;
  clock_gettime(CLOCK_MONOTONIC, &t);
  return (double)(t.tv_sec - t0.tv_sec) + (double)(t.tv_nsec - t0.tv_nsec) / 1e9;
}

/* ---- the ARGB plane ---- */

static int planes_on;           /* print flush lines */
static const char *dump_dir;    /* write <dir>/<k>.png at each flush */
static uint32_t plane[PLANE_W * PLANE_H];
static pthread_mutex_t plane_mutex = PTHREAD_MUTEX_INITIALIZER;
static int flushes;             /* guarded by plane_mutex; read by the main thread for `wait flush` */
static double last_flush_s;     /* guarded by plane_mutex: when the last flush happened, for `wait still` */
static int plane_visible;       /* guarded by plane_mutex: the last flushed plane has a pixel with non-zero alpha */
static double visible_since = -1; /* guarded by plane_mutex: since when the flushed plane has been visible (-1: not) */

/* whether the plane has a pixel with non-zero alpha (called with plane_mutex held) */
static int plane_has_alpha(void)
{
  for (size_t i = 0; i < (size_t)PLANE_W * PLANE_H; i++) {
    if (plane[i] >> 24) {
      return 1;
    }
  }
  return 0;
}

/* FNV-1a 32 over the plane's 1920x1080 ARGB words in row-major order, each word as its 4 little-endian bytes
 * (B, G, R, A). Seikou computes the same hash over its BD-J plane. */
static uint32_t plane_hash(void)
{
  uint32_t h = 0x811c9dc5u;
  for (size_t i = 0; i < (size_t)PLANE_W * PLANE_H; i++) {
    uint32_t v = plane[i];
    for (int b = 0; b < 4; b++) {
      h ^= (v >> (8 * b)) & 0xff;
      h *= 0x01000193u;
    }
  }
  return h;
}

/* Non-premultiplied RGBA PNG of the whole plane. */
static void dump_png(int k)
{
  char path[4096];
  snprintf(path, sizeof path, "%s/%d.png", dump_dir, k);
  FILE *f = fopen(path, "wb");
  if (!f) {
    fprintf(stderr, "cannot write %s\n", path);
    return;
  }
  png_structp png = png_create_write_struct(PNG_LIBPNG_VER_STRING, NULL, NULL, NULL);
  png_infop info = png_create_info_struct(png);
  if (setjmp(png_jmpbuf(png))) {
    fprintf(stderr, "png error writing %s\n", path);
    png_destroy_write_struct(&png, &info);
    fclose(f);
    return;
  }
  png_init_io(png, f);
  png_set_compression_level(png, 1);
  png_set_IHDR(png, info, PLANE_W, PLANE_H, 8, PNG_COLOR_TYPE_RGBA, PNG_INTERLACE_NONE, PNG_COMPRESSION_TYPE_DEFAULT,
               PNG_FILTER_TYPE_DEFAULT);
  png_write_info(png, info);
  static uint8_t row[PLANE_W * 4];
  for (int y = 0; y < PLANE_H; y++) {
    const uint32_t *src = plane + (size_t)y * PLANE_W;
    for (int x = 0; x < PLANE_W; x++) {
      row[4 * x] = (uint8_t)(src[x] >> 16);
      row[4 * x + 1] = (uint8_t)(src[x] >> 8);
      row[4 * x + 2] = (uint8_t)src[x];
      row[4 * x + 3] = (uint8_t)(src[x] >> 24);
    }
    png_write_row(png, row);
  }
  png_write_end(png, NULL);
  png_destroy_write_struct(&png, &info);
  fclose(f);
}

/* libbluray calls this from the Java thread that draws (bdpriv_bdj_osd_cb): INIT and CLOSE clear the plane, DRAW copies
 * the dirty rectangle into it, FLUSH publishes it. The plane is always 1920x1080; a smaller INIT size keeps its
 * pixels at the top left. */
static void argb(void *h, const BD_ARGB_OVERLAY *ov)
{
  (void)h;
  pthread_mutex_lock(&plane_mutex);
  switch (ov->cmd) {
    case BD_ARGB_OVERLAY_INIT:
    case BD_ARGB_OVERLAY_CLOSE:
      memset(plane, 0, sizeof plane);
      plane_visible = 0; /* a cleared plane is transparent at once */
      visible_since = -1;
      break;
    case BD_ARGB_OVERLAY_DRAW:
      for (int y = 0; y < ov->h && ov->y + y < PLANE_H; y++) {
        int w = ov->x + ov->w > PLANE_W ? PLANE_W - ov->x : ov->w;
        if (w > 0) {
          memcpy(plane + (size_t)(ov->y + y) * PLANE_W + ov->x, ov->argb + (size_t)y * ov->stride, (size_t)w * 4);
        }
      }
      break;
    case BD_ARGB_OVERLAY_FLUSH: {
      int k = ++flushes;
      last_flush_s = now_s();
      plane_visible = plane_has_alpha();
      if (!plane_visible) {
        visible_since = -1;
      } else if (visible_since < 0) {
        visible_since = last_flush_s;
      }
      if (planes_on) {
        printf("{\"plane\":\"flush\",\"n\":%d,\"hash\":\"%08x\",\"t\":%ld}\n", k, plane_hash(), (long)(now_s() * 1000));
        fflush(stdout);
      }
      if (dump_dir) {
        dump_png(k);
      }
      break;
    }
    default:
      break;
  }
  pthread_mutex_unlock(&plane_mutex);
}

static int flush_count(void)
{
  pthread_mutex_lock(&plane_mutex);
  int k = flushes;
  pthread_mutex_unlock(&plane_mutex);
  return k;
}

/* ---- key scripts (the .keys syntax of tests/vm-trace/scripts, extended) ---- */

typedef enum { S_WAIT_FLUSH, S_WAIT_STILL, S_WAIT_MENU, S_WAIT_QUIET, S_WAIT_PLAYLIST, S_WAIT_TITLE, S_KEY, S_MOUSE, S_CLICK } step_kind;
typedef struct {
  step_kind kind;
  int a, b;
  char text[112];
} step_t;

static const struct {
  const char *name;
  uint32_t vk;
} KEYS[] = {
  /* vm-trace names */
  { "up", BD_VK_UP }, { "down", BD_VK_DOWN }, { "left", BD_VK_LEFT }, { "right", BD_VK_RIGHT }, { "ok", BD_VK_ENTER },
  { "topmenu", BD_VK_ROOT_MENU }, { "popup", BD_VK_POPUP }, { "red", BD_VK_RED }, { "green", BD_VK_GREEN },
  { "yellow", BD_VL_YELLOW }, { "blue", BD_VK_BLUE },
  /* keys.h names */
  { "BD_VK_UP", BD_VK_UP }, { "BD_VK_DOWN", BD_VK_DOWN }, { "BD_VK_LEFT", BD_VK_LEFT }, { "BD_VK_RIGHT", BD_VK_RIGHT },
  { "BD_VK_ENTER", BD_VK_ENTER }, { "BD_VK_ROOT_MENU", BD_VK_ROOT_MENU }, { "BD_VK_POPUP", BD_VK_POPUP },
  { "BD_VK_MOUSE_ACTIVATE", BD_VK_MOUSE_ACTIVATE }, { "BD_VK_RED", BD_VK_RED }, { "BD_VK_GREEN", BD_VK_GREEN },
  { "BD_VK_YELLOW", BD_VL_YELLOW }, { "BD_VL_YELLOW", BD_VL_YELLOW }, { "BD_VK_BLUE", BD_VK_BLUE },
};

static int parse_int(const char *s, int *out)
{
  char *end;
  long v = strtol(s, &end, 10);
  if (!*s || *end || v < 0 || v > 0xffff) {
    return 0;
  }
  *out = (int)v;
  return 1;
}

static int parse_key(const char *w, uint32_t *vk)
{
  if (w[0] >= '0' && w[0] <= '9' && !w[1]) {
    *vk = BD_VK_0 + (uint32_t)(w[0] - '0');
    return 1;
  }
  if (!strncmp(w, "BD_VK_", 6) && w[6] >= '0' && w[6] <= '9' && !w[7]) {
    *vk = BD_VK_0 + (uint32_t)(w[6] - '0');
    return 1;
  }
  for (unsigned i = 0; i < sizeof KEYS / sizeof KEYS[0]; i++) {
    if (!strcmp(w, KEYS[i].name)) {
      *vk = KEYS[i].vk;
      return 1;
    }
  }
  return 0;
}

static int parse_script(const char *path, step_t **out)
{
  FILE *f = fopen(path, "r");
  char line[256];
  int n = 0, cap = 0, lineno = 0;
  step_t *steps = NULL;
  if (!f) {
    fprintf(stderr, "cannot read script %s\n", path);
    return -1;
  }
  while (fgets(line, sizeof line, f)) {
    char w[4][32] = { "", "", "", "" };
    step_t s;
    lineno++;
    char *hash = strchr(line, '#');
    if (hash) {
      *hash = 0;
    }
    int cnt = sscanf(line, "%31s %31s %31s %31s", w[0], w[1], w[2], w[3]);
    if (cnt < 1) {
      continue;
    }
    memset(&s, 0, sizeof s);
    if (!strcmp(w[0], "wait") && cnt == 3) {
      if (!strcmp(w[1], "flush")) s.kind = S_WAIT_FLUSH;
      else if (!strcmp(w[1], "still")) s.kind = S_WAIT_STILL;
      else if (!strcmp(w[1], "menu")) s.kind = S_WAIT_MENU;
      else if (!strcmp(w[1], "quiet")) s.kind = S_WAIT_QUIET;
      else if (!strcmp(w[1], "playlist")) s.kind = S_WAIT_PLAYLIST;
      else if (!strcmp(w[1], "title")) s.kind = S_WAIT_TITLE;
      else goto bad;
      /* `wait playlist any` / `wait title any`: any such event (s.a = -1) */
      if ((s.kind == S_WAIT_PLAYLIST || s.kind == S_WAIT_TITLE) && !strcmp(w[2], "any")) s.a = -1;
      else if (!parse_int(w[2], &s.a)) goto bad;
    } else if (!strcmp(w[0], "key") && cnt == 2) {
      uint32_t vk;
      if (!parse_key(w[1], &vk)) goto bad;
      s.kind = S_KEY;
      s.a = (int)vk;
    } else if ((!strcmp(w[0], "mouse") || !strcmp(w[0], "click")) && cnt == 3) {
      s.kind = w[0][0] == 'm' ? S_MOUSE : S_CLICK;
      if (!parse_int(w[1], &s.a) || !parse_int(w[2], &s.b)) goto bad;
    } else {
      goto bad;
    }
    snprintf(s.text, sizeof s.text, "%s%s%s%s%s", w[0], cnt > 1 ? " " : "", w[1], cnt > 2 ? " " : "", w[2]);
    if (n == cap) {
      cap = cap ? cap * 2 : 16;
      step_t *grown = realloc(steps, (size_t)cap * sizeof *steps);
      if (!grown) {
        fprintf(stderr, "out of memory reading %s\n", path);
        fclose(f);
        free(steps);
        return -1;
      }
      steps = grown;
    }
    steps[n++] = s;
    continue;
  bad:
    fprintf(stderr, "%s:%d: cannot parse script line: %s", path, lineno, line);
    fclose(f);
    free(steps);
    return -1;
  }
  fclose(f);
  *out = steps;
  return n;
}

/* BD_EVENT_PLAYLIST and BD_EVENT_TITLE params seen since the previous step ran (the window `wait playlist` and
 * `wait title` look at, so a later event cannot hide an earlier match) */
#define MAX_SEEN 256
static struct {
  int playlist;
  unsigned param;
} seen[MAX_SEEN];
static int nseen;

static void note_event(int playlist, unsigned param)
{
  if (nseen < MAX_SEEN) {
    seen[nseen].playlist = playlist;
    seen[nseen].param = param;
    nseen++;
  }
}

static int seen_since_step(int playlist, int param)
{
  for (int i = 0; i < nseen; i++) {
    if (seen[i].playlist == playlist && (param < 0 || seen[i].param == (unsigned)param)) {
      return 1;
    }
  }
  return 0;
}
static int step_flushes; /* the flush count just before the previous step ran */

/* `wait still MS`: the plane has flushed since the previous step and then not again for MS milliseconds */
static int plane_still(int ms)
{
  pthread_mutex_lock(&plane_mutex);
  int met = flushes > step_flushes && (now_s() - last_flush_s) * 1000 >= ms;
  pthread_mutex_unlock(&plane_mutex);
  return met;
}

/* `wait menu MS`: the flushed plane is visible (a pixel with non-zero alpha) and has not flushed for MS milliseconds;
 * or it has stayed visible for MENU_ANIMATED_S while flushing on (an animated menu: step_animated is set) */
#define MENU_ANIMATED_S 30.0
static int step_animated;
static int plane_menu(int ms)
{
  pthread_mutex_lock(&plane_mutex);
  int still = plane_visible && (now_s() - last_flush_s) * 1000 >= ms;
  int animated = !still && plane_visible && visible_since >= 0 && now_s() - visible_since >= MENU_ANIMATED_S;
  pthread_mutex_unlock(&plane_mutex);
  step_animated = animated;
  return still || animated;
}

/* `wait quiet MS`: no flush for MS milliseconds since the step became current (a flush is not required: a key that
 * changes nothing settles too) */
static double step_start;
static int plane_quiet(int ms)
{
  pthread_mutex_lock(&plane_mutex);
  double from = last_flush_s > step_start ? last_flush_s : step_start;
  int met = (now_s() - from) * 1000 >= ms;
  pthread_mutex_unlock(&plane_mutex);
  return met;
}

static int wait_met(const step_t *s)
{
  switch (s->kind) {
    case S_WAIT_FLUSH: return flush_count() >= s->a;
    case S_WAIT_STILL: return plane_still(s->a);
    case S_WAIT_MENU: return plane_menu(s->a);
    case S_WAIT_QUIET: return plane_quiet(s->a);
    case S_WAIT_PLAYLIST: return seen_since_step(1, s->a);
    case S_WAIT_TITLE: return seen_since_step(0, s->a);
    default: return 1;
  }
}

static void run_step(BLURAY *bd, const step_t *s)
{
  switch (s->kind) {
    /* no flags: libbluray sends pressed, typed and released (bd_user_input) */
    case S_KEY: bd_user_input(bd, -1, (uint32_t)s->a); break;
    case S_MOUSE: bd_mouse_select(bd, -1, (uint16_t)s->a, (uint16_t)s->b); break;
    case S_CLICK:
      bd_mouse_select(bd, -1, (uint16_t)s->a, (uint16_t)s->b);
      bd_user_input(bd, -1, BD_VK_MOUSE_ACTIVATE);
      break;
    default: break;
  }
}

static void step_line(int n, const char *text, int animated)
{
  /* step text is made of script words ([A-Za-z0-9_]), nothing to escape */
  printf("{\"script\":\"step\",\"n\":%d,\"step\":\"%s\",\"flushes\":%d,%s\"t\":%ld}\n", n, text, flush_count(),
         animated ? "\"animated\":true," : "", (long)(now_s() * 1000));
  fflush(stdout);
}

int main(int argc, char **argv)
{
  const char *disc = NULL, *keys = NULL;
  double limit = 60, tail = 5, wait_timeout = 30;
  int bad = 0;
  for (int i = 1; i < argc; i++) {
    if (!strcmp(argv[i], "--seconds") && i + 1 < argc) {
      limit = atof(argv[++i]);
    } else if (!strcmp(argv[i], "--wait-timeout") && i + 1 < argc) {
      wait_timeout = atof(argv[++i]);
    } else if (!strcmp(argv[i], "--tail") && i + 1 < argc) {
      tail = atof(argv[++i]);
    } else if (!strcmp(argv[i], "--keys") && i + 1 < argc) {
      keys = argv[++i];
    } else if (!strcmp(argv[i], "--dump-planes") && i + 1 < argc) {
      dump_dir = argv[++i];
    } else if (!strcmp(argv[i], "--planes")) {
      planes_on = 1;
    } else if (!disc && argv[i][0] != '-') {
      disc = argv[i];
    } else {
      bad = 1;
    }
  }
  if (!disc || bad) {
    fprintf(stderr, "usage: %s <disc> [--seconds N] [--planes] [--keys FILE] [--tail S] [--wait-timeout S] "
            "[--dump-planes DIR]\n", argv[0]);
    return 2;
  }
  step_t *steps = NULL;
  int nsteps = 0, idx = 0;
  if (keys) {
    nsteps = parse_script(keys, &steps);
    if (nsteps < 0) {
      return 2;
    }
    planes_on = 1;
  }
  clock_gettime(CLOCK_MONOTONIC, &t0);

  BLURAY *bd = bd_open(disc, NULL);
  if (!bd) {
    fprintf(stderr, "bd_open failed\n");
    return 1;
  }
  bd_register_argb_overlay_proc(bd, NULL, argb, NULL);
  bd_set_player_setting_str(bd, BLURAY_PLAYER_SETTING_COUNTRY_CODE, "us");
  bd_set_player_setting_str(bd, BLURAY_PLAYER_SETTING_AUDIO_LANG, "eng");
  bd_set_player_setting_str(bd, BLURAY_PLAYER_SETTING_PG_LANG, "eng");
  bd_set_player_setting_str(bd, BLURAY_PLAYER_SETTING_MENU_LANG, "eng");
  if (!bd_play(bd)) {
    fprintf(stderr, "bd_play failed\n");
    return 1;
  }

  static unsigned char buf[6144 * 32];
  double playlist_wall = 0, script_done = -1, resume_at = 0; /* step_start (above): when the current step became current */
  step_start = 0;
  const char *why = "limit";
  while (now_s() < limit) {
    /* the script: each step runs once its wait holds; key and mouse steps run at once */
    while (idx < nsteps && wait_met(&steps[idx])) {
      step_flushes = flush_count(); /* before the step: a key's reaction may flush at once */
      run_step(bd, &steps[idx]);
      step_line(idx, steps[idx].text, steps[idx].kind == S_WAIT_MENU && step_animated);
      idx++;
      nseen = 0;
      step_start = now_s();
    }
    if (idx < nsteps && now_s() - step_start >= wait_timeout) {
      why = "timeout";
      break;
    }
    if (keys && idx == nsteps) {
      if (script_done < 0) {
        script_done = now_s();
      } else if (now_s() - script_done >= tail) {
        why = "done";
        break;
      }
    }

    if (now_s() < resume_at) {
      double s = resume_at - now_s();
      usleep((useconds_t)((s > 0.1 ? 0.1 : s) * 1e6));
      continue;
    }

    BD_EVENT ev;
    int n = bd_read_ext(bd, buf, sizeof buf, &ev);
    for (;;) {
      if (ev.event == BD_EVENT_PLAYLIST) {
        playlist_wall = now_s();
        note_event(1, ev.param);
      } else if (ev.event == BD_EVENT_SEEK) {
        /* a seek (a chapter, or a playlist started at a mark): pace from its media time (45 kHz) on */
        playlist_wall = now_s() - (double)ev.param / 45000.0;
        resume_at = 0;
      } else if (ev.event == BD_EVENT_TITLE) {
        note_event(0, ev.param);
      }
      if (!bd_get_event(bd, &ev)) {
        break;
      }
    }
    if (n < 0) {
      fprintf(stderr, "read error\n");
      why = "error";
      break;
    }
    if (n == 0) {
      usleep(40000);
      continue;
    }
    /* pace: stream time since the playlist started (or the last seek) must not run ahead of wall time; the wait is
       taken in steps of at most 100 ms at the top of the loop, so the script and --seconds are checked during it */
    double ahead = (double)bd_tell_time(bd) / 90000.0 - (now_s() - playlist_wall);
    if (ahead > 0.5) {
      resume_at = now_s() + ahead - 0.5;
    }
  }
  int status = 0;
  if (keys) {
    if (!strcmp(why, "timeout")) {
      /* step text is made of script words, nothing to escape */
      printf("{\"script\":\"end\",\"why\":\"timeout\",\"n\":%d,\"text\":\"%s\",\"flushes\":%d,\"t\":%ld}\n", idx,
             steps[idx].text, flush_count(), (long)(now_s() * 1000));
      fprintf(stderr, "bdj_trace: script step %d \"%s\" did not hold within %g s\n", idx, steps[idx].text, wait_timeout);
      status = 3;
    } else {
      printf("{\"script\":\"end\",\"n\":%d,\"why\":\"%s\",\"flushes\":%d,\"t\":%ld}\n", idx, why, flush_count(),
             (long)(now_s() * 1000));
      if (idx < nsteps) {
        fprintf(stderr, "bdj_trace: run ended (%s) at script step %d \"%s\" with %d steps left\n", why, idx,
                steps[idx].text, nsteps - idx);
        status = 3;
      }
    }
  }
  fflush(stdout);
  bd_close(bd);
  return status;
}
