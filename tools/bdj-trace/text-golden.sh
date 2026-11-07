#!/usr/bin/env bash
# Regenerates tests/bdj/fonts/text-golden.json: what libbluray's BD-J font and text natives (the compiled
# bdj/native/java_awt_BDFontMetrics.c and java_awt_BDGraphics.c objects of the harness image's libbluray build, on its
# system FreeType) return and draw for the bundled fallback font, opened through the JRE font path the harness links to
# it (LucidaSansRegular.ttf), and for a font a disc could ship (fixtures/ass/fonts/DejaVuSerif.ttf). text_golden.c
# drives them through a fake JNIEnv. The Vitest test src/bdj/jvm/natives/fonts.test.ts compares bluray-web's
# natives with it exactly. Needs the harness image: npm run bdj-trace:build.
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/../.." && pwd)"
IMAGE=bluray-web-bdj-trace
PLATFORM="${BDJ_TRACE_PLATFORM:-linux/amd64}"
OUT="$ROOT/tests/bdj/fonts/text-golden.json"
OBJ=/src/libbluray/build/src/libbluray.so.4.0.0.p

mkdir -p "$(dirname "$OUT")"
docker run --rm --network none --platform "$PLATFORM" \
  -v "$HERE/text_golden.c:/golden/text_golden.c:ro" \
  -v "$ROOT/fixtures/ass/fonts/DejaVuSerif.ttf:/fonts/DejaVuSerif.ttf:ro" \
  "$IMAGE" sh -c "gcc -O1 -Wall -Wextra -Werror -I/src/libbluray/jni -I/src/libbluray/jni/linux -o /tmp/text_golden \
      /golden/text_golden.c $OBJ/libbluray_bdj_native_java_awt_BDFontMetrics.c.o $OBJ/libbluray_bdj_native_java_awt_BDGraphics.c.o \
      \$(pkg-config --libs freetype2) \
    && /tmp/text_golden \"\$JAVA_HOME/jre/lib/fonts/LucidaSansRegular.ttf\" /fonts/DejaVuSerif.ttf /fonts/missing.ttf /golden/text_golden.c" \
  > "$OUT.tmp"
mv "$OUT.tmp" "$OUT"
echo "wrote tests/bdj/fonts/text-golden.json"
