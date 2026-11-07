import { describe, expect, it } from 'vitest';
import { looksLikeAss, lookupStyle, parseAss } from './parse';

const HEADER = `[Script Info]
ScriptType: v4.00+
PlayResX: 1280
PlayResY: 720
WrapStyle: 2
ScaledBorderAndShadow: yes
YCbCr Matrix: TV.709

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Default,Arial,48,&H00FFFFFF,&H000000FF,&H00000000,&H80000000,-1,0,0,0,100,110,0,0,1,2.5,1,2,10,20,30,1
`;
const EVENTS = (...lines: string[]): string => `\n[Events]\nFormat: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text\n${lines.join('\n')}\n`;

/** The [Fonts] encoding (decode_chars): 6 bits per char, offset 33, 80-char lines. */
function uuencodeLikeAss(bytes: Uint8Array): string {
  let out = '';
  for (let i = 0; i < bytes.length; i += 3) {
    const n = (bytes[i]! << 16) | ((bytes[i + 1] ?? 0) << 8) | (bytes[i + 2] ?? 0);
    const chars = [18, 12, 6, 0].map((s) => String.fromCharCode(((n >> s) & 63) + 33));
    out += chars.slice(0, Math.min(4, bytes.length - i + 1)).join('');
  }
  return out.match(/.{1,80}/g)!.join('\n');
}

describe('parseAss', () => {
  it('reads script info, styles and events as libass does', () => {
    const t = parseAss(HEADER + EVENTS('Dialogue: 1,0:00:01.50,0:00:03.00,Default,Bob,0,0,0,,Hello, {\\b1}world  '));
    expect([t.trackType, t.playResX, t.playResY, t.wrapStyle, t.scaledBorderAndShadow, t.ycbcrMatrix]).toEqual(['ass', 1280, 720, 2, true, 5]);
    const s = t.styles[lookupStyle(t, 'Default')]!;
    expect([s.fontName, s.fontSize, s.primaryColour, s.backColour, s.bold, s.scaleY, s.outline]).toEqual(['Arial', 48, 0xffffff00, 0x00000080, 1, 1.1, 2.5]);
    expect(t.events).toEqual([{ readOrder: 0, layer: 1, start: 1500, duration: 1500, style: lookupStyle(t, 'Default'), name: 'Bob', marginL: 0, marginR: 0, marginV: 0, effect: '', text: 'Hello, {\\b1}world' }]);
  });

  it('defaults PlayRes like libass when it is missing (384×288, or derived from the one given)', () => {
    const none = parseAss('[Script Info]\nScriptType: v4.00+\n');
    expect([none.playResX, none.playResY]).toEqual([384, 288]);
    expect(parseAss('[Script Info]\nScriptType: v4.00+\nPlayResY: 720\n').playResX).toBe(960);
    expect(parseAss('[Script Info]\nScriptType: v4.00+\nPlayResX: 1280\n').playResY).toBe(1024);
    expect(parseAss('[Script Info]\nScriptType: v4.00+\nPlayResX: 1920\n').playResY).toBe(1440);
  });

  it('honours a reordered Format line; an event without a Style field gets the built-in style 0', () => {
    const t = parseAss(HEADER + '\n[Events]\nFormat: Start, End, Text\nDialogue: 0:00:00.00,0:00:01.00,a,b\n');
    expect(t.events[0]!.text).toBe('a,b');
    expect(t.events[0]!.style).toBe(0);
    expect(t.styles[0]!.fontName).toBe('Arial');
  });

  it('falls back to the Default style for an unknown style name', () => {
    const t = parseAss(HEADER + EVENTS('Dialogue: 0,0:00:00.00,0:00:01.00,Nope,,0,0,0,,x'));
    expect(t.events[0]!.style).toBe(t.defaultStyle);
    expect(t.defaultStyle).toBe(1);
  });

  it('stores alignment in legacy numbering: numpad2align for ASS, SSA kept with VSFilter fixes', () => {
    expect(parseAss(HEADER).styles.at(-1)!.alignment).toBe(2);
    expect(parseAss(HEADER.replace(',1,2.5,1,2,10,', ',1,2.5,1,8,10,')).styles.at(-1)!.alignment).toBe(6);
    const ssa = '[Script Info]\nScriptType: v4.00\n\n[V4 Styles]\nFormat: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, TertiaryColour, BackColour, Bold, Italic, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, AlphaLevel, Encoding\nStyle: S,Arial,20,16777215,255,0,0,0,0,1,2,0,6,10,10,10,0,0\nStyle: T,Arial,20,16777215,255,0,0,0,0,1,2,0,8,10,10,10,0,0\n';
    const t = parseAss(ssa);
    expect(t.trackType).toBe('ssa');
    expect(t.styles.slice(1).map((s) => s.alignment)).toEqual([6, 3]);
    expect(t.styles[1]!.backColour & 0xff).toBe(0x80); // VSFilter: SSA back alpha is always 0x80
  });

  it('decodes uuencoded [Fonts] entries, several in a row', () => {
    const a = new Uint8Array([0, 1, 2, 3, 254, 255]);
    const b = new Uint8Array([9, 8, 7, 6]);
    const t = parseAss(HEADER + '\n[Fonts]\nfontname: a.ttf\n' + uuencodeLikeAss(a) + '\nfontname: b_0.ttf\n' + uuencodeLikeAss(b) + '\n' + EVENTS());
    expect(t.fonts.map((f) => [f.name, [...f.bytes]])).toEqual([['a.ttf', [...a]], ['b_0.ttf', [...b]]]);
  });

  it('counts malformed lines and skips comments and other event types', () => {
    const t = parseAss(HEADER + EVENTS('Dialogue: garbage', 'Comment: 0,0:00:00.00,0:00:01.00,Default,,0,0,0,,c', '; note', 'Picture: x', 'Dialogue: 0,0:00:00.00,0:00:01.00,Default,,0,0,0,,ok'));
    expect(t.events.map((e) => e.text)).toEqual(['ok']);
    expect([t.eventLines, t.skippedLines]).toEqual([2, 1]);
  });

  it('reads times as libass does: centiseconds, and 0 for a bad timestamp', () => {
    const t = parseAss(HEADER + EVENTS('Dialogue: 0,1:02:03.4,1:02:04.45,Default,,0,0,0,,a', 'Dialogue: 0,bad,0:00:01.00,Default,,0,0,0,,b'));
    expect(t.events.map((e) => [e.start, e.duration])).toEqual([[3_723_040, 1_410], [0, 1000]]);
  });

  it('defaults SBAS to yes for custom format lines unless the header sets it', () => {
    const custom = '[Script Info]\nScriptType: v4.00+\n\n[Events]\nFormat: Start, End, Text\n';
    expect(parseAss(custom).scaledBorderAndShadow).toBe(true);
    expect(parseAss(custom.replace('[Events]', 'ScaledBorderAndShadow: no\n\n[Events]')).scaledBorderAndShadow).toBe(false);
    expect(parseAss(HEADER.replace('ScaledBorderAndShadow: yes\n', '') + EVENTS()).scaledBorderAndShadow).toBe(false);
  });

  it('marks a file with no recognised script type as unknown', () => {
    expect(parseAss('hello\nworld\n').trackType).toBe('unknown');
  });

  it('parses 50 000 events in well under 2 s', () => {
    const lines = Array.from({ length: 50_000 }, (_, i) => `Dialogue: 0,0:${String(Math.floor(i / 60) % 60).padStart(2, '0')}:00.00,9:00:00.00,Default,,0,0,0,,line ${i}`);
    const t0 = performance.now();
    expect(parseAss(HEADER + EVENTS(...lines)).events).toHaveLength(50_000);
    expect(performance.now() - t0).toBeLessThan(2000);
  });
});

describe('looksLikeAss', () => {
  it('finds the section headers after a BOM and blank lines, not SRT', () => {
    expect(looksLikeAss('﻿\n\n[Script Info]\n')).toBe(true);
    expect(looksLikeAss('[V4+ Styles]\n')).toBe(true);
    expect(looksLikeAss('1\n00:00:01,000 --> 00:00:02,000\nHi\n')).toBe(false);
    expect(looksLikeAss('x'.repeat(5000) + '\n[Script Info]\n')).toBe(false);
  });
});
