/*
 * Seikou audio decoder shim over FFmpeg libavcodec (eac3, dca, truehd).
 * Copyright (c) 2026 Seikou contributors
 *
 * Original code, kept LGPL-2.1-or-later because it is compiled into audio.wasm with FFmpeg, which is LGPL-2.1-or-later,
 * so the module carries one licence.
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
  /* The last audio_decode's output channels and their AVChannel ids. */
  int channels;
  enum AVChannel layout[8];
} Decoder;

EMSCRIPTEN_KEEPALIVE void audio_close(Decoder *d) {
  if (!d) return;
  avcodec_free_context(&d->ctx);
  av_packet_free(&d->pkt);
  av_frame_free(&d->frame);
  free(d);
}

/*
 * codec 0: AC-3 and E-AC-3 (FFmpeg's eac3 decoder handles both by bsid); 1: DTS core only; 2: DTS with its extensions
 * (XLL, XBR, X96, XXCH); 3: TrueHD. out_channels 2 asks for a stereo downmix; 6 asks TrueHD and DTS for 5.1 (their
 * own presentation or embedded downmix); anything else asks for nothing and the stream's own layout comes out.
 */
EMSCRIPTEN_KEEPALIVE Decoder *audio_open(int codec, int out_channels) {
  av_log_set_level(AV_LOG_QUIET);
  enum AVCodecID id = codec == 1 || codec == 2 ? AV_CODEC_ID_DTS : codec == 3 ? AV_CODEC_ID_TRUEHD : AV_CODEC_ID_EAC3;
  const AVCodec *c = avcodec_find_decoder(id);
  if (!c) return NULL;
  Decoder *d = calloc(1, sizeof(*d));
  if (!d) return NULL;
  d->ctx = avcodec_alloc_context3(c);
  d->pkt = av_packet_alloc();
  d->frame = av_frame_alloc();
  AVDictionary *opts = NULL;
  if (out_channels == 2) av_dict_set(&opts, "downmix", "stereo", 0);
  else if (out_channels == 6 && codec >= 2) av_dict_set(&opts, "downmix", "5.1(side)", 0);
  if (codec == 1) av_dict_set(&opts, "core_only", "1", 0);
  int ok = d->ctx && d->pkt && d->frame && avcodec_open2(d->ctx, c, &opts) >= 0;
  /* avcodec_open2 removes the options it consumed. A leftover "core_only" means DTS extensions would be decoded: fail.
   * A leftover "downmix" is tolerated; the caller folds whatever layout comes out. */
  if (ok && codec == 1 && av_dict_get(opts, "core_only", NULL, 0)) ok = 0;
  av_dict_free(&opts);
  if (!ok) {
    audio_close(d);
    return NULL;
  }
  return d;
}

static float sample_at(const AVFrame *f, int ch, int i) {
  int n = f->ch_layout.nb_channels;
  switch (f->format) {
    case AV_SAMPLE_FMT_FLTP: return ((const float *)f->extended_data[ch])[i];
    case AV_SAMPLE_FMT_FLT: return ((const float *)f->extended_data[0])[i * n + ch];
    case AV_SAMPLE_FMT_S16P: return ((const int16_t *)f->extended_data[ch])[i] / 32768.0f;
    case AV_SAMPLE_FMT_S16: return ((const int16_t *)f->extended_data[0])[i * n + ch] / 32768.0f;
    case AV_SAMPLE_FMT_S32P: return ((const int32_t *)f->extended_data[ch])[i] / 2147483648.0f;
    case AV_SAMPLE_FMT_S32: return ((const int32_t *)f->extended_data[0])[i * n + ch] / 2147483648.0f;
    default: return 0.0f;
  }
}

#define MAX_CHANNELS 8

/* Interleaved, in the decoder's own channel order (audio_channel names each). */
static int write_frame(Decoder *d, const AVFrame *f, float *out, int max_frames) {
  int n = f->nb_samples;
  int channels = f->ch_layout.nb_channels;
  if (n > max_frames) return -2;
  if (channels < 1 || channels > MAX_CHANNELS) return -3;
  if (d->channels != 0 && d->channels != channels) return -4; /* a layout change inside one packet: rejected */
  d->channels = channels;
  for (int c = 0; c < channels; c++) d->layout[c] = av_channel_layout_channel_from_index(&f->ch_layout, c);
  for (int i = 0; i < n; i++)
    for (int c = 0; c < channels; c++) out[i * channels + c] = sample_at(f, c, i);
  return n;
}

/* Decodes one packet; returns sample frames written to out (interleaved, audio_channels() each), or a negative error. */
EMSCRIPTEN_KEEPALIVE int audio_decode(Decoder *d, const uint8_t *in, int len, float *out, int max_frames) {
  av_packet_unref(d->pkt);
  if (av_new_packet(d->pkt, len) < 0) return -12;
  memcpy(d->pkt->data, in, len);
  if (avcodec_send_packet(d->ctx, d->pkt) < 0) return -1;
  d->channels = 0;
  int total = 0;
  for (;;) {
    int r = avcodec_receive_frame(d->ctx, d->frame);
    if (r == AVERROR(EAGAIN) || r == AVERROR_EOF) break;
    if (r < 0) return -1;
    int n = write_frame(d, d->frame, out + total * (d->channels ? d->channels : 0), max_frames - total);
    av_frame_unref(d->frame);
    if (n < 0) return n;
    total += n;
  }
  return total;
}

/* The channel count of the last audio_decode's output (0 when it gave none). */
EMSCRIPTEN_KEEPALIVE int audio_channels(Decoder *d) { return d->channels; }

/* The AVChannel of output channel i of the last audio_decode. */
EMSCRIPTEN_KEEPALIVE int audio_channel(Decoder *d, int i) { return i >= 0 && i < d->channels ? (int)d->layout[i] : -1; }

EMSCRIPTEN_KEEPALIVE int audio_sample_rate(Decoder *d) { return d->ctx->sample_rate; }

EMSCRIPTEN_KEEPALIVE void audio_reset(Decoder *d) { avcodec_flush_buffers(d->ctx); }
