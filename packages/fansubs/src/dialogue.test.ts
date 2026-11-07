import { describe, expect, it } from 'vitest';
import { dialogueIntervals } from './dialogue';

const HEAD = `[Script Info]
ScriptType: v4.00+

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Default,Arial,20,&H00FFFFFF,&H000000FF,&H00000000,&H00000000,0,0,0,0,100,100,0,0,1,2,2,2,10,10,10,1
Style: Signs,Arial,20,&H00FFFFFF,&H000000FF,&H00000000,&H00000000,0,0,0,0,100,100,0,0,1,2,2,2,10,10,10,1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
`;
const d = (s: string, e: string, style: string, text: string, kind = 'Dialogue'): string => `${kind}: 0,${s},${e},${style},,0,0,0,,${text}\n`;

describe('dialogueIntervals', () => {
  it('drops signs, positioned, karaoke, long and commented events; keeps and merges dialogue', () => {
    const ass = HEAD
      + d('0:00:01.00', '0:00:02.00', 'Signs', 'Shop')
      + d('0:00:03.00', '0:00:04.00', 'Default', '{\\pos(10,10)}Over there')
      + d('0:00:05.00', '0:00:06.00', 'Default', '{\\k20}ka{\\kf20}ra')
      + d('0:00:10.00', '0:00:22.00', 'Default', 'Too long')
      + d('0:00:30.00', '0:00:31.00', 'Default', 'Commented', 'Comment')
      + d('0:01:00.00', '0:01:02.00', 'Default', 'Hello, there, friend')
      + d('0:01:01.50', '0:01:04.00', 'Default', 'Overlap')
      + d('0:02:00.00', '0:02:01.00', 'Default', 'Second');
    expect(dialogueIntervals(ass)).toEqual([
      { fromMs: 60_000, toMs: 64_000 },
      { fromMs: 120_000, toMs: 121_000 },
    ]);
  });

  it('drops events shorter than 300 ms', () => {
    expect(dialogueIntervals(HEAD + d('0:00:01.00', '0:00:01.20', 'Default', 'Hm'))).toEqual([]);
  });

  it('drops \\ko, \\K and drawing events', () => {
    const ass = HEAD
      + d('0:00:01.00', '0:00:02.00', 'Default', '{\\ko20}a{\\K20}b')
      + d('0:00:03.00', '0:00:04.00', 'Default', '{\\p1}m 0 0 l 10 10{\\p0}');
    expect(dialogueIntervals(ass)).toEqual([]);
  });

  it('judges styles by whole words, not substrings', () => {
    const keep = ['Default', 'Main', 'Italics', 'Italicized', 'Speed', 'Whispered', 'Shouted', 'Narrated', 'Alternate', 'Flashback', 'Overlap', 'Top'];
    const drop = ['Sign', 'Signs', 'OP', 'ED2', 'TL Note', 'Kara', 'Karaoke', 'Insert Song', 'OP Romaji', 'Ending', 'SongLyrics', 'Title'];
    const lines = (names: string[]): string => names.map((n, i) => d(`0:00:${String(i * 12).padStart(2, '0')}.00`, `0:00:${String(i * 12 + 2).padStart(2, '0')}.00`, n, 'Text')).join('');
    const styles = (names: string[]): string => names.map((n) => `Style: ${n},Arial,20,&H00FFFFFF,&H000000FF,&H00000000,&H00000000,0,0,0,0,100,100,0,0,1,2,2,2,10,10,10,1\n`).join('');
    const withStyles = (names: string[]): string => HEAD.replace('\n[Events]', styles(names) + '\n[Events]') + lines(names);
    expect(dialogueIntervals(withStyles(keep))).toHaveLength(keep.length);
    expect(dialogueIntervals(withStyles(drop))).toEqual([]);
  });
});
