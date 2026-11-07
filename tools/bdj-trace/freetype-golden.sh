#!/usr/bin/env bash
# Regenerates tests/bdj/fonts/freetype-golden.json: glyphs, advances, metrics and kerning of the bundled font
# (packages/ass/src/default-font.ttf) from the system FreeType that libbluray links in the BD-J harness image, made with
# the calls libbluray's BD-J text natives make (freetype_golden.c). The Vitest test freetype.test.ts compares
# src/wasm/freetype/freetype.wasm with it byte for byte. Needs the harness image: npm run bdj-trace:build.
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/../.." && pwd)"
IMAGE=bluray-web-bdj-trace
PLATFORM="${BDJ_TRACE_PLATFORM:-linux/amd64}"
OUT="$ROOT/tests/bdj/fonts/freetype-golden.json"

mkdir -p "$(dirname "$OUT")"
docker run --rm --network none --platform "$PLATFORM" \
  -v "$HERE/freetype_golden.c:/src/freetype_golden.c:ro" \
  -v "$ROOT/packages/ass/src/default-font.ttf:/fonts/default-font.ttf:ro" \
  "$IMAGE" sh -c 'gcc -O1 -Wall -Wextra -Werror -o /tmp/freetype_golden /src/freetype_golden.c $(pkg-config --cflags --libs freetype2) \
    && echo "libfreetype6 $(dpkg-query -W -f "\${Version}" libfreetype6)" >&2 \
    && /tmp/freetype_golden /fonts/default-font.ttf' > "$OUT.tmp"
mv "$OUT.tmp" "$OUT"
echo "wrote tests/bdj/fonts/freetype-golden.json"
