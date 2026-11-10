// SPDX-License-Identifier: LGPL-3.0-or-later
/** In a worker, as the engine runs it: AssFonts with the device's fonts, a script naming one family and no fonts. */
import { createDeviceFontSource } from '@seikou/ass/device-fonts';
import { readFontFile } from '@seikou/ass/font-tables';
import { AssFonts, createFontFaceLoader } from '@seikou/ass/fonts';
import { FrameBuilder } from '@seikou/ass/frame';
import { createCanvasMeasurer } from '@seikou/ass/measure';
import { parseAss } from '@seikou/ass/parse';
import type { DeviceWorkerResult } from './types';

const TEXT = 'Wavy Horizons';

self.onmessage = async (e: MessageEvent<string>) => {
  const family = e.data;
  const fontSet = (self as unknown as { fonts: FontFaceSet }).fonts;
  const ctx = new OffscreenCanvas(1, 1).getContext('2d')!;
  const dejavu = new Uint8Array(await (await fetch('/fixtures/ass/fonts/DejaVuSans.ttf')).arrayBuffer());
  const defaultFont = await readFontFile('DejaVuSans.ttf', dejavu);
  // DejaVu Sans on its own, to compare widths with
  const reference = new FontFace('dejavu-reference', dejavu);
  fontSet.add(await reference.load());
  const fonts = new AssFonts(createFontFaceLoader(fontSet), defaultFont, { deviceFonts: createDeviceFontSource(fontSet, ctx) });
  const track = parseAss([
    '[Script Info]', 'ScriptType: v4.00+', 'PlayResX: 1920', 'PlayResY: 1080', '',
    '[V4+ Styles]',
    'Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding',
    `Style: Default,${family},60,&H00FFFFFF,&H000000FF,&H00000000,&H00000000,0,0,0,0,100,100,0,0,1,2,0,2,10,10,10,1`, '',
    '[Events]', 'Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text',
    `Dialogue: 0,0:00:00.00,0:00:05.00,Default,,0,0,0,,${TEXT}`, '',
  ].join('\n'));
  const settings = { frameWidth: 1920, frameHeight: 1080, storageWidth: 1920, storageHeight: 1080, fontScale: 1 };
  new FrameBuilder(track, fonts, createCanvasMeasurer(ctx)).build(1000, settings);
  await fonts.ready();
  const req = { family, bold: 400, italic: 0, vertical: false };
  const face = fonts.resolve(req);
  const width = (css: string): number => {
    ctx.font = `100px "${css}"`;
    return ctx.measureText(TEXT).width;
  };
  const result: DeviceWorkerResult = {
    fallback: face.fallback,
    missingFamilies: [...fonts.missingFamilies()],
    advance: width(face.cssFamily),
    defaultAdvance: width('dejavu-reference'),
    ascender: face.face.ascender,
    descender: face.face.descender,
  };
  fonts.dispose();
  self.postMessage(result);
};
