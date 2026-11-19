#!/usr/bin/env bash
# Builds freetype.wasm (FreeType and shim.c) in Docker, reproducibly, for BD-J text.
# Pinned: the emsdk image audio.wasm uses (by digest), and FreeType as Ubuntu 24.04 ships it to the libbluray BD-J
# harness (tools/bdj-trace/Dockerfile: apt snapshot 20261015T000000Z, libfreetype6 2.13.2+dfsg-1ubuntu0.2): the
# source package from that snapshot, checked by SHA-256, with Ubuntu's patches that touch the library (its options
# and two security fixes) and ftgrays-dda.patch (the host's curve flattening). Options and modules: config/ in this
# folder. linux/amd64 everywhere, so CI and Apple-silicon hosts produce the same bytes.
set -euo pipefail

FT_VERSION=2.13.2
UBUNTU_REVISION=2.13.2+dfsg-1ubuntu0.2
SNAPSHOT=https://snapshot.ubuntu.com/ubuntu/20261015T000000Z/pool/main/f/freetype
ORIG_SHA256=48c78a4194adfcd15a4d089f3206dab8454c311f5577f3ef7eaef95f777f86e6
DEBIAN_SHA256=9d0624fe997a7574250dfac286275dc5469b49bdc7a4fe5814c1ca35110dcb5e
# Ubuntu's series also has enable-gxvalid-otvalid.patch (validator modules, left out here) and documentation patches.
PATCHES="ftoption.patch CVE-2026-23865.patch CVE-2026-95512.patch"
EMSDK_IMAGE=emscripten/emsdk@sha256:77638e6c215a65f25a704c0c831d5c2463a8c0468a58c6cb82489dbe621dfa05
HERE="$(cd "$(dirname "$0")" && pwd)"

if [[ "${1:-}" != "--inside" ]]; then
  exec docker run --rm --platform linux/amd64 -e SOURCE_DATE_EPOCH=0 -v "$HERE:/out" "$EMSDK_IMAGE" bash /out/build.sh --inside
fi

mkdir -p /build && cd /build
fetch() { # <file> <sha256>
  curl -fsSL -o "$1" "$SNAPSHOT/${1//+/%2B}"
  echo "$2  $1" | sha256sum -c --quiet
}
fetch "freetype_${FT_VERSION}+dfsg.orig.tar.xz" "$ORIG_SHA256"
fetch "freetype_${UBUNTU_REVISION}.debian.tar.xz" "$DEBIAN_SHA256"
tar -xJf "freetype_${FT_VERSION}+dfsg.orig.tar.xz"
tar -xJf "freetype_${UBUNTU_REVISION}.debian.tar.xz"
cd "freetype-$FT_VERSION"
for p in $PATCHES; do patch -p1 --quiet < "../debian/patches/$p"; done
# The harness's FreeType runs on x86-64, where ftgrays.c flattens curves by DDA (FT_SSE2); wasm32 would split them
# instead, and large glyphs' edges round differently (Ruling R18). Same arithmetic as the host's, in plain C.
patch -p1 --quiet < /out/ftgrays-dda.patch

FT=src
SOURCES="$FT/base/ftsystem.c $FT/base/ftinit.c $FT/base/ftdebug.c $FT/base/ftbase.c
  $FT/base/ftbitmap.c $FT/base/ftglyph.c $FT/base/ftmm.c $FT/base/ftbbox.c
  $FT/truetype/truetype.c $FT/cff/cff.c $FT/sfnt/sfnt.c $FT/autofit/autofit.c $FT/pshinter/pshinter.c
  $FT/psaux/psaux.c $FT/psnames/psnames.c $FT/smooth/smooth.c"
emcc -Oz -sSUPPORT_LONGJMP=wasm -sWASM_LEGACY_EXCEPTIONS=1 -DFT2_BUILD_LIBRARY \
  '-DFT_CONFIG_OPTIONS_H=<bluray-ftoption.h>' '-DFT_CONFIG_MODULES_H=<bluray-ftmodule.h>' \
  -Iinclude -I/out/config \
  $SOURCES /out/shim.c \
  -sSTANDALONE_WASM --no-entry -sALLOW_MEMORY_GROWTH=1 -sINITIAL_MEMORY=2MB -sFILESYSTEM=0 -sSTACK_SIZE=1MB \
  -sEXPORTED_FUNCTIONS=_ft_init,_ft_last_error,_ft_new_face,_ft_done_face,_ft_family_name,_ft_style_name,_ft_set_char_size,_ft_size_metrics,_ft_load_char,_ft_glyph_info,_ft_glyph_bitmap,_ft_kerning,_malloc,_free \
  -o /build/freetype.wasm
cp /build/freetype.wasm /out/freetype.wasm
cd /out && sha256sum freetype.wasm > freetype.wasm.sha256
