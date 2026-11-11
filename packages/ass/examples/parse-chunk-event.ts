// SPDX-License-Identifier: LGPL-3.0-or-later
// Turn one Matroska block of an ASS track into an event, given the track's styles.
import { parseAssCodecPrivate, parseChunkEvent } from '@seikou/ass';

const codecPrivate = `[Script Info]
ScriptType: v4.00+
PlayResX: 1280
PlayResY: 720

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Default,Source Sans 3,48,&H00FFFFFF,&H000000FF,&H00000000,&H80000000,0,0,0,0,100,100,0,0,1,2,1,2,30,30,30,1
`;

export default async function example(): Promise<void> {
  const track = parseAssCodecPrivate(codecPrivate);
  // A block holds ReadOrder, Layer, then the fields of the track's event Format after Start and End; its time comes from the block (ms).
  const event = parseChunkEvent(track, '0,0,Default,,0,0,0,,Hello from a block', 5000, 2500);
  console.log(event?.start, event?.duration, event?.text);
  if (!event || event.start !== 5000 || event.duration !== 2500 || event.text !== 'Hello from a block') throw new Error('the block was not parsed');
}
