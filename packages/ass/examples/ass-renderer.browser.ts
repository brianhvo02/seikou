// SPDX-License-Identifier: LGPL-3.0-or-later
// Draw an ASS script's events onto a canvas at a time, and see what changed.
import { AssFonts, AssRenderer, createCanvasMeasurer, createFontFaceLoader, drawWarped, parseAss, readFontFile } from '@seikou/ass';

const script = `[Script Info]
ScriptType: v4.00+
PlayResX: 640
PlayResY: 360

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Default,Source Sans 3,40,&H00FFFFFF,&H000000FF,&H00000000,&H80000000,0,0,0,0,100,100,0,0,1,2,1,2,20,20,20,1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
Dialogue: 0,0:00:01.00,0:00:03.00,Default,,0,0,0,,Hello world
`;

export default async function example(): Promise<void> {
  const bytes = new Uint8Array(await (await fetch('/developers/_examples/fixtures/disc-bdj-menu/BDMV/AUXDATA/00000.otf')).arrayBuffer());
  const font = await readFontFile('00000.otf', bytes);
  const fonts = new AssFonts(createFontFaceLoader(document.fonts), font);
  await fonts.add([{ name: '00000.otf', bytes }]);
  const track = parseAss(script);
  fonts.resolve({ family: track.styles[0]!.fontName, bold: 400, italic: 0, vertical: false });
  await fonts.ready();
  const canvas = new OffscreenCanvas(640, 360);
  const ctx = canvas.getContext('2d')!;

  // #region construct
  const renderer = new AssRenderer(track, fonts, {
    measurer: createCanvasMeasurer(ctx),
    createCanvas: (w, h) => new OffscreenCanvas(w, h),
    nowMs: () => performance.now(),
    Path2D,
    colorMatrix: 'video', // convert BT.601 scripts' colours to the BT.709 video, as players do
    warp: drawWarped,
    limits: { assEventCacheBytes: 16e6, assLayerCacheBytes: 16e6, assMaskCacheBytes: 16e6, maxTextSupersampling: 4 },
    canvasFilter: true, // false on Safari, where ctx.filter is missing
  });
  const frame = { x: 0, y: 0, width: 640, height: 360 }; // where the video sits in the canvas
  const options = { offsetUs: 0, scale: 1 };
  // #endregion

  // #region visible
  console.log('shown at 2 s:', renderer.visible(2_000_000, options), 'at 5 s:', renderer.visible(5_000_000, options));
  // #endregion

  // #region changed
  const needsDraw = renderer.changed(2_000_000, options); // true: nothing was drawn yet
  // #endregion

  // #region render
  const drawn = renderer.render(ctx, 2_000_000, frame, options); // the number of events drawn
  console.log(drawn, 'event drawn; changed since:', renderer.changed(2_000_000, options));
  // #endregion

  // #region stats
  console.log(renderer.stats()); // events shown, animated ones, render time and the count over the 8 ms budget
  // #endregion

  // #region cacheSize
  console.log('static events cached:', renderer.cacheSize());
  // #endregion

  // #region eventsAdded
  // A Matroska track's blocks arrive as they are read: after pushing new events onto the track, tell the renderer.
  renderer.eventsAdded();
  // #endregion

  // #region fontsChanged
  renderer.fontsChanged(); // after adding fonts: layout and bitmap caches start again
  // #endregion

  // #region reset
  renderer.reset(); // a seek or offset change: forget the collision memory
  // #endregion

  let ink = false;
  const pixels = ctx.getImageData(0, 0, 640, 360).data;
  for (let i = 3; i < pixels.length; i += 4) if (pixels[i] !== 0) { ink = true; break; }
  if (!needsDraw || drawn !== 1 || !ink || renderer.visible(5_000_000, options)) throw new Error('the caption was not drawn');
  fonts.dispose();
}
