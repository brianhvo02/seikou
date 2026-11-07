// SPDX-License-Identifier: LGPL-3.0-or-later
/**
 * Turns a user's SRT file into an ASS script, so everything after it handles ASS only.
 *
 * SRT has no formal specification. This reads what players read in practice: an optional
 * cue number, a `start --> end` line with `hh:mm:ss,mmm` times (a `.` for the comma is
 * accepted), then text lines up to a blank line. The output uses the ASS override tags
 * described in Aegisub's "ASS Tags" reference (`\i`, `\b`, `\u`, and `\N` for a line break).
 */

/** Thrown when a subtitle file's bytes are neither UTF-8 nor UTF-16 with a byte order mark. */
export class SubtitleEncodingError extends Error {
  constructor() {
    super('not UTF-8 or UTF-16; save the file as UTF-8');
    this.name = 'SubtitleEncodingError';
  }
}

/**
 * Decodes subtitle file bytes to text: UTF-8 (a BOM is dropped) or UTF-16 LE/BE chosen by
 * its BOM. Anything else must be valid UTF-8; legacy encodings such as Shift-JIS are
 * refused with a `SubtitleEncodingError` rather than guessed at.
 */
export function decodeSubtitleText(bytes: Uint8Array): string {
  if (bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xfe) {
    return new TextDecoder('utf-16le').decode(bytes.subarray(2));
  }
  if (bytes.length >= 2 && bytes[0] === 0xfe && bytes[1] === 0xff) {
    return new TextDecoder('utf-16be').decode(bytes.subarray(2));
  }
  const body = bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf ? bytes.subarray(3) : bytes;
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(body);
  } catch {
    throw new SubtitleEncodingError();
  }
}

const TIME = /(\d{1,2}):(\d{2}):(\d{2})[,.](\d{1,3})/;
const CUE_LINE = new RegExp(`^\\s*${TIME.source}\\s*-->\\s*${TIME.source}`);

/** Milliseconds from the parts of an SRT time; a short fraction is a fraction of a second ("5" is 500 ms). */
function ms(h: string, m: string, s: string, frac: string): number {
  return ((Number(h) * 60 + Number(m)) * 60 + Number(s)) * 1000 + Number(frac.padEnd(3, '0'));
}

/** An ASS time, `h:mm:ss.cc`; milliseconds are truncated to centiseconds, the finest ASS holds. */
function assTime(totalMs: number): string {
  const cs = Math.floor(totalMs / 10);
  const c = cs % 100;
  const s = Math.floor(cs / 100) % 60;
  const m = Math.floor(cs / 6000) % 60;
  const h = Math.floor(cs / 360000);
  return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}.${String(c).padStart(2, '0')}`;
}

/**
 * One cue's text lines as ASS text. Brace blocks in the SRT (such as `{\an8}`, which some
 * files carry) are dropped first, since ASS would read them as overrides; then `<i>`, `<b>`
 * and `<u>` become ASS tags and every other tag is removed.
 */
function assText(lines: readonly string[]): string {
  return lines
    .join('\\N')
    .replace(/\{[^}]*\}/g, '')
    .replace(/[{}]/g, '')
    .replace(/<\s*([ibu])\s*>/gi, (_, t: string) => `{\\${t.toLowerCase()}1}`)
    .replace(/<\s*\/\s*([ibu])\s*>/gi, (_, t: string) => `{\\${t.toLowerCase()}0}`)
    .replace(/<\/?[a-z][^>]*>/gi, '');
}

/**
 * Converts SRT text to a complete ASS script: 1920x1080 play resolution and one `Default`
 * style in Arial (a missing font then falls back as players fall back for SRT), with one
 * `Dialogue` event per cue. Cues with no parseable time line are skipped.
 */
export function srtToAss(text: string): string {
  const blocks = text.replace(/^﻿/, '').replace(/\r\n?/g, '\n').split(/\n{2,}/);
  const events: string[] = [];
  for (const block of blocks) {
    const lines = block.split('\n');
    const at = lines.findIndex((l) => CUE_LINE.test(l));
    if (at < 0) continue;
    const m = CUE_LINE.exec(lines[at]!)!;
    const start = ms(m[1]!, m[2]!, m[3]!, m[4]!);
    const end = ms(m[5]!, m[6]!, m[7]!, m[8]!);
    const body = assText(lines.slice(at + 1).filter((l) => l.trim() !== ''));
    events.push(`Dialogue: 0,${assTime(start)},${assTime(end)},Default,,0,0,0,,${body}`);
  }
  return [
    '[Script Info]',
    'ScriptType: v4.00+',
    'PlayResX: 1920',
    'PlayResY: 1080',
    'WrapStyle: 0',
    'ScaledBorderAndShadow: yes',
    '',
    '[V4+ Styles]',
    'Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding',
    'Style: Default,Arial,64,&H00FFFFFF,&H000000FF,&H00000000,&H80000000,0,0,0,0,100,100,0,0,1,3,1,2,60,60,50,1',
    '',
    '[Events]',
    'Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text',
    ...events,
    '',
  ].join('\n');
}
