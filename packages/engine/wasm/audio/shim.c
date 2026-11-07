/*
 * bluray-web audio decoder shim over FFmpeg libavcodec (eac3, dca).
 * Copyright (c) 2026 bluray-web contributors
 *
 * SPDX-License-Identifier: LGPL-2.1-or-later
 */

#include <stdint.h>
#include <stdlib.h>
#include <string.h>
#include <emscripten/emscripten.h>
#include "libavcodec/avcodec.h"
#include "libavutil/channel_layout.h"
#include "libavutil/dict.h"
#include "libavutil/log.h"

typedef struct Decoder {
  AVCodecContext *ctx;
  AVPacket *pkt;
  AVFrame *frame;
} Decoder;

EMSCRIPTEN_KEEPALIVE void audio_close(Decoder *d) {
  if (!d) return;
  avcodec_free_context(&d->ctx);
  av_packet_free(&d->pkt);
  av_frame_free(&d->frame);
  free(d);
}

/* codec 0: AC-3 and E-AC-3 (FFmpeg's eac3 decoder handles both by bsid); codec 1: DTS core. */
EMSCRIPTEN_KEEPALIVE Decoder *audio_open(int codec) {
  av_log_set_level(AV_LOG_QUIET);
  const AVCodec *c = avcodec_find_decoder(codec == 1 ? AV_CODEC_ID_DTS : AV_CODEC_ID_EAC3);
  if (!c) return NULL;
  Decoder *d = calloc(1, sizeof(*d));
  if (!d) return NULL;
  d->ctx = avcodec_alloc_context3(c);
  d->pkt = av_packet_alloc();
  d->frame = av_frame_alloc();
  AVDictionary *opts = NULL;
  av_dict_set(&opts, "downmix", "stereo", 0);
  if (codec == 1) av_dict_set(&opts, "core_only", "1", 0);
  int ok = d->ctx && d->pkt && d->frame && avcodec_open2(d->ctx, c, &opts) >= 0;
  /* avcodec_open2 removes the options it consumed. A leftover "core_only" means DTS extensions would be decoded: fail.
   * A leftover "downmix" is tolerated; write_frame folds multichannel output down itself. */
  if (ok && codec == 1 && av_dict_get(opts, "core_only", NULL, 0)) ok = 0;
  av_dict_free(&opts);
  if (!ok) {
    audio_close(d);
    return NULL;
  }
  return d;
}

static float sample_at(const AVFrame *f, int ch, int i) {
  switch (f->format) {
    case AV_SAMPLE_FMT_FLTP: return ((const float *)f->extended_data[ch])[i];
    case AV_SAMPLE_FMT_FLT: return ((const float *)f->extended_data[0])[i * f->ch_layout.nb_channels + ch];
    case AV_SAMPLE_FMT_S16P: return ((const int16_t *)f->extended_data[ch])[i] / 32768.0f;
    case AV_SAMPLE_FMT_S32P: return ((const int32_t *)f->extended_data[ch])[i] / 2147483648.0f;
    default: return 0.0f;
  }
}

/* Interleaved stereo. More than two channels means the decoder ignored "downmix": fold them down here. */
static int write_frame(const AVFrame *f, float *out, int max_frames) {
  int n = f->nb_samples;
  int channels = f->ch_layout.nb_channels;
  if (n > max_frames) return -2;
  if (channels == 1) {
    for (int i = 0; i < n; i++) out[2 * i] = out[2 * i + 1] = sample_at(f, 0, i);
    return n;
  }
  if (channels == 2) {
    for (int i = 0; i < n; i++) {
      out[2 * i] = sample_at(f, 0, i);
      out[2 * i + 1] = sample_at(f, 1, i);
    }
    return n;
  }
  const AVChannelLayout *l = &f->ch_layout;
  int fl = av_channel_layout_index_from_channel(l, AV_CHAN_FRONT_LEFT);
  int fr = av_channel_layout_index_from_channel(l, AV_CHAN_FRONT_RIGHT);
  int fc = av_channel_layout_index_from_channel(l, AV_CHAN_FRONT_CENTER);
  int sl = av_channel_layout_index_from_channel(l, AV_CHAN_SIDE_LEFT);
  int sr = av_channel_layout_index_from_channel(l, AV_CHAN_SIDE_RIGHT);
  int bl = av_channel_layout_index_from_channel(l, AV_CHAN_BACK_LEFT);
  int br = av_channel_layout_index_from_channel(l, AV_CHAN_BACK_RIGHT);
  if (fl < 0 || fr < 0) { fl = 0; fr = 1; }
  const float k = 0.70710678f;
  float norm = 1.0f / (1.0f + (fc >= 0 ? k : 0) + (sl >= 0 ? k : 0) + (bl >= 0 ? k : 0));
  for (int i = 0; i < n; i++) {
    float c = fc >= 0 ? k * sample_at(f, fc, i) : 0;
    float left = sample_at(f, fl, i) + c + (sl >= 0 ? k * sample_at(f, sl, i) : 0) + (bl >= 0 ? k * sample_at(f, bl, i) : 0);
    float right = sample_at(f, fr, i) + c + (sr >= 0 ? k * sample_at(f, sr, i) : 0) + (br >= 0 ? k * sample_at(f, br, i) : 0);
    out[2 * i] = left * norm;
    out[2 * i + 1] = right * norm;
  }
  return n;
}

/* Decodes one access unit; returns stereo frames written to out, or a negative error. */
EMSCRIPTEN_KEEPALIVE int audio_decode(Decoder *d, const uint8_t *in, int len, float *out, int max_frames) {
  av_packet_unref(d->pkt);
  if (av_new_packet(d->pkt, len) < 0) return -12;
  memcpy(d->pkt->data, in, len);
  if (avcodec_send_packet(d->ctx, d->pkt) < 0) return -1;
  int total = 0;
  for (;;) {
    int r = avcodec_receive_frame(d->ctx, d->frame);
    if (r == AVERROR(EAGAIN) || r == AVERROR_EOF) break;
    if (r < 0) return -1;
    int n = write_frame(d->frame, out + total * 2, max_frames - total);
    av_frame_unref(d->frame);
    if (n < 0) return n;
    total += n;
  }
  return total;
}

EMSCRIPTEN_KEEPALIVE int audio_sample_rate(Decoder *d) { return d->ctx->sample_rate; }

EMSCRIPTEN_KEEPALIVE void audio_reset(Decoder *d) { avcodec_flush_buffers(d->ctx); }
