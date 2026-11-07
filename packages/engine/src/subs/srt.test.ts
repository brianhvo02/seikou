import { describe, expect, it } from 'vitest';
import { activeCues, decodeText, parseSrt, type TextCue } from './srt';

const PLAIN = `1
00:00:01,000 --> 00:00:02,500
Hello

2
00:00:03,250 --> 00:00:04,000
Two
lines

3
00:01:00.007 --> 01:00:00,000
Last`;

const texts = (c: TextCue): string[] => c.lines.map((runs) => runs.map((r) => r.text).join(''));

describe('parseSrt', () => {
  it('parses cues with exact microsecond times', () => {
    const { cues, skipped, blocks } = parseSrt(PLAIN);
    expect(blocks).toBe(3);
    expect(skipped).toBe(0);
    expect(cues.map((c) => [c.startUs, c.endUs])).toEqual([[1_000_000, 2_500_000], [3_250_000, 4_000_000], [60_007_000, 3_600_000_000]]);
    expect(cues.map(texts)).toEqual([['Hello'], ['Two', 'lines'], ['Last']]);
    expect(cues[0]!.align).toBe(2);
    expect(cues[0]!.lines[0]).toEqual([{ text: 'Hello', italic: false, bold: false, underline: false, color: null }]);
  });

  it('is not affected by CRLF, a missing final blank line, numbering gaps or a missing number', () => {
    const crlf = PLAIN.replace(/\n/g, '\r\n').replace('\r\n2\r\n', '\r\n17\r\n').replace('3\r\n00:01', '00:01');
    expect(parseSrt(crlf).cues).toEqual(parseSrt(PLAIN + '\n\n').cues);
  });

  it('accepts hours past 99 and sorts cues by start', () => {
    const { cues } = parseSrt('1\n123:00:00,000 --> 123:00:01,000\nlate\n\n2\n00:00:01,000 --> 00:00:02,000\nearly');
    expect(cues.map(texts)).toEqual([['early'], ['late']]);
    expect(cues[1]!.startUs).toBe(123 * 3600 * 1_000_000);
  });

  it('styles runs: nested italic and bold, font colours, underline, alignment, entities', () => {
    const { cues } = parseSrt('1\n00:00:01,000 --> 00:00:02,000\n{\\an8}<i>a<b>x</b></i> <font color="#FF0000">red</font> <u>u</u> &lt;b&gt; &amp;');
    const [line] = cues[0]!.lines;
    expect(cues[0]!.align).toBe(8);
    expect(line).toEqual([
      { text: 'a', italic: true, bold: false, underline: false, color: null },
      { text: 'x', italic: true, bold: true, underline: false, color: null },
      { text: ' ', italic: false, bold: false, underline: false, color: null },
      { text: 'red', italic: false, bold: false, underline: false, color: '#ff0000' },
      { text: ' ', italic: false, bold: false, underline: false, color: null },
      { text: 'u', italic: false, bold: false, underline: true, color: null },
      { text: ' <b> &', italic: false, bold: false, underline: false, color: null },
    ]);
  });

  it('accepts colour names, keeps the last alignment, removes override blocks and keeps unknown tags as text', () => {
    const { cues } = parseSrt("1\n00:00:01,000 --> 00:00:02,000\n{\\an1}<font color='yellow'>y</font>{\\an9}{\\pos(10,20)}<span>s</span> <3");
    expect(cues[0]!.align).toBe(9);
    expect(cues[0]!.lines[0]![0]).toMatchObject({ text: 'y', color: 'yellow' });
    expect(texts(cues[0]!)).toEqual(['y<span>s</span> <3']);
  });

  it('ignores a font colour that is no CSS hex colour', () => {
    const { cues } = parseSrt('1\n00:00:01,000 --> 00:00:02,000\n<font color="#ff00f">a</font><font color="#ABC">b</font>');
    expect(cues[0]!.lines[0]!.map((r) => r.color)).toEqual([null, '#abc']);
  });

  it('skips and counts a block with a malformed time line and a cue that ends before it starts', () => {
    const { cues, skipped, blocks } = parseSrt('1\n00:00:01,000 -> 00:00:02,000\nbad\n\n2\n00:00:05,000 --> 00:00:04,000\nbackwards\n\n3\n00:00:06,000 --> 00:00:07,000\ngood');
    expect(blocks).toBe(3);
    expect(skipped).toBe(2);
    expect(cues.map(texts)).toEqual([['good']]);
  });
});

describe('decodeText', () => {
  const enc = (s: string) => new TextEncoder().encode(s);
  it('honours BOMs and strict UTF-8', () => {
    expect(decodeText(Uint8Array.of(0xef, 0xbb, 0xbf, ...enc('é1')))).toEqual({ text: 'é1' });
    expect(decodeText(Uint8Array.of(0xff, 0xfe, 0xe9, 0x00, 0x31, 0x00))).toEqual({ text: 'é1' });
    expect(decodeText(Uint8Array.of(0xfe, 0xff, 0x00, 0xe9, 0x00, 0x31))).toEqual({ text: 'é1' });
    expect(decodeText(enc('plain é'))).toEqual({ text: 'plain é' });
  });

  it('asks for an encoding when the bytes are not UTF-8, and uses the one given', () => {
    const latin = Uint8Array.of(0x63, 0x61, 0x66, 0xe9); // "café" in windows-1252
    expect(decodeText(latin)).toEqual({ needsEncoding: true });
    expect(decodeText(latin, 'windows-1252')).toEqual({ text: 'café' });
    expect(decodeText(Uint8Array.of(0x93, 0xfa, 0x96, 0x7b), 'shift_jis')).toEqual({ text: '日本' });
    expect(decodeText(latin, 'no-such-encoding')).toEqual({ needsEncoding: true });
  });
});

describe('activeCues', () => {
  it('returns overlapping cues together, in start order', () => {
    const { cues } = parseSrt('1\n00:00:01,000 --> 00:00:05,000\nlong\n\n2\n00:00:02,000 --> 00:00:03,000\nshort');
    expect(activeCues(cues, 2_500_000).map(texts)).toEqual([['long'], ['short']]);
    expect(activeCues(cues, 3_000_000).map(texts)).toEqual([['long']]); // the end is exclusive
    expect(activeCues(cues, 999_999)).toEqual([]);
    expect(activeCues(cues, 5_000_000)).toEqual([]);
  });

  it('agrees with a brute-force search on random overlapping cues', () => {
    let seed = 7;
    const rand = (n: number): number => {
      seed = (seed * 1_103_515_245 + 12_345) % 2_147_483_648;
      return seed % n;
    };
    const cues: TextCue[] = Array.from({ length: 400 }, () => {
      const startUs = rand(600) * 100_000;
      return { startUs, endUs: startUs + (1 + rand(rand(10) === 0 ? 3000 : 50)) * 100_000, lines: [], align: 2 as const };
    }).sort((a, b) => a.startUs - b.startUs);
    for (let t = 0; t < 400_000_000; t += 1_234_567) {
      expect(activeCues(cues, t)).toEqual(cues.filter((c) => c.startUs <= t && t < c.endUs));
    }
  });

  it('stays fast when one cue lasts the whole film', () => {
    const cues: TextCue[] = [
      { startUs: 0, endUs: 30 * 3600 * 1_000_000, lines: [], align: 8 }, // "Subtitles by …" with a typo'd end hour
      ...Array.from({ length: 50_000 }, (_, i): TextCue => ({ startUs: 1 + i * 2_000_000, endUs: 1 + i * 2_000_000 + 1_500_000, lines: [], align: 2 })),
    ];
    expect(activeCues(cues, 2_000_000 * 31_337 + 100_000)).toEqual([cues[0], cues[31_338]]);
    const t0 = performance.now();
    for (let i = 0; i < 10_000; i++) activeCues(cues, ((i * 7919) % 100_000) * 1_000_000);
    expect(performance.now() - t0).toBeLessThan(50);
  });

  it('finds the right cue among 50 000 quickly', () => {
    const blocks = Array.from({ length: 50_000 }, (_, i) => {
      const t = (ms: number) => `${String(Math.floor(ms / 3_600_000)).padStart(2, '0')}:${String(Math.floor(ms / 60_000) % 60).padStart(2, '0')}:${String(Math.floor(ms / 1000) % 60).padStart(2, '0')},${String(ms % 1000).padStart(3, '0')}`;
      return `${i + 1}\n${t(i * 2000)} --> ${t(i * 2000 + 1500)}\ncue ${i}`;
    });
    const { cues } = parseSrt(blocks.join('\n\n'));
    expect(cues).toHaveLength(50_000);
    expect(activeCues(cues, 2000 * 31_337 * 1000 + 100_000).map(texts)).toEqual([['cue 31337']]);
    const t0 = performance.now();
    for (let i = 0; i < 10_000; i++) activeCues(cues, ((i * 7919) % 100_000) * 1_000_000);
    expect(performance.now() - t0).toBeLessThan(50);
  });
});
