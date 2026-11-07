/** A fansub script of dialogue lines at given spans, for the alignment tests. */
const HEAD = `[Script Info]
ScriptType: v4.00+

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Default,Arial,20,&H00FFFFFF,&H000000FF,&H00000000,&H00000000,0,0,0,0,100,100,0,0,1,2,2,2,10,10,10,1
Style: Signs,Arial,20,&H00FFFFFF,&H000000FF,&H00000000,&H00000000,0,0,0,0,100,100,0,0,1,2,2,2,10,10,10,1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
`;

function time(ms: number): string {
  const cs = Math.round(ms / 10);
  const p2 = (n: number): string => String(n).padStart(2, '0');
  return `${Math.floor(cs / 360000)}:${p2(Math.floor(cs / 6000) % 60)}:${p2(Math.floor(cs / 100) % 60)}.${p2(cs % 100)}`;
}

/** An ASS script with one event per span, each moved by `shift(span)`. */
export function script(spans: readonly { fromMs: number; toMs: number }[], shift: (fromMs: number) => number = () => 0, style = 'Default'): string {
  return HEAD + spans.map((s, i) => `Dialogue: 0,${time(s.fromMs + shift(s.fromMs))},${time(s.toMs + shift(s.fromMs))},${style},,0,0,0,,Line ${i}\n`).join('');
}

/** Spans at made-up times that have nothing to do with the bursts (a fixed seed). */
export function unrelatedSpans(): { fromMs: number; toMs: number }[] {
  let seed = 7;
  const rnd = (): number => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 2 ** 32; };
  const spans: { fromMs: number; toMs: number }[] = [];
  let at = 500;
  while (spans.length < 32) {
    const len = 1000 + Math.round(rnd() * 150) * 10;
    spans.push({ fromMs: at, toMs: at + len });
    at += len + 500 + Math.round(rnd() * 250) * 10;
  }
  return spans;
}
