/*
 * Original code for Seikou: the fonts BD-J finds under java.home. libbluray's java.awt.BDFontMetrics maps the JRE
 * logical font names (serif, sansserif, monospaced, dialog, dialoginput, default, in four styles) to Lucida files under
 * java.home/lib/fonts/. Seikou does not ship them: like the libbluray BD-J harness (tools/bdj-trace/Dockerfile,
 * README.md "Fonts"), every one of those files is the bundled fallback font, packages/ass/src/default-font.ttf (DejaVu
 * Sans), so text draws the same on both sides. The font is fetched the first time one of the files is read.
 *
 * Copyright (C) 2026  Seikou contributors
 *
 * SPDX-License-Identifier: LGPL-2.1-or-later
 */

import type { LazyFile } from '../jvm/vfs';

/** The files BDFontMetrics.initSystemFonts looks for, all linked to the fallback font in the harness. */
export const JRE_FONT_FILES: readonly string[] = [
  'LucidaBrightRegular.ttf',
  'LucidaBrightDemiBold.ttf',
  'LucidaBrightItalic.ttf',
  'LucidaBrightDemiItalic.ttf',
  'LucidaSansRegular.ttf',
  'LucidaSansDemiBold.ttf',
  'LucidaSansOblique.ttf',
  'LucidaSansDemiOblique.ttf',
  'LucidaTypewriterRegular.ttf',
  'LucidaTypewriterBold.ttf',
  'LucidaTypewriterOblique.ttf',
  'LucidaTypewriterBoldOblique.ttf',
];

/** The fallback font's own file, which resolveFontN returns (fontconfig with only that font installed). */
export const DEFAULT_FONT_PATH = '/jdk/lib/fonts/default-font.ttf';

/**
 * The size of packages/ass/src/default-font.ttf, so the files exist with their size before the font is fetched
 * (java.io.File.length() of them is right). system-fonts.test.ts checks it against the file.
 */
export const DEFAULT_FONT_SIZE = 757_076;

/**
 * The files under /jdk/ (Vfs jdkLazy): the twelve JRE font files and DEFAULT_FONT_PATH, all one fetch of the font. A
 * failed fetch is not tried again: later reads fail at once (each would otherwise wait up to the fetch's timeout
 * again, under BDFontMetrics's class lock).
 */
export function systemFontFiles(loadDefaultFont: () => Promise<Uint8Array>): Map<string, LazyFile> {
  let loading: Promise<Uint8Array> | null = null;
  const load = (): Promise<Uint8Array> => (loading ??= loadDefaultFont());
  const file: LazyFile = { size: DEFAULT_FONT_SIZE, load };
  const files = new Map<string, LazyFile>();
  for (const name of [...JRE_FONT_FILES, DEFAULT_FONT_PATH.slice(DEFAULT_FONT_PATH.lastIndexOf('/') + 1)]) files.set(`lib/fonts/${name}`, file);
  return files;
}
