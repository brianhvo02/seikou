/*
 * Seikou video decoder shim over FFmpeg libavcodec (mpeg1video, mpeg2video, vc1, with the mpegvideo and vc1 parsers).
 * Copyright (c) 2026 Seikou contributors
 *
 * Original code, kept LGPL-2.1-or-later because it is compiled into video.wasm with FFmpeg, which is LGPL-2.1-or-later,
 * so the module carries one licence.
 * SPDX-License-Identifier: LGPL-2.1-or-later
 */

#include <math.h>
#include <stdint.h>
#include <stdlib.h>
#include <string.h>
#include <emscripten/emscripten.h>
#include "libavcodec/avcodec.h"
#include "libavutil/log.h"
#include "libavutil/mem.h"
#include "libavutil/pixfmt.h"

enum { CODEC_MPEG1 = 0, CODEC_MPEG2 = 1, CODEC_VC1 = 2 };

/* Bits of video_picture_flags; the repeat_pict count sits above them. */
enum { FLAG_KEY = 1, FLAG_INTERLACED = 2, FLAG_TFF = 4, REPEAT_SHIFT = 8 };

typedef struct Decoder {
  int codec;
  const AVCodec *av_codec;
  AVCodecContext *ctx;
  AVCodecParserContext *parser;
  AVPacket *pkt;
  AVFrame *frame;
  /* VC-1 opens once the parser has found the sequence and entry-point headers; MPEG opens at once. */
  int opened;
  /* Pictures are dropped until a key picture comes out (after open, a reset or a flush). */
  int need_key;
  int skip_nonref;
  /* Decoded pictures waiting for video_receive, oldest first. */
  AVFrame **queue;
  int queue_len;
  int queue_cap;
  /* The picture video_receive took, its planes copied tightly into out. */
  AVFrame *current;
  uint8_t *out;
  size_t out_cap;
  size_t out_size;
} Decoder;

static void clear_queue(Decoder *d) {
  for (int i = 0; i < d->queue_len; i++) av_frame_free(&d->queue[i]);
  d->queue_len = 0;
  av_frame_unref(d->current);
}

EMSCRIPTEN_KEEPALIVE void video_close(Decoder *d) {
  if (!d) return;
  if (d->queue) clear_queue(d);
  free(d->queue);
  av_parser_close(d->parser);
  avcodec_free_context(&d->ctx);
  av_packet_free(&d->pkt);
  av_frame_free(&d->frame);
  av_frame_free(&d->current);
  free(d->out);
  free(d);
}

static int open_parser(Decoder *d) {
  av_parser_close(d->parser);
  d->parser = av_parser_init(d->av_codec->id);
  /* Slices are arbitrary (PARSER_FLAG_COMPLETE_FRAMES stays off): the parser finds where pictures start. */
  return d->parser ? 0 : -1;
}

/* codec 0: MPEG-1 video; 1: MPEG-2 video; 2: VC-1 (SMPTE 421M Annex E, start codes in band). Returns NULL on failure. */
EMSCRIPTEN_KEEPALIVE Decoder *video_open(int codec) {
  av_log_set_level(AV_LOG_QUIET);
  enum AVCodecID id = codec == CODEC_MPEG1 ? AV_CODEC_ID_MPEG1VIDEO
                      : codec == CODEC_MPEG2 ? AV_CODEC_ID_MPEG2VIDEO
                      : codec == CODEC_VC1 ? AV_CODEC_ID_VC1
                                           : AV_CODEC_ID_NONE;
  if (id == AV_CODEC_ID_NONE) return NULL;
  const AVCodec *c = avcodec_find_decoder(id);
  if (!c) return NULL;
  Decoder *d = calloc(1, sizeof(*d));
  if (!d) return NULL;
  d->codec = codec;
  d->av_codec = c;
  d->need_key = 1;
  d->ctx = avcodec_alloc_context3(c);
  d->pkt = av_packet_alloc();
  d->frame = av_frame_alloc();
  d->current = av_frame_alloc();
  int ok = d->ctx && d->pkt && d->frame && d->current && open_parser(d) == 0;
  if (ok) {
    d->ctx->thread_count = 1;
    d->ctx->pkt_timebase = (AVRational){1, 1000000};
    if (codec != CODEC_VC1) ok = avcodec_open2(d->ctx, c, NULL) >= 0;
    d->opened = codec != CODEC_VC1;
  }
  if (!ok) {
    video_close(d);
    return NULL;
  }
  return d;
}

static const uint8_t *find_start_code(const uint8_t *p, const uint8_t *end, int code) {
  for (; p + 3 < end; p++) {
    if (p[0] == 0 && p[1] == 0 && p[2] == 1 && (code < 0 || p[3] == code)) return p;
  }
  return NULL;
}

/* VC-1: opens the decoder with the sequence and entry-point headers in front of the packet's frame. 1 when open. */
static int open_vc1(Decoder *d, const uint8_t *data, int size) {
  const uint8_t *end = data + size;
  const uint8_t *seq = find_start_code(data, end, 0x0F);
  if (!seq) return 0;
  const uint8_t *frame = find_start_code(seq + 4, end, 0x0D);
  size_t len = (size_t)((frame ? frame : end) - seq);
  uint8_t *extradata = av_mallocz(len + AV_INPUT_BUFFER_PADDING_SIZE);
  if (!extradata) return 0;
  memcpy(extradata, seq, len);
  av_freep(&d->ctx->extradata);
  d->ctx->extradata = extradata;
  d->ctx->extradata_size = (int)len;
  if (avcodec_open2(d->ctx, d->av_codec, NULL) < 0) {
    /* A context that failed to open can't be opened again: start a fresh one for the next headers. */
    avcodec_free_context(&d->ctx);
    d->ctx = avcodec_alloc_context3(d->av_codec);
    if (d->ctx) {
      d->ctx->thread_count = 1;
      d->ctx->pkt_timebase = (AVRational){1, 1000000};
    }
    return 0;
  }
  d->ctx->skip_frame = d->skip_nonref ? AVDISCARD_NONREF : AVDISCARD_DEFAULT;
  d->opened = 1;
  return 1;
}

static int enqueue(Decoder *d, AVFrame *f) {
  if (d->queue_len == d->queue_cap) {
    int cap = d->queue_cap ? d->queue_cap * 2 : 16;
    AVFrame **q = realloc(d->queue, (size_t)cap * sizeof(*q));
    if (!q) return -1;
    d->queue = q;
    d->queue_cap = cap;
  }
  AVFrame *copy = av_frame_alloc();
  if (!copy) return -1;
  av_frame_move_ref(copy, f);
  d->queue[d->queue_len++] = copy;
  return 0;
}

/* Takes every picture the decoder has ready. Returns 0, or -1 when out of memory. */
static int receive_all(Decoder *d) {
  for (;;) {
    int r = avcodec_receive_frame(d->ctx, d->frame);
    if (r < 0) return 0;
    if (d->need_key && !(d->frame->flags & AV_FRAME_FLAG_KEY)) {
      av_frame_unref(d->frame);
      continue;
    }
    d->need_key = 0;
    if (enqueue(d, d->frame) < 0) {
      av_frame_unref(d->frame);
      return -1;
    }
  }
}

/* Sends one parsed picture to the decoder. Returns 1 when the decoder rejected it, 0 when taken, -1 out of memory. */
static int decode_packet(Decoder *d, const uint8_t *data, int size, int64_t pts) {
  if (!d->opened && !open_vc1(d, data, size)) return 0;
  av_packet_unref(d->pkt);
  if (av_new_packet(d->pkt, size) < 0) return -1;
  memcpy(d->pkt->data, data, size);
  d->pkt->pts = pts;
  int rejected = avcodec_send_packet(d->ctx, d->pkt) < 0;
  if (receive_all(d) < 0) return -1;
  return rejected;
}

/*
 * Feeds bytes of the elementary stream: any slice, the parser finds the pictures. pts_us is the PES time of the first
 * picture that starts in these bytes, when has_pts is set. Returns the pictures the decoder rejected (0 or more), or
 * -1 when out of memory.
 */
EMSCRIPTEN_KEEPALIVE int video_push(Decoder *d, const uint8_t *in, int len, double pts_us, int has_pts) {
  int64_t pts = has_pts ? (int64_t)llround(pts_us) : AV_NOPTS_VALUE;
  int rejected = 0;
  while (len > 0) {
    uint8_t *out = NULL;
    int out_size = 0;
    if (!d->ctx) return -1;
    int used = av_parser_parse2(d->parser, d->ctx, &out, &out_size, in, len, pts, AV_NOPTS_VALUE, 0);
    in += used;
    len -= used;
    /* As libavformat does: the time belongs to the bytes' first call only. */
    pts = AV_NOPTS_VALUE;
    if (out_size > 0) {
      int r = decode_packet(d, out, out_size, d->parser->pts);
      if (r < 0) return -1;
      rejected += r;
    }
  }
  return rejected;
}

/* Ends the stream: the parser's last picture and the decoder's delayed ones are made ready. The decoder then takes a new
 * stream from its next key picture. Returns as video_push. */
EMSCRIPTEN_KEEPALIVE int video_flush(Decoder *d) {
  if (!d->ctx) return -1;
  int rejected = 0;
  uint8_t *out = NULL;
  int out_size = 0;
  av_parser_parse2(d->parser, d->ctx, &out, &out_size, NULL, 0, AV_NOPTS_VALUE, AV_NOPTS_VALUE, 0);
  if (out_size > 0) {
    int r = decode_packet(d, out, out_size, d->parser->pts);
    if (r < 0) return -1;
    rejected += r;
  }
  if (d->opened) {
    avcodec_send_packet(d->ctx, NULL);
    if (receive_all(d) < 0) return -1;
    avcodec_flush_buffers(d->ctx);
  }
  if (open_parser(d) < 0) return -1;
  d->need_key = 1;
  return rejected;
}

/* Drops every picture in the parser, the decoder and the queue (a seek); the next picture out is a key picture. */
EMSCRIPTEN_KEEPALIVE void video_reset(Decoder *d) {
  clear_queue(d);
  if (d->opened) avcodec_flush_buffers(d->ctx);
  open_parser(d);
  d->need_key = 1;
}

/* Non-zero: the decoder skips pictures nothing refers to (B pictures). */
EMSCRIPTEN_KEEPALIVE void video_set_skip(Decoder *d, int on) {
  d->skip_nonref = on != 0;
  if (d->ctx) d->ctx->skip_frame = on ? AVDISCARD_NONREF : AVDISCARD_DEFAULT;
}

/*
 * Takes the next decoded picture and copies its planes, tightly packed I420, for the accessors below. Returns 1, 0 when
 * none is ready, -2 when the picture isn't 4:2:0 (it is dropped), -1 when out of memory.
 */
EMSCRIPTEN_KEEPALIVE int video_receive(Decoder *d) {
  av_frame_unref(d->current);
  if (d->queue_len == 0) return 0;
  AVFrame *f = d->queue[0];
  memmove(d->queue, d->queue + 1, (size_t)(d->queue_len - 1) * sizeof(*d->queue));
  d->queue_len--;
  av_frame_move_ref(d->current, f);
  av_frame_free(&f);
  f = d->current;
  if (f->format != AV_PIX_FMT_YUV420P && f->format != AV_PIX_FMT_YUVJ420P) {
    av_frame_unref(f);
    return -2;
  }
  int w = f->width, h = f->height;
  int cw = (w + 1) >> 1, ch = (h + 1) >> 1;
  size_t size = (size_t)w * h + 2 * (size_t)cw * ch;
  if (size > d->out_cap) {
    uint8_t *p = realloc(d->out, size);
    if (!p) {
      av_frame_unref(f);
      return -1;
    }
    d->out = p;
    d->out_cap = size;
  }
  uint8_t *o = d->out;
  for (int y = 0; y < h; y++, o += w) memcpy(o, f->data[0] + (ptrdiff_t)y * f->linesize[0], w);
  for (int p = 1; p <= 2; p++) {
    for (int y = 0; y < ch; y++, o += cw) memcpy(o, f->data[p] + (ptrdiff_t)y * f->linesize[p], cw);
  }
  d->out_size = size;
  return 1;
}

EMSCRIPTEN_KEEPALIVE uint8_t *video_picture_data(Decoder *d) { return d->out; }
EMSCRIPTEN_KEEPALIVE int video_picture_size(Decoder *d) { return (int)d->out_size; }
EMSCRIPTEN_KEEPALIVE int video_picture_width(Decoder *d) { return d->current->width; }
EMSCRIPTEN_KEEPALIVE int video_picture_height(Decoder *d) { return d->current->height; }
EMSCRIPTEN_KEEPALIVE int video_picture_sar_num(Decoder *d) { return d->current->sample_aspect_ratio.num; }
EMSCRIPTEN_KEEPALIVE int video_picture_sar_den(Decoder *d) { return d->current->sample_aspect_ratio.den; }
/* The picture's time in microseconds, NaN when neither it nor the bytes it came in had one. */
EMSCRIPTEN_KEEPALIVE double video_picture_pts(Decoder *d) {
  return d->current->pts == AV_NOPTS_VALUE ? NAN : (double)d->current->pts;
}
/* FLAG_KEY, FLAG_INTERLACED and FLAG_TFF, with repeat_pict (extra fields shown, in halves of a frame) above REPEAT_SHIFT. */
EMSCRIPTEN_KEEPALIVE int video_picture_flags(Decoder *d) {
  const AVFrame *f = d->current;
  int flags = 0;
  if (f->flags & AV_FRAME_FLAG_KEY) flags |= FLAG_KEY;
  if (f->flags & AV_FRAME_FLAG_INTERLACED) flags |= FLAG_INTERLACED;
  if (f->flags & AV_FRAME_FLAG_TOP_FIELD_FIRST) flags |= FLAG_TFF;
  return flags | (f->repeat_pict << REPEAT_SHIFT);
}
/* The picture's matrix_coefficients (AVColorSpace, numbered as H.264 Table E-5), 2 when unspecified. */
EMSCRIPTEN_KEEPALIVE int video_picture_colorspace(Decoder *d) { return d->current->colorspace; }
/* The stream's frame rate as the sequence header gives it; 0 over 1 when it gives none. */
EMSCRIPTEN_KEEPALIVE int video_frame_rate_num(Decoder *d) { return d->ctx ? d->ctx->framerate.num : 0; }
EMSCRIPTEN_KEEPALIVE int video_frame_rate_den(Decoder *d) { return d->ctx ? d->ctx->framerate.den : 1; }
