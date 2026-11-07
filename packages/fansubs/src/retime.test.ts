import { describe, expect, it } from 'vitest';
import { retime } from './retime';

const HEAD = '[Script Info]\r\nTitle: x, y\r\n\r\n[Events]\r\nFormat: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text\r\n';
const line = (s: string, e: string, text = 'Hi, there'): string => `Dialogue: 0,${s},${e},Default,,0,0,0,,${text}\r\n`;

describe('retime', () => {
  it('offsets start and end and leaves everything else byte-identical', () => {
    const ass = '﻿' + HEAD + 'Comment: 0,0:00:01.00,0:00:02.50,Default,,0,0,0,,note\r\n' + line('0:00:01.00', '0:00:02.50');
    const out = retime(ass, { kind: 'offset', offsetMs: 1500, confidence: 1 });
    expect(out).toBe('﻿' + HEAD + 'Comment: 0,0:00:01.00,0:00:02.50,Default,,0,0,0,,note\r\n' + line('0:00:02.50', '0:00:04.00'));
  });

  it('follows the Format line field order', () => {
    const ass = '[Events]\nFormat: Marked, End, Start, Text\nDialogue: 0, 0:00:02.00,0:00:01.00,a, b\n';
    expect(retime(ass, { kind: 'offset', offsetMs: 1000, confidence: 1 })).toBe('[Events]\nFormat: Marked, End, Start, Text\nDialogue: 0, 0:00:03.00,0:00:02.00,a, b\n');
  });

  it('uses the split part the start falls in', () => {
    const ass = HEAD + line('0:00:10.00', '0:00:11.00') + line('0:01:05.00', '0:01:06.00');
    const out = retime(ass, { kind: 'split', confidence: 1, parts: [{ fromMs: 0, offsetMs: 0 }, { fromMs: 60_000, offsetMs: -2000 }] });
    expect(out).toBe(HEAD + line('0:00:10.00', '0:00:11.00') + line('0:01:03.00', '0:01:04.00'));
  });

  it('clamps at zero', () => {
    const out = retime(HEAD + line('0:00:01.00', '0:00:03.00'), { kind: 'offset', offsetMs: -2000, confidence: 1 });
    expect(out).toBe(HEAD + line('0:00:00.00', '0:00:01.00'));
  });

  it('returns none and original unchanged', () => {
    const ass = HEAD + line('0:00:01.00', '0:00:03.00');
    expect(retime(ass, { kind: 'none', reason: 'no-speech' })).toBe(ass);
    expect(retime(ass, { kind: 'original' })).toBe(ass);
  });
});
