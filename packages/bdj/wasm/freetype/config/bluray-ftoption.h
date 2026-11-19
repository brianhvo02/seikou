/*
 * FreeType options for freetype.wasm: Ubuntu 24.04's (libfreetype6 2.13.2+dfsg-1ubuntu0.2, the build libbluray links
 * in tools/bdj-trace/), which is upstream ftoption.h with Debian's ftoption.patch applied (build.sh applies it), minus
 * the options for what a font from memory never needs: compressed streams and files, PNG and SVG glyphs, Mac resource
 * forks and the FREETYPE_PROPERTIES environment variable (unset in the harness, so its defaults are what libbluray
 * gets). The options that decide how outlines are hinted and rasterised are left as Ubuntu has them: the TrueType
 * bytecode interpreter with subpixel hinting (interpreter v40 by default), the auto-hinter with CJK and Indic support,
 * the CFF engine's darkening parameters, FT_CONFIG_OPTION_SUBPIXEL_RENDERING, embedded (non-PNG) bitmaps, no HarfBuzz.
 */
#ifndef BLURAY_FTOPTION_H_
#define BLURAY_FTOPTION_H_

#include <freetype/config/ftoption.h>

#undef FT_CONFIG_OPTION_ENVIRONMENT_PROPERTIES
#undef FT_CONFIG_OPTION_USE_LZW
#undef FT_CONFIG_OPTION_USE_ZLIB
#undef FT_CONFIG_OPTION_SYSTEM_ZLIB
#undef FT_CONFIG_OPTION_USE_BZIP2
#undef FT_CONFIG_OPTION_USE_PNG
#undef FT_CONFIG_OPTION_USE_HARFBUZZ
#undef FT_CONFIG_OPTION_USE_BROTLI
#undef FT_CONFIG_OPTION_MAC_FONTS
#undef FT_CONFIG_OPTION_GUESSING_EMBEDDED_RFORK
#undef FT_CONFIG_OPTION_SVG

#endif
