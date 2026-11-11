// SPDX-License-Identifier: LGPL-3.0-or-later
// Read a Matroska ASS track's CodecPrivate, which holds the script up to its events.
import { parseAssCodecPrivate } from '@seikou/ass';

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
  console.log(track.styles.map((s) => `${s.name}: ${s.fontName}`), 'event format:', track.eventFormat);
  if (!track.styles.some((s) => s.fontName === 'Source Sans 3') || track.events.length !== 0 || !track.eventFormat) throw new Error('the CodecPrivate was not read');
}
