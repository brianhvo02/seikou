// SPDX-License-Identifier: LGPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import { SubtitleEncodingError, decodeSubtitleText, srtToAss } from '../../src/subs/srt-to-ass';

describe('srtToAss', () => {
  it('converts cues with italics and line breaks', () => {
    const ass = srtToAss('1\n00:00:01,500 --> 00:00:03,000\n<i>Hello</i>\nthere\n');
    expect(ass).toContain('Dialogue: 0,0:00:01.50,0:00:03.00,Default,,0,0,0,,{\\i1}Hello{\\i0}\\Nthere');
    expect(ass).toContain('PlayResX: 1920');
    expect(ass).toContain('PlayResY: 1080');
    expect(ass).toContain('Style: Default,Arial');
  });

  it('handles bold, underline, other tags, CRLF and several cues', () => {
    const ass = srtToAss(
      '1\r\n00:00:01,000 --> 00:00:02,000\r\n<b>a</b> <u>b</u> <font color="red">c</font>\r\n\r\n2\r\n01:02:03,456 --> 01:02:04,000\r\nd\r\n',
    );
    expect(ass).toContain(',,{\\b1}a{\\b0} {\\u1}b{\\u0} c\n');
    expect(ass).toContain('Dialogue: 0,1:02:03.45,1:02:04.00,Default,,0,0,0,,d');
  });

  it('does not let literal braces become override blocks', () => {
    const ass = srtToAss('1\n00:00:01,000 --> 00:00:02,000\n{\\an8}d\n');
    expect(ass).not.toContain('{\\an8}');
    expect(ass).toContain(',,d');
  });

  it('splits cues at a separator line holding only spaces or tabs', () => {
    const ass = srtToAss('1\n00:00:01,000 --> 00:00:02,000\nA\n \n2\n00:00:03,000 --> 00:00:04,000\nB\n\t\n');
    const dialogue = ass.split('\n').filter((l) => l.startsWith('Dialogue:'));
    expect(dialogue).toEqual([
      'Dialogue: 0,0:00:01.00,0:00:02.00,Default,,0,0,0,,A',
      'Dialogue: 0,0:00:03.00,0:00:04.00,Default,,0,0,0,,B',
    ]);
  });
});

describe('decodeSubtitleText', () => {
  it('strips a UTF-8 BOM', () => {
    expect(decodeSubtitleText(new Uint8Array([0xef, 0xbb, 0xbf, 0x61]))).toBe('a');
  });

  it('decodes UTF-16 LE with BOM', () => {
    expect(decodeSubtitleText(new Uint8Array([0xff, 0xfe, 0x61, 0x00, 0x42, 0x30]))).toBe('aあ');
  });

  it('decodes UTF-16 BE with BOM', () => {
    expect(decodeSubtitleText(new Uint8Array([0xfe, 0xff, 0x00, 0x61]))).toBe('a');
  });

  it('rejects Shift-JIS bytes with SubtitleEncodingError', () => {
    const sjis = new Uint8Array([0x82, 0xa0, 0x82, 0xa2]);
    expect(() => decodeSubtitleText(sjis)).toThrow(SubtitleEncodingError);
    expect(() => decodeSubtitleText(sjis)).toThrow(/save the file as UTF-8/);
  });
});
