/*
 * Parses .ass/.ssa scripts into an AssTrack.
 *
 * Ported from libass 0.17.5 (ass.c): set_default_style, string2timecode, read_digits, mystrtou32_modulo,
 * parse_int_header, parse_color_header, parse_bool, parse_ycbcr_matrix, next_token, process_event_tail,
 * set_style_alpha, process_style, format_line_compare, custom_format_line_compatibility, process_styles_line,
 * parse_script_type, process_info_line, event_format_fallback, detect_legacy_conv_subs, process_events_line,
 * decode_chars, decode_font, process_fonts_line, process_line, process_text, parse_memory, ass_lazy_track_init;
 * (ass_utils.c, ass_utils.h): ass_lookup_style, numpad2align. libass is ISC-licensed; see src/engine/NOTICE.
 * Modified for bluray-web, 2026.
 *
 * SPDX-License-Identifier: LGPL-2.1-or-later AND ISC
 */

import { atof, cursor, isSpace, rskipSpaces, skipSpaces, startsWithCase, strcaseeq, strtoll } from './cstr';
import { VALIGN_CENTER, VALIGN_SUB, VALIGN_TOP, YCbCr, type AssEvent, type AssStyle, type AssTrack, type YCbCrMatrix } from './types';

type Mutable<T> = { -readonly [K in keyof T]: T[K] };
type Style = Mutable<AssStyle>;
type Event = Mutable<AssEvent>;

const ASS_STYLE_FORMAT = 'Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding';
const ASS_EVENT_FORMAT = 'Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text';
const SSA_STYLE_FORMAT = 'Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, TertiaryColour, BackColour, Bold, Italic, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, AlphaLevel, Encoding';
const SSA_EVENT_FORMAT = 'Marked, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text';

const SINFO_LANGUAGE = 1 << 0;
const SINFO_PLAYRESX = 1 << 1;
const SINFO_PLAYRESY = 1 << 2;
const SINFO_TIMER = 1 << 3;
const SINFO_WRAPSTYLE = 1 << 4;
const SINFO_SCALEDBORDER = 1 << 5;
const SINFO_COLOURMATRIX = 1 << 6;
const SINFO_KERNING = 1 << 7;
const SINFO_SCRIPTTYPE = 1 << 8;
const SINFO_LAYOUTRESX = 1 << 9;
const SINFO_LAYOUTRESY = 1 << 10;
const GENBY_FFMPEG = 1 << 14;

const enum Section { Unknown, Info, Styles, Events, Fonts }

interface Parser {
  trackType: 'ass' | 'ssa' | 'unknown';
  playResX: number; playResY: number; layoutResX: number; layoutResY: number;
  wrapStyle: number; scaledBorderAndShadow: boolean; kerning: boolean; ycbcrMatrix: YCbCrMatrix; language: string | null;
  styles: Style[]; defaultStyle: number; events: Event[];
  fonts: { name: string; bytes: Uint8Array }[];
  skippedLines: number; eventLines: number;
  state: Section; headerFlags: number;
  styleFormat: string | null; eventFormat: string | null;
  fontName: string | null; fontData: string[];
}

function defaultStyle(): Style {
  return {
    name: 'Default', fontName: 'Arial', fontSize: 18,
    primaryColour: 0xffffff00, secondaryColour: 0x00ffff00, outlineColour: 0x00000000, backColour: 0x00000080,
    bold: 200, italic: 0, underline: 0, strikeOut: 0, scaleX: 1, scaleY: 1, spacing: 0, angle: 0,
    borderStyle: 1, outline: 2, shadow: 3, alignment: 2, marginL: 20, marginR: 20, marginV: 20,
    encoding: 0, treatFontNameAsPattern: 0, blur: 0, justify: 0,
  };
}

function emptyStyle(): Style {
  return {
    name: '', fontName: '', fontSize: 0, primaryColour: 0, secondaryColour: 0, outlineColour: 0, backColour: 0,
    bold: 0, italic: 0, underline: 0, strikeOut: 0, scaleX: 100, scaleY: 100, spacing: 0, angle: 0,
    borderStyle: 0, outline: 0, shadow: 0, alignment: 0, marginL: 0, marginR: 0, marginV: 0,
    encoding: 0, treatFontNameAsPattern: 0, blur: 0, justify: 0,
  };
}

/** string2timecode: sscanf("%d:%d:%d.%d"), centiseconds; 0 for a bad timestamp. */
function timecode(p: string): number {
  const c = cursor(p);
  const parts: number[] = [];
  for (let k = 0; k < 4; k++) {
    if (k > 0) {
      if (p[c.i] !== (k === 3 ? '.' : ':')) break;
      c.i++;
    }
    // %d: leading whitespace, sign, digits (wrapping to int32 like the C)
    let i = c.i;
    while (isSpace(p[i] ?? '')) i++;
    let neg = false;
    if (p[i] === '+' || p[i] === '-') neg = p[i++] === '-';
    const start = i;
    let v = 0;
    while (i < p.length && p[i]! >= '0' && p[i]! <= '9') v = (v * 10 + (p.charCodeAt(i++) - 48)) | 0;
    if (i === start) break;
    c.i = i;
    parts.push(neg ? -v | 0 : v);
  }
  if (parts.length < 4) return 0;
  const [h, m, s, ms] = parts as [number, number, number, number];
  return ((h * 60 + m) * 60 + s) * 1000 + ms * 10;
}

/** mystrtou32_modulo after parse_int_header's &H/0x check: int32 result, wrapping modulo 2^32, 0 for invalid input. */
function parseIntHeader(str: string): number {
  let i = 0;
  let base = 10;
  if (startsWithCase(str, '&h') || startsWithCase(str, '0x')) { i = 2; base = 16; }
  while (str[i] === ' ' || str[i] === '\t') i++;
  let sign = 1;
  if (str[i] === '+') i++;
  else if (str[i] === '-') { sign = -1; i++; }
  if (base === 16 && startsWithCase(str, '0x', i)) i += 2;
  const start = i;
  let val = 0;
  for (; i < str.length; i++) {
    const code = str.charCodeAt(i);
    let d: number;
    if (code >= 48 && code < 48 + Math.min(base, 10)) d = code - 48;
    else if (code >= 97 && code < 97 + base - 10) d = code - 87;
    else if (code >= 65 && code < 65 + base - 10) d = code - 55;
    else break;
    val = (Math.imul(val, base) + d) >>> 0;
  }
  if (i === start) return 0;
  return Math.imul(val, sign) | 0;
}

const bswap32 = (v: number): number => (((v & 0xff) << 24) | ((v & 0xff00) << 8) | ((v >>> 8) & 0xff00) | ((v >>> 24) & 0xff)) >>> 0;
const parseColorHeader = (str: string): number => bswap32(parseIntHeader(str));

function parseBool(str: string): boolean {
  const c = cursor(str);
  skipSpaces(c);
  if (startsWithCase(str, 'yes', c.i)) return true;
  return (strtoll(c, 10) ?? 0) > 0;
}

function parseYCbCrMatrix(str: string): YCbCrMatrix {
  const c = cursor(str);
  skipSpaces(c);
  if (c.i >= str.length) return YCbCr.Default;
  const end = rskipSpaces(str, str.length, c.i);
  const buffer = str.slice(c.i, Math.min(end, c.i + 15)).toLowerCase();
  const table: Record<string, YCbCrMatrix> = {
    none: YCbCr.None, 'tv.601': YCbCr.Bt601Tv, 'pc.601': YCbCr.Bt601Pc, 'tv.709': YCbCr.Bt709Tv, 'pc.709': YCbCr.Bt709Pc,
    'tv.240m': YCbCr.Smpte240mTv, 'pc.240m': YCbCr.Smpte240mPc, 'tv.fcc': YCbCr.FccTv, 'pc.fcc': YCbCr.FccPc,
  };
  return table[buffer] ?? YCbCr.Unknown;
}

/** next_token over a comma-separated string: null at the end; `rtrim` drops trailing blanks. */
function nextToken(c: { s: string; i: number }, rtrim: boolean): string | null {
  skipSpaces(c);
  if (c.i >= c.s.length) return null;
  const start = c.i;
  let end = start;
  while (end < c.s.length && c.s[end] !== ',') end++;
  c.i = end + (c.s[end] === ',' ? 1 : 0);
  if (rtrim) end = rskipSpaces(c.s, end, start);
  return c.s.slice(start, end);
}

/** numpad2align */
function numpad2align(val: number): number {
  if (val < -0x7fffffff) val = 2;
  else if (val < 0) val = -val;
  let res = ((val - 1) % 3) + 1;
  if (val <= 3) res |= VALIGN_SUB;
  else if (val <= 6) res |= VALIGN_CENTER;
  else res |= VALIGN_TOP;
  return res;
}

function lookupStyleIn(styles: readonly AssStyle[], defaultIndex: number, raw: string): number {
  let name = raw.replace(/^\*+/, '');
  if (strcaseeq(name, 'Default')) name = 'Default';
  for (let i = styles.length - 1; i >= 0; i--) if (styles[i]!.name === name) return i;
  return defaultIndex;
}

/** ass_lookup_style */
export function lookupStyle(track: AssTrack, name: string): number {
  return lookupStyleIn(track.styles, track.defaultStyle, name);
}

/** process_event_tail: 0 when the event is complete, 1 when the line ran out before Text. */
function processEventTail(t: Parser, event: Event, str: string): number {
  const p = cursor(str);
  const q = cursor(t.eventFormat!);
  let end = 0;
  for (;;) {
    let tname = nextToken(q, true);
    if (tname === null) break;
    if (strcaseeq(tname, 'Text')) {
      event.text = str.slice(p.i).replace(/[\r\t ]+$/, '');
      event.duration = end - event.start;
      return 0;
    }
    const token = nextToken(p, false);
    if (token === null) break;
    if (strcaseeq(tname, 'End')) tname = 'Duration';
    if (strcaseeq(tname, 'Actor')) tname = 'Name';
    const n = tname.toLowerCase();
    if (n === 'layer') event.layer = parseIntHeader(token);
    else if (n === 'style') event.style = lookupStyleIn(t.styles, t.defaultStyle, token);
    else if (n === 'name') event.name = token;
    else if (n === 'effect') event.effect = token;
    else if (n === 'marginl') event.marginL = parseIntHeader(token);
    else if (n === 'marginr') event.marginR = parseIntHeader(token);
    else if (n === 'marginv') event.marginV = parseIntHeader(token);
    else if (n === 'start') event.start = timecode(token);
    else if (n === 'duration') end = timecode(token);
  }
  return 1;
}

function setStyleAlpha(style: Style, front: number, back: number): void {
  front = Math.max(Math.min(front, 0xff), 0);
  back = Math.max(Math.min(back, 0xff), 0);
  style.primaryColour = ((style.primaryColour & 0xffffff00) | front) >>> 0;
  style.secondaryColour = ((style.secondaryColour & 0xffffff00) | front) >>> 0;
  style.outlineColour = ((style.outlineColour & 0xffffff00) | front) >>> 0;
  style.backColour = ((style.backColour & 0xffffff00) | back) >>> 0;
}

function processStyle(t: Parser, str: string): void {
  if (t.styleFormat === null) t.styleFormat = t.trackType === 'ssa' ? SSA_STYLE_FORMAT : ASS_STYLE_FORMAT;
  const q = cursor(t.styleFormat);
  const p = cursor(str);
  const style = emptyStyle();
  let ssaAlpha = 0;
  for (;;) {
    const tname = nextToken(q, true);
    if (tname === null) break;
    const token = nextToken(p, false);
    if (token === null) break;
    switch (tname.toLowerCase()) {
      case 'name': style.name = token.replace(/^\*+/, ''); break;
      case 'fontname': style.fontName = token; break;
      case 'primarycolour': style.primaryColour = parseColorHeader(token); break;
      case 'secondarycolour': style.secondaryColour = parseColorHeader(token); break;
      case 'outlinecolour': style.outlineColour = parseColorHeader(token); break;
      case 'backcolour':
        style.backColour = parseColorHeader(token);
        if (t.trackType === 'ssa') style.outlineColour = style.backColour;
        break;
      case 'alphalevel': ssaAlpha = parseIntHeader(token); break;
      case 'fontsize': style.fontSize = atof(token); break;
      case 'bold': style.bold = parseIntHeader(token); break;
      case 'italic': style.italic = parseIntHeader(token); break;
      case 'underline': style.underline = parseIntHeader(token); break;
      case 'strikeout': style.strikeOut = parseIntHeader(token); break;
      case 'spacing': style.spacing = atof(token); break;
      case 'angle': style.angle = atof(token); break;
      case 'borderstyle': style.borderStyle = parseIntHeader(token); break;
      case 'alignment':
        style.alignment = parseIntHeader(token);
        if (t.trackType === 'ass') style.alignment = numpad2align(style.alignment);
        else if (style.alignment === 8) style.alignment = 3;
        else if (style.alignment === 4) style.alignment = 11;
        break;
      case 'marginl': style.marginL = parseIntHeader(token); break;
      case 'marginr': style.marginR = parseIntHeader(token); break;
      case 'marginv': style.marginV = parseIntHeader(token); break;
      case 'encoding': style.encoding = parseIntHeader(token); break;
      case 'scalex': style.scaleX = atof(token); break;
      case 'scaley': style.scaleY = atof(token); break;
      case 'outline': style.outline = atof(token); break;
      case 'shadow': style.shadow = atof(token); break;
      default: break;
    }
  }
  if (t.trackType === 'ssa') setStyleAlpha(style, ssaAlpha, 0x80);
  style.scaleX = Math.max(style.scaleX, 0) / 100;
  style.scaleY = Math.max(style.scaleY, 0) / 100;
  style.spacing = Math.max(style.spacing, 0);
  style.outline = Math.max(style.outline, 0);
  style.shadow = Math.max(style.shadow, 0);
  style.bold = style.bold ? 1 : 0;
  style.italic = style.italic ? 1 : 0;
  style.underline = style.underline ? 1 : 0;
  style.strikeOut = style.strikeOut ? 1 : 0;
  if (!style.name) style.name = 'Default';
  if (!style.fontName) style.fontName = 'Arial';
  t.styles.push(style);
  if (style.name === 'Default') t.defaultStyle = t.styles.length - 1;
}

/** format_line_compare: the same fields in the same order, ignoring case and spacing, Actor = Name. */
function formatLineCompare(a: string, b: string): boolean {
  const fields = (s: string): string[] => s.split(',').map((f) => f.replace(/^[ \t]+|[ \t]+$/g, '').toLowerCase()).map((f) => (f === 'actor' ? 'name' : f));
  const fa = fields(a);
  const fb = fields(b);
  // the C walks both until either ends, then requires both to have ended
  const n = Math.min(fa.length, fb.length);
  for (let i = 0; i < n; i++) if (fa[i] !== fb[i]) return false;
  return fa.length === fb.length;
}

function customFormatLineCompatibility(t: Parser, fmt: string, std: string): void {
  if (!(t.headerFlags & SINFO_SCALEDBORDER) && !formatLineCompare(fmt, std)) t.scaledBorderAndShadow = true;
}

function afterPrefix(str: string, prefixLength: number): string {
  const c = cursor(str, prefixLength);
  skipSpaces(c);
  return str.slice(c.i);
}

function processStylesLine(t: Parser, str: string): void {
  if (str.startsWith('Format:')) {
    const p = afterPrefix(str, 7);
    t.styleFormat = p;
    customFormatLineCompatibility(t, p, t.trackType === 'ass' ? ASS_STYLE_FORMAT : SSA_STYLE_FORMAT);
  } else if (str.startsWith('Style:')) {
    processStyle(t, afterPrefix(str, 6));
  }
}

function parseScriptType(t: Parser, str: string): void {
  let p = rskipSpaces(str, str.length, 0);
  let len = p;
  if (len < 4) return;
  let ver: 'ass' | 'ssa' = 'ssa';
  if (str[p - 1] === '+') { ver = 'ass'; len--; p--; }
  if (len >= 4 && str.slice(p - 4, p) === '4.00') t.trackType = ver;
}

function processInfoLine(t: Parser, str: string): void {
  const flag = (f: number): void => { t.headerFlags |= f; };
  if (str.startsWith('PlayResX:')) { flag(SINFO_PLAYRESX); t.playResX = parseIntHeader(str.slice(9)); }
  else if (str.startsWith('PlayResY:')) { flag(SINFO_PLAYRESY); t.playResY = parseIntHeader(str.slice(9)); }
  else if (str.startsWith('LayoutResX:')) { flag(SINFO_LAYOUTRESX); t.layoutResX = parseIntHeader(str.slice(11)); }
  else if (str.startsWith('LayoutResY:')) { flag(SINFO_LAYOUTRESY); t.layoutResY = parseIntHeader(str.slice(11)); }
  else if (str.startsWith('Timer:')) flag(SINFO_TIMER);
  else if (str.startsWith('WrapStyle:')) { flag(SINFO_WRAPSTYLE); t.wrapStyle = parseIntHeader(str.slice(10)); }
  else if (str.startsWith('ScaledBorderAndShadow:')) { flag(SINFO_SCALEDBORDER); t.scaledBorderAndShadow = parseBool(str.slice(22)); }
  else if (str.startsWith('Kerning:')) { flag(SINFO_KERNING); t.kerning = parseBool(str.slice(8)); }
  else if (str.startsWith('YCbCr Matrix:')) { flag(SINFO_COLOURMATRIX); t.ycbcrMatrix = parseYCbCrMatrix(str.slice(13)); }
  else if (str.startsWith('Language:')) {
    flag(SINFO_LANGUAGE);
    let i = 9;
    while (isSpace(str[i] ?? '')) i++;
    t.language = str.slice(i, i + 2);
  } else if (str.startsWith('ScriptType:')) { flag(SINFO_SCRIPTTYPE); parseScriptType(t, str.slice(11)); }
  else if (str.startsWith('; Script generated by ') && str.startsWith('FFmpeg/Lavc', 22)) flag(GENBY_FFMPEG);
}

function eventFormatFallback(t: Parser): void {
  t.state = Section.Events;
  t.eventFormat = t.trackType === 'ssa' ? SSA_EVENT_FORMAT : ASS_EVENT_FORMAT;
}

function detectLegacyConvSubs(t: Parser): boolean {
  if (t.headerFlags !== (SINFO_SCRIPTTYPE | SINFO_PLAYRESX | SINFO_PLAYRESY | GENBY_FFMPEG)) return false;
  return t.styles.length === 2 && t.styles[1]!.name.startsWith('Default');
}

function processEventsLine(t: Parser, str: string): void {
  if (str.startsWith('Format:')) {
    const p = afterPrefix(str, 7);
    t.eventFormat = p;
    customFormatLineCompatibility(t, p, t.trackType === 'ass' ? ASS_EVENT_FORMAT : SSA_EVENT_FORMAT);
    if (detectLegacyConvSubs(t)) t.scaledBorderAndShadow = true;
  } else if (str.startsWith('Dialogue:')) {
    if (t.eventFormat === null) eventFormatFallback(t);
    t.eventLines++;
    const event: Event = { readOrder: 0, layer: 0, start: 0, duration: 0, style: 0, name: '', marginL: 0, marginR: 0, marginV: 0, effect: '', text: '' };
    if (processEventTail(t, event, afterPrefix(str, 9)) === 0) t.events.push(event);
    else t.skippedLines++;
  }
}

/** decode_chars + decode_font: 4 chars → 3 bytes, a 2- or 3-char tail; a tail of 1 char makes the font unreadable. */
function decodeFont(t: Parser): void {
  const data = t.fontData.join('');
  const name = t.fontName!;
  t.fontName = null;
  t.fontData = [];
  if (data.length % 4 === 1) return;
  const out = new Uint8Array(Math.floor(data.length / 4) * 3 + Math.max(data.length % 4, 1) - 1);
  let o = 0;
  for (let i = 0; i < data.length; i += 4) {
    const n = Math.min(4, data.length - i);
    let value = 0;
    for (let k = 0; k < n; k++) value |= ((data.charCodeAt(i + k) - 33) & 63) << (6 * (3 - k));
    out[o++] = (value >>> 16) & 0xff;
    if (n >= 3) out[o++] = (value >>> 8) & 0xff;
    if (n >= 4) out[o++] = value & 0xff;
  }
  t.fonts.push({ name, bytes: out });
}

function processFontsLine(t: Parser, str: string): void {
  if (str.startsWith('fontname:')) {
    if (t.fontName !== null) decodeFont(t);
    t.fontName = afterPrefix(str, 9);
    return;
  }
  if (t.fontName === null) return;
  t.fontData.push(str);
}

function processLine(t: Parser, line: string): void {
  const c = cursor(line);
  skipSpaces(c);
  const str = line.slice(c.i);
  if (startsWithCase(str, '[Script Info]')) t.state = Section.Info;
  else if (startsWithCase(str, '[V4 Styles]')) { t.state = Section.Styles; t.trackType = 'ssa'; }
  else if (startsWithCase(str, '[V4+ Styles]')) { t.state = Section.Styles; t.trackType = 'ass'; }
  else if (startsWithCase(str, '[Events]')) t.state = Section.Events;
  else if (startsWithCase(str, '[Fonts]')) t.state = Section.Fonts;
  else if (t.state === Section.Info) processInfoLine(t, str);
  else if (t.state === Section.Styles) processStylesLine(t, str);
  else if (t.state === Section.Events) processEventsLine(t, str);
  else if (t.state === Section.Fonts) processFontsLine(t, str);
}

/** ass_lazy_track_init */
function lazyTrackInit(t: Parser): void {
  if (t.playResX > 0 && t.playResY > 0) return;
  if (t.playResX <= 0 && t.playResY <= 0) {
    t.playResX = 384;
    t.playResY = 288;
  } else if (t.playResY <= 0 && t.playResX === 1280) t.playResY = 1024;
  else if (t.playResY <= 0) t.playResY = Math.max(1, t.playResX - 1 - Math.floor((t.playResX - 1) / 4));
  else if (t.playResX <= 0 && t.playResY === 1024) t.playResX = 1280;
  else if (t.playResX <= 0) t.playResX = Math.min(t.playResY + Math.floor(t.playResY / 3), 0x7fffffff);
}

/** parse_memory: process_text over the whole script, ReadOrder by file order, then the PlayRes defaults. */
export function parseAss(text: string): AssTrack {
  const t: Parser = {
    trackType: 'unknown', playResX: 0, playResY: 0, layoutResX: 0, layoutResY: 0, wrapStyle: 0,
    scaledBorderAndShadow: false, kerning: false, ycbcrMatrix: YCbCr.Default, language: null,
    styles: [defaultStyle()], defaultStyle: 0, events: [], fonts: [], skippedLines: 0, eventLines: 0,
    state: Section.Unknown, headerFlags: 0, styleFormat: null, eventFormat: null, fontName: null, fontData: [],
  };
  // process_text: lines split at \r and \n, a BOM skipped at each line start
  for (const raw of text.split(/[\r\n]+/)) {
    const line = raw.replace(/^﻿+/, '');
    if (line !== '') processLine(t, line);
  }
  if (t.fontName !== null) decodeFont(t);
  t.events.forEach((e, i) => { e.readOrder = i; });
  lazyTrackInit(t);
  return {
    trackType: t.trackType, playResX: t.playResX, playResY: t.playResY, layoutResX: t.layoutResX, layoutResY: t.layoutResY,
    wrapStyle: t.wrapStyle, scaledBorderAndShadow: t.scaledBorderAndShadow, kerning: t.kerning, ycbcrMatrix: t.ycbcrMatrix,
    language: t.language, styles: t.styles, defaultStyle: t.defaultStyle, events: t.events, fonts: t.fonts,
    skippedLines: t.skippedLines, eventLines: t.eventLines,
  };
}

/** A `[Script Info]`, `[V4+ Styles]` or `[V4 Styles]` section header within the first 4 KiB. */
export function looksLikeAss(text: string): boolean {
  return /^[ \t]*\[(Script Info|V4\+? Styles)\]/im.test(text.slice(0, 4096).replace(/^﻿/, ''));
}
