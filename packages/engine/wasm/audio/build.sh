#!/usr/bin/env bash
# Builds audio.wasm (FFmpeg's eac3 + dca decoders and shim.c) in Docker, reproducibly.
# Pinned: emscripten/emsdk 6.0.12 by digest, FFmpeg by tag. linux/amd64 everywhere, so CI and
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
  --enable-decoder=ac3,eac3,dca \
  --extra-cflags=-Oz
emmake make -j"$(nproc)" libavcodec/libavcodec.a libavutil/libavutil.a
emcc -Oz -I/build/ffmpeg /out/shim.c libavcodec/libavcodec.a libavutil/libavutil.a \
  -sSTANDALONE_WASM --no-entry -sALLOW_MEMORY_GROWTH=1 -sFILESYSTEM=0 -sSTACK_SIZE=1MB \
  -sEXPORTED_FUNCTIONS=_audio_open,_audio_decode,_audio_sample_rate,_audio_reset,_audio_close,_malloc,_free \
  -o /build/audio.wasm
cp /build/audio.wasm /out/audio.wasm
cd /out && sha256sum audio.wasm > audio.wasm.sha256
