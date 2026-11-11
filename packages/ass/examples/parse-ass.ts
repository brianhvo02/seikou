// SPDX-License-Identifier: LGPL-3.0-or-later
// Parse a short ASS script into its styles and timed events.
import { parseAss } from '@seikou/ass';

const script = `[Script Info]
ScriptType: v4.00+
PlayResX: 1920
PlayResY: 1080

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Default,Source Sans 3,64,&H00FFFFFF,&H000000FF,&H00000000,&H80000000,0,0,0,0,100,100,0,0,1,3,2,2,40,40,50,1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
Dialogue: 0,0:00:01.00,0:00:03.00,Default,,0,0,0,,Hello world
Dialogue: 0,0:00:02.00,0:00:04.00,Default,,0,0,0,,{\\an8\\b1}Top bold
`;

export default async function example(): Promise<void> {
  const track = parseAss(script);
  console.log(track.playResX, 'x', track.playResY, track.styles.map((s) => s.name), track.events.map((e) => [e.start, e.duration, e.text]));
  const first = track.events[0]!;
  if (track.events.length !== 2 || first.start !== 1000 || first.duration !== 2000 || first.text !== 'Hello world') throw new Error('the script was not parsed');
}
