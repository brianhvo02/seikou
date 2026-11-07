/*
 * Override tags: ass_parse_tags over a {…} block, animated by \t, at a time inside the event, with libass's
 * argument splitting, VSFilter quirks and C integer conversions; and the text escapes of ass_get_next_char.
 *
 * Ported from libass 0.17.5 (ass_parse.c): argtoi32, argtod, push_arg, mystrcmp, dtoi32, calc_anim,
 * calc_anim_int32, change_color, change_alpha, mult_alpha, ass_apply_fade, interpolate_alpha, parse_vector_clip,
 * parse_alpha_tag, parse_color_tag, lookup_style_strict, ass_parse_tags, ass_get_next_char,
 * ass_event_has_hard_overrides (in state.ts). libass is ISC-licensed; see src/engine/NOTICE.
 * Modified for bluray-web, 2026.
 *
 * SPDX-License-Identifier: LGPL-2.1-or-later AND ISC
 */

import { assStrtod, cursor, mystrtoi32, rskipSpaces, skipSpaces } from './cstr';
import {
  DECO_STRIKETHROUGH, DECO_UNDERLINE, EF_KARAOKE, EF_KARAOKE_KF, EF_KARAOKE_KO, EVENT_POSITIONED, PARSED_A, PARSED_FADE,
  resetRenderState, updateFont, type RenderState,
} from './state';
import { VALIGN_CENTER, VALIGN_SUB, VALIGN_TOP, type AssStyle } from './types';

export { hasHardOverrides } from './state';

const MAX_VALID_NARGS = 7;
const MAX_BE = 127;
const BLUR_MAX_RADIUS = 100;
const NBSP = 0xa0;
const INT32_MIN = -0x80000000;

/** [start, end) of an argument inside the string being parsed. */
interface Arg { start: number; end: number }

const i32 = (v: number): number => v | 0;
const u32 = (v: number): number => v >>> 0;
const alphaOf = (c: number): number => c & 0xff;
const bswap32 = (v: number): number => (((v & 0xff) << 24) | ((v & 0xff00) << 8) | ((v >>> 8) & 0xff00) | ((v >>> 24) & 0xff)) >>> 0;

/** double → int32 as x86 does: out of range (or NaN) is INT32_MIN. */
function dtoi32(v: number): number {
  if (Number.isNaN(v) || v <= INT32_MIN || v >= 0x80000000) return INT32_MIN;
  return Math.trunc(v);
}

/** A C (int) assignment of a double that stays in range in practice. */
const toInt = (v: number): number => dtoi32(v);

const calcAnim = (n: number, old: number, pwr: number): number => (1 - pwr) * old + n * pwr;
const calcAnimInt32 = (n: number, old: number, pwr: number): number => dtoi32(calcAnim(u32(n), u32(old), pwr));

/** change_color: c1·(1−pwr) + c2·pwr per colour channel, alpha kept. */
function changeColor(c: number, n: number, pwr: number): number {
  const co = bswap32(c);
  const cn = bswap32(n);
  const cc = (calcAnimInt32(cn & 0xff0000, co & 0xff0000, pwr) & 0xff0000)
    | (calcAnimInt32(cn & 0x00ff00, co & 0x00ff00, pwr) & 0x00ff00)
    | (calcAnimInt32(cn & 0x0000ff, co & 0x0000ff, pwr) & 0x0000ff);
  return (bswap32(cc & 0xffffff) | alphaOf(c)) >>> 0;
}

/** change_alpha */
const changeAlpha = (c: number, n: number, pwr: number): number => ((c & 0xffffff00) | (calcAnimInt32(n, alphaOf(c), pwr) & 0xff)) >>> 0;

/** mult_alpha: a + b − a·b/255 (rounded), in unsigned 32-bit arithmetic. */
function multAlpha(a: number, b: number): number {
  return u32(a - Math.floor((a * b + 0x7f) / 0xff) + b);
}

/** ass_apply_fade: VSFilter applies a fade only when it is positive. */
export function applyFade(color: number, fade: number): number {
  return fade > 0 ? changeAlpha(color, multAlpha(alphaOf(color), fade), 1) : color;
}

/** interpolate_alpha: the piecewise-linear alpha of \fad/\fade at `now` (ms from the event's start). */
export function interpolateAlpha(now: number, t1: number, t2: number, t3: number, t4: number, a1: number, a2: number, a3: number): number {
  if (now < t1) return a1;
  if (now < t2) {
    const cf = i32(u32(now) - t1) / i32(u32(t2) - t1);
    return toInt(a1 * (1 - cf) + a2 * cf);
  }
  if (now < t3) return a2;
  if (now < t4) {
    const cf = i32(u32(now) - t3) / i32(u32(t4) - t3);
    return toInt(a2 * (1 - cf) + a3 * cf);
  }
  return a3;
}

/** numpad2align (also in parse.ts, which owns style parsing) */
function numpad2align(val: number): number {
  if (val < -0x7fffffff) val = 2;
  else if (val < 0) val = -val;
  let res = ((val - 1) % 3) + 1;
  if (val <= 3) res |= VALIGN_SUB;
  else if (val <= 6) res |= VALIGN_CENTER;
  else res |= VALIGN_TOP;
  return res;
}

/** lookup_style_strict: the last style with exactly this name, else null. */
function lookupStyleStrict(styles: readonly AssStyle[], name: string): AssStyle | null {
  for (let i = styles.length - 1; i >= 0; i--) if (styles[i]!.name === name) return styles[i]!;
  return null;
}

/** ass_parse_tags over text[p, end); returns where it stopped. `now` is ms from the event's start. */
function parse(s: RenderState, text: string, p: number, end: number, pwr: number, nested: boolean, now: number): number {
  const at = (i: number): string => (i < text.length ? text[i]! : '\0');
  const argtoi32 = (a: Arg): number => mystrtoi32(cursor(text, a.start), 10) ?? 0;
  const argtod = (a: Arg): number => assStrtod(cursor(text, a.start));
  const argText = (a: Arg): string => text.slice(a.start, a.end);
  const parseAlpha = (a: Arg): number => {
    const c = cursor(text, a.start);
    while (at(c.i) === '&' || at(c.i) === 'H') c.i++;
    return mystrtoi32(c, 16) ?? 0;
  };
  const parseColor = (a: Arg): number => bswap32(u32(parseAlpha(a)));

  for (let q = p; p < end; p = q) {
    while (at(p) !== '\\' && p !== end) p++;
    if (at(p) !== '\\') break;
    p++;
    if (p !== end) { const c = cursor(text, p); skipSpaces(c); p = c.i; }

    q = p;
    while (at(q) !== '(' && at(q) !== '\\' && q !== end) q++;
    if (q === p) continue;
    const nameEnd = q;

    const args: Arg[] = [];
    const empty: Arg = { start: text.length, end: text.length };
    const arg = (i: number): Arg => args[i] ?? empty;
    let hasBackslashArg = false;
    const pushArg = (start: number, e: number): void => {
      if (args.length <= MAX_VALID_NARGS) {
        e = rskipSpaces(text, e, start);
        if (e > start) args.push({ start, end: e });
      }
    };

    if (at(q) === '(') {
      q++;
      for (;;) {
        if (q !== end) { const c = cursor(text, q); skipSpaces(c); q = c.i; }
        let r = q;
        while (at(r) !== ',' && at(r) !== '\\' && at(r) !== ')' && r !== end) r++;
        if (at(r) === ',') {
          pushArg(q, r);
          q = r + 1;
        } else {
          if (at(r) === '\\') {
            hasBackslashArg = true;
            const paren = text.indexOf(')', r);
            r = paren !== -1 && paren < end ? paren : end;
          }
          pushArg(q, r);
          q = r;
          if (q !== end) q++;
          break;
        }
      }
    }

    const mystrcmp = (name: string): boolean => {
      if (text.startsWith(name, p)) {
        p += name.length;
        return true;
      }
      return false;
    };
    const tag = (name: string): boolean => {
      if (!mystrcmp(name)) return false;
      pushArg(p, nameEnd);
      return true;
    };
    const complexTag = mystrcmp;
    const nargs = (): number => args.length;
    const style = s.style;

    if (tag('xbord')) {
      s.borderX = nargs() ? Math.max(0, s.borderX * (1 - pwr) + argtod(arg(0)) * pwr) : style.outline;
    } else if (tag('ybord')) {
      s.borderY = nargs() ? Math.max(0, s.borderY * (1 - pwr) + argtod(arg(0)) * pwr) : style.outline;
    } else if (tag('xshad')) {
      s.shadowX = nargs() ? s.shadowX * (1 - pwr) + argtod(arg(0)) * pwr : style.shadow;
    } else if (tag('yshad')) {
      s.shadowY = nargs() ? s.shadowY * (1 - pwr) + argtod(arg(0)) * pwr : style.shadow;
    } else if (tag('fax')) {
      s.fax = nargs() ? argtod(arg(0)) * pwr + s.fax * (1 - pwr) : 0;
    } else if (tag('fay')) {
      s.fay = nargs() ? argtod(arg(0)) * pwr + s.fay * (1 - pwr) : 0;
    } else if (complexTag('iclip')) {
      if (nargs() === 4) {
        rectClip(s, argtoi32(arg(0)), argtoi32(arg(1)), argtoi32(arg(2)), argtoi32(arg(3)), pwr);
        s.clipMode = 1;
      } else if (s.clipDrawingText === null && vectorClip(s, args, argtoi32, argText)) {
        s.clipDrawingMode = 1;
      }
    } else if (tag('blur')) {
      s.blur = nargs() ? Math.min(BLUR_MAX_RADIUS, Math.max(0, s.blur * (1 - pwr) + argtod(arg(0)) * pwr)) : 0;
    } else if (tag('fscx')) {
      s.scaleX = nargs() ? Math.max(0, s.scaleX * (1 - pwr) + (argtod(arg(0)) / 100) * pwr) : style.scaleX;
    } else if (tag('fscy')) {
      s.scaleY = nargs() ? Math.max(0, s.scaleY * (1 - pwr) + (argtod(arg(0)) / 100) * pwr) : style.scaleY;
    } else if (tag('fsc')) {
      s.scaleX = style.scaleX;
      s.scaleY = style.scaleY;
    } else if (tag('fsp')) {
      s.hspacing = nargs() ? s.hspacing * (1 - pwr) + argtod(arg(0)) * pwr : style.spacing;
    } else if (tag('fs')) {
      let val = 0;
      if (nargs()) {
        val = argtod(arg(0));
        const sign = at(arg(0).start);
        val = sign === '+' || sign === '-' ? s.fontSize * (1 + (pwr * val) / 10) : s.fontSize * (1 - pwr) + val * pwr;
      }
      if (val <= 0) val = style.fontSize;
      s.fontSize = val;
    } else if (tag('bord')) {
      if (nargs()) {
        const val = argtod(arg(0));
        s.borderX = Math.max(0, s.borderX * (1 - pwr) + val * pwr);
        s.borderY = Math.max(0, s.borderY * (1 - pwr) + val * pwr);
      } else {
        s.borderX = s.borderY = style.outline;
      }
    } else if (complexTag('move')) {
      if (nargs() !== 4 && nargs() !== 6) continue;
      const x1 = argtod(arg(0));
      const y1 = argtod(arg(1));
      const x2 = argtod(arg(2));
      const y2 = argtod(arg(3));
      let t1 = 0;
      let t2 = 0;
      if (nargs() === 6) {
        t1 = argtoi32(arg(4));
        t2 = argtoi32(arg(5));
        if (t1 > t2) [t1, t2] = [t2, t1];
      }
      if (t1 <= 0 && t2 <= 0) {
        t1 = 0;
        t2 = s.event.duration;
      }
      const deltaT = i32(u32(t2) - t1);
      const t = i32(now);
      const k = t <= t1 ? 0 : t >= t2 ? 1 : i32(u32(t) - t1) / deltaT;
      if (!(s.evtType & EVENT_POSITIONED)) {
        s.posX = k * (x2 - x1) + x1;
        s.posY = k * (y2 - y1) + y1;
        s.detectCollisions = false;
        s.evtType |= EVENT_POSITIONED;
      }
    } else if (tag('frx')) {
      s.frx = nargs() ? argtod(arg(0)) * pwr + s.frx * (1 - pwr) : 0;
    } else if (tag('fry')) {
      s.fry = nargs() ? argtod(arg(0)) * pwr + s.fry * (1 - pwr) : 0;
    } else if (tag('frz') || tag('fr')) {
      s.frz = nargs() ? argtod(arg(0)) * pwr + s.frz * (1 - pwr) : style.angle;
    } else if (tag('fn')) {
      if (nargs() && argText(arg(0)) !== '0') {
        const c = cursor(text, arg(0).start);
        skipSpaces(c);
        s.family = text.slice(c.i, arg(0).end);
      } else {
        s.family = style.fontName;
      }
      updateFont(s);
    } else if (tag('alpha')) {
      if (nargs()) {
        const a = parseAlpha(arg(0));
        for (let i = 0; i < 4; i++) s.c[i] = changeAlpha(s.c[i]!, a, pwr);
      } else {
        s.c[0] = changeAlpha(s.c[0], alphaOf(style.primaryColour), 1);
        s.c[1] = changeAlpha(s.c[1], alphaOf(style.secondaryColour), 1);
        s.c[2] = changeAlpha(s.c[2], alphaOf(style.outlineColour), 1);
        s.c[3] = changeAlpha(s.c[3], alphaOf(style.backColour), 1);
      }
    } else if (tag('an')) {
      const val = argtoi32(arg(0));
      if ((s.parsedTags & PARSED_A) === 0) {
        s.alignment = val >= 1 && val <= 9 ? numpad2align(val) : style.alignment;
        s.parsedTags |= PARSED_A;
      }
    } else if (tag('a')) {
      const val = argtoi32(arg(0));
      if ((s.parsedTags & PARSED_A) === 0) {
        // VSFilter: the illegal \a8 and \a4 act as \a5
        s.alignment = val >= 1 && val <= 11 ? ((val & 3) === 0 ? 5 : val) : style.alignment;
        s.parsedTags |= PARSED_A;
      }
    } else if (complexTag('pos')) {
      if (nargs() !== 2) continue;
      const v1 = argtod(arg(0));
      const v2 = argtod(arg(1));
      if (!(s.evtType & EVENT_POSITIONED)) {
        s.evtType |= EVENT_POSITIONED;
        s.detectCollisions = false;
        s.posX = v1;
        s.posY = v2;
      }
    } else if (complexTag('fade') || complexTag('fad')) {
      let a1: number, a2: number, a3: number, t1: number, t2: number, t3: number, t4: number;
      if (nargs() === 2) {
        a1 = 0xff; a2 = 0; a3 = 0xff;
        t1 = -1; t2 = argtoi32(arg(0)); t3 = argtoi32(arg(1)); t4 = -1;
      } else if (nargs() === 7) {
        a1 = argtoi32(arg(0)); a2 = argtoi32(arg(1)); a3 = argtoi32(arg(2));
        t1 = argtoi32(arg(3)); t2 = argtoi32(arg(4)); t3 = argtoi32(arg(5)); t4 = argtoi32(arg(6));
      } else continue;
      if (t1 === -1 && t4 === -1) {
        t1 = 0;
        t4 = s.event.duration;
        t3 = i32(u32(t4) - t3);
      }
      if ((s.parsedTags & PARSED_FADE) === 0) {
        s.fade = interpolateAlpha(now, t1, t2, t3, t4, a1, a2, a3);
        s.parsedTags |= PARSED_FADE;
      }
    } else if (complexTag('org')) {
      if (nargs() !== 2) continue;
      const v1 = argtod(arg(0));
      const v2 = argtod(arg(1));
      if (!s.haveOrigin) {
        s.orgX = v1;
        s.orgY = v2;
        s.haveOrigin = true;
        s.detectCollisions = false;
      }
    } else if (complexTag('t')) {
      const cnt = nargs() - 1;
      let t1: number, t2: number, accel: number;
      if (cnt === 3) {
        t1 = argtoi32(arg(0));
        t2 = argtoi32(arg(1));
        accel = argtod(arg(2));
      } else if (cnt === 2) {
        t1 = dtoi32(argtod(arg(0)));
        t2 = dtoi32(argtod(arg(1)));
        accel = 1;
      } else if (cnt === 1) {
        t1 = 0;
        t2 = 0;
        accel = argtod(arg(0));
      } else {
        t1 = 0;
        t2 = 0;
        accel = 1;
      }
      s.detectCollisions = false;
      if (t2 === 0) t2 = s.event.duration;
      const deltaT = i32(u32(t2) - t1);
      const t = i32(now);
      const k = t < t1 ? 0 : t >= t2 ? 1 : Math.pow(i32(u32(t) - t1) / deltaT, accel);
      if (nested) pwr = k;
      if (cnt < 0 || cnt > 3) continue;
      if (!hasBackslashArg) continue;
      const last = arg(cnt);
      if (last.end < end) {
        parse(s, text, last.start, last.end, k, true, now);
      } else {
        // nothing can follow this \t: continue in this loop with its power (libass's tail call)
        pwr = k;
        nested = true;
        q = last.start;
      }
    } else if (complexTag('clip')) {
      if (nargs() === 4) {
        rectClip(s, argtoi32(arg(0)), argtoi32(arg(1)), argtoi32(arg(2)), argtoi32(arg(3)), pwr);
        s.clipMode = 0;
      } else if (s.clipDrawingText === null && vectorClip(s, args, argtoi32, argText)) {
        s.clipDrawingMode = 0;
      }
    } else if (tag('c') || tag('1c')) {
      s.c[0] = changeColor(s.c[0], nargs() ? parseColor(arg(0)) : style.primaryColour, nargs() ? pwr : 1);
    } else if (tag('2c')) {
      s.c[1] = changeColor(s.c[1], nargs() ? parseColor(arg(0)) : style.secondaryColour, nargs() ? pwr : 1);
    } else if (tag('3c')) {
      s.c[2] = changeColor(s.c[2], nargs() ? parseColor(arg(0)) : style.outlineColour, nargs() ? pwr : 1);
    } else if (tag('4c')) {
      s.c[3] = changeColor(s.c[3], nargs() ? parseColor(arg(0)) : style.backColour, nargs() ? pwr : 1);
    } else if (tag('1a')) {
      s.c[0] = changeAlpha(s.c[0], nargs() ? parseAlpha(arg(0)) : alphaOf(style.primaryColour), nargs() ? pwr : 1);
    } else if (tag('2a')) {
      s.c[1] = changeAlpha(s.c[1], nargs() ? parseAlpha(arg(0)) : alphaOf(style.secondaryColour), nargs() ? pwr : 1);
    } else if (tag('3a')) {
      s.c[2] = changeAlpha(s.c[2], nargs() ? parseAlpha(arg(0)) : alphaOf(style.outlineColour), nargs() ? pwr : 1);
    } else if (tag('4a')) {
      s.c[3] = changeAlpha(s.c[3], nargs() ? parseAlpha(arg(0)) : alphaOf(style.backColour), nargs() ? pwr : 1);
    } else if (tag('r')) {
      resetRenderState(s, nargs() ? lookupStyleStrict(s.track.styles, argText(arg(0))) : null);
    } else if (tag('be')) {
      if (nargs()) {
        // VSFilter always adds 0.5, even to a negative value
        const val = dtoi32(s.be * (1 - pwr) + argtod(arg(0)) * pwr + 0.5);
        s.be = Math.min(MAX_BE, Math.max(0, val));
      } else s.be = 0;
    } else if (tag('b')) {
      let val = argtoi32(arg(0));
      if (!nargs() || !(val === 0 || val === 1 || val >= 100)) val = style.bold;
      s.bold = val;
      updateFont(s);
    } else if (tag('i')) {
      let val = argtoi32(arg(0));
      if (!nargs() || !(val === 0 || val === 1)) val = style.italic;
      s.italic = val;
      updateFont(s);
    } else if (tag('kt')) {
      const val = nargs() ? argtod(arg(0)) * 10 : 0;
      s.effectSkipTiming = dtoi32(val);
      s.effectTiming = 0;
      s.resetEffect = true;
    } else if (tag('kf') || tag('K')) {
      karaoke(s, EF_KARAOKE_KF, nargs() ? argtod(arg(0)) : 100);
    } else if (tag('ko')) {
      karaoke(s, EF_KARAOKE_KO, nargs() ? argtod(arg(0)) : 100);
    } else if (tag('k')) {
      karaoke(s, EF_KARAOKE, nargs() ? argtod(arg(0)) : 100);
    } else if (tag('shad')) {
      if (nargs()) {
        const val = argtod(arg(0));
        // VSFilter: \shad clips at 0, \xshad and \yshad do not
        s.shadowX = Math.max(0, s.shadowX * (1 - pwr) + val * pwr);
        s.shadowY = Math.max(0, s.shadowY * (1 - pwr) + val * pwr);
      } else {
        s.shadowX = s.shadowY = style.shadow;
      }
    } else if (tag('s')) {
      let val = argtoi32(arg(0));
      if (!nargs() || !(val === 0 || val === 1)) val = style.strikeOut;
      s.flags = val ? s.flags | DECO_STRIKETHROUGH : s.flags & ~DECO_STRIKETHROUGH;
    } else if (tag('u')) {
      let val = argtoi32(arg(0));
      if (!nargs() || !(val === 0 || val === 1)) val = style.underline;
      s.flags = val ? s.flags | DECO_UNDERLINE : s.flags & ~DECO_UNDERLINE;
    } else if (tag('pbo')) {
      s.pbo = argtod(arg(0));
    } else if (tag('p')) {
      s.drawingScale = Math.max(0, argtoi32(arg(0)));
    } else if (tag('q')) {
      let val = argtoi32(arg(0));
      if (!nargs() || !(val >= 0 && val <= 3)) val = s.track.wrapStyle;
      s.wrapStyle = val;
    } else if (tag('fe')) {
      s.fontEncoding = nargs() ? argtoi32(arg(0)) : style.encoding;
    }
  }
  return p;
}

function rectClip(s: RenderState, x0: number, y0: number, x1: number, y1: number, pwr: number): void {
  s.clipX0 = toInt(s.clipX0 * (1 - pwr) + x0 * pwr);
  s.clipX1 = toInt(s.clipX1 * (1 - pwr) + x1 * pwr);
  s.clipY0 = toInt(s.clipY0 * (1 - pwr) + y0 * pwr);
  s.clipY1 = toInt(s.clipY1 * (1 - pwr) + y1 * pwr);
}

/** parse_vector_clip: one or two arguments (scale, drawing); the drawing is parsed when the event is laid out. */
function vectorClip(s: RenderState, args: readonly Arg[], argtoi32: (a: Arg) => number, argText: (a: Arg) => string): boolean {
  if (args.length !== 1 && args.length !== 2) return false;
  s.clipDrawingScale = args.length === 2 ? argtoi32(args[0]!) : 1;
  s.clipDrawingText = argText(args[args.length - 1]!);
  return true;
}

function karaoke(s: RenderState, type: number, val: number): void {
  s.effectType = type;
  s.effectSkipTiming = i32(s.effectSkipTiming + u32(s.effectTiming));
  s.effectTiming = dtoi32(val * 10);
}

/** ass_parse_tags over one override block (the text between the braces). `now` is ms from the event's start. */
export function parseTags(s: RenderState, block: string, pwr: number, nested: boolean, now: number): void {
  parse(s, block, 0, block.length, pwr, nested, now);
}

/** ass_get_next_char: the code point at `i` with \N, \n, \h, \{, \} and tab handled; returns it and the next index. */
export function nextChar(s: RenderState, text: string, i: number): readonly [number, number] {
  if (text[i] === '\t') return [0x20, i + 1];
  if (text[i] === '\\') {
    const n = text[i + 1];
    if (n === 'N' || (n === 'n' && s.wrapStyle === 2)) return [0x0a, i + 2];
    if (n === 'n') return [0x20, i + 2];
    if (n === 'h') return [NBSP, i + 2];
    if (n === '{') return [0x7b, i + 2];
    if (n === '}') return [0x7d, i + 2];
  }
  const cp = text.codePointAt(i)!;
  return [cp, i + (cp > 0xffff ? 2 : 1)];
}
