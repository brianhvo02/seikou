#!/usr/bin/env bash
# Builds video.wasm (FFmpeg's mpeg1video, mpeg2video and vc1 decoders, the mpegvideo and vc1 parsers, and shim.c) in
# Docker, reproducibly. Pinned: emscripten/emsdk 6.0.12 by digest, FFmpeg by tag. linux/amd64 everywhere, so CI and
# Apple-silicon hosts produce the same bytes.
set -euo pipefail

FFMPEG_TAG=n9.0.2
EMSDK_IMAGE=emscripten/emsdk@sha256:77638e6c215a65f25a704c0c831d5c2463a8c0468a58c6cb82489dbe621dfa05
HERE="$(cd "$(dirname "$0")" && pwd)"

if [[ "${1:-}" != "--inside" ]]; then
  exec docker run --rm --platform linux/amd64 -e SOURCE_DATE_EPOCH=0 -v "$HERE:/out" "$EMSDK_IMAGE" bash /out/build.sh --inside
fi

git clone --quiet --depth 1 --branch "$FFMPEG_TAG" https://git.ffmpeg.org/ffmpeg.git /build/ffmpeg
cd /build/ffmpeg
emconfigure ./configure \
  --cc=emcc --cxx=em++ --ar=emar --ranlib=emranlib --nm=emnm \
  --target-os=none --arch=x86_32 --enable-cross-compile \
  --disable-asm --disable-inline-asm --disable-x86asm --disable-runtime-cpudetect \
  --disable-autodetect --disable-everything --disable-programs --disable-doc --disable-debug --disable-stripping \
  --disable-avdevice --disable-avformat --disable-avfilter --disable-swresample --disable-swscale --disable-network \
  --disable-pthreads --disable-w32threads --disable-os2threads \
  --enable-decoder=mpeg1video,mpeg2video,vc1 \
  --enable-parser=mpegvideo,vc1 \
  --extra-cflags="-O3 -msimd128"
emmake make -j"$(nproc)" libavcodec/libavcodec.a libavutil/libavutil.a
emcc -O3 -msimd128 -I/build/ffmpeg /out/shim.c libavcodec/libavcodec.a libavutil/libavutil.a \
  -sSTANDALONE_WASM --no-entry -sALLOW_MEMORY_GROWTH=1 -sFILESYSTEM=0 -sSTACK_SIZE=1MB \
  -sEXPORTED_FUNCTIONS=_video_open,_video_push,_video_flush,_video_receive,_video_reset,_video_set_skip,_video_close,_video_picture_data,_video_picture_size,_video_picture_width,_video_picture_height,_video_picture_sar_num,_video_picture_sar_den,_video_picture_pts,_video_picture_flags,_video_picture_colorspace,_video_frame_rate_num,_video_frame_rate_den,_malloc,_free \
  -o /build/video.wasm
cp /build/video.wasm /out/video.wasm
cd /out && sha256sum video.wasm > video.wasm.sha256
