/*
 * ASS vector drawings (\p and vector \clip) into outline commands in 26.6 units, with their control box. Callers
 * apply the \p scale and \pbo, as libass's do.
 *
 * Ported from libass 0.17.5 (ass_drawing.c): get_point, add_3_points, add_many_points, add_root_node,
 * drawing_tokenize, drawing_add_curve, ass_drawing_parse. libass is ISC-licensed; see src/engine/NOTICE.
 * Modified for bluray-web, 2026.
 *
 * SPDX-License-Identifier: LGPL-2.1-or-later AND ISC
 */

import { cursor, mystrtod, type Cursor } from './cstr';
import { doubleToD6 } from './events';

export type PathCommand =
  | readonly ['M', number, number]
  | readonly ['L', number, number]
  | readonly ['C', number, number, number, number, number, number]
  | readonly ['Z'];

export interface Drawing {
  readonly commands: readonly PathCommand[];
  /** x_min, y_min, x_max, y_max over every point read (26.6); null when nothing was drawn. */
  readonly cbox: readonly [number, number, number, number] | null;
}

const enum Token { Move, MoveNc, Line, CubicBezier, BSpline, ExtendSpline }
interface Node { readonly type: Token; readonly x: number; readonly y: number }

function getPoint(c: Cursor): { x: number; y: number } | null {
  const x = mystrtod(c);
  if (x === null) return null;
  const y = mystrtod(c);
  if (y === null) return null;
  return { x: doubleToD6(x), y: doubleToD6(y) };
}

/** add_many_points: points while they parse, in batches; a partial batch is consumed but not added. */
function addManyPoints(c: Cursor, nodes: Node[], type: Token, batch: number): number {
  let total = 0;
  let pending: { x: number; y: number }[] = [];
  while (c.i < c.s.length) {
    const p = getPoint(c);
    if (!p) break;
    pending.push(p);
    total++;
    if (pending.length !== batch) continue;
    for (const q of pending) nodes.push({ type, x: q.x, y: q.y });
    pending = [];
  }
  return total - pending.length;
}

/** drawing_tokenize, VSFilter's rules on what may come before the first m included. */
function tokenize(str: string): Node[] {
  const c = cursor(str);
  const nodes: Node[] = [];
  let splineStart = -1;
  let points = 0;
  let mSeen = false;
  while (c.i < str.length) {
    const cmd = str[c.i++];
    switch (cmd) {
      case 'm': {
        mSeen = true;
        if (nodes.length === 0) {
          const p = getPoint(c);
          if (!p) continue;
          nodes.push({ type: Token.Move, ...p });
          points = 1;
        }
        points += addManyPoints(c, nodes, Token.Move, 1);
        break;
      }
      case 'n': {
        if (nodes.length === 0) {
          const p = getPoint(c);
          if (!p) continue;
          if (!mSeen) return [];
          nodes.push({ type: Token.MoveNc, ...p });
          points = 1;
        }
        points += addManyPoints(c, nodes, Token.MoveNc, 1);
        break;
      }
      case 'l':
        if (nodes.length === 0) continue;
        points += addManyPoints(c, nodes, Token.Line, 1);
        break;
      case 'b':
        if (nodes.length === 0) continue;
        points += addManyPoints(c, nodes, Token.CubicBezier, 3);
        break;
      case 's':
      case 'p': {
        if (cmd === 's') {
          if (nodes.length === 0) continue;
          // only the first three points are B_SPLINE, the rest EXTEND_SPLINE
          splineStart = nodes.length - 1;
          const a = getPoint(c);
          const b = a && getPoint(c);
          const d = b && getPoint(c);
          if (!a || !b || !d) {
            splineStart = -1;
            break;
          }
          nodes.push({ type: Token.BSpline, ...a }, { type: Token.BSpline, ...b }, { type: Token.BSpline, ...d });
          points += 3;
        }
        if (points < 3) continue;
        points += addManyPoints(c, nodes, Token.ExtendSpline, 1);
        break;
      }
      case 'c':
        if (splineStart < 0) continue;
        // close the b-spline: its first three points again
        for (let k = 0; k < 3; k++) nodes.push({ type: Token.ExtendSpline, x: nodes[splineStart + k]!.x, y: nodes[splineStart + k]!.y });
        splineStart = -1;
        break;
      default:
        break;
    }
  }
  return nodes;
}

/** ass_drawing_parse */
export function parseDrawing(text: string): Drawing {
  const nodes = tokenize(text);
  const out: (PathCommand)[] = [];
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  const update = (x: number, y: number): void => {
    x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y);
  };
  let started = false;
  let penX = 0;
  let penY = 0;
  const close = (): void => {
    out.push(['Z']);
    started = false;
  };
  /** drawing_add_curve over nodes[i..i+3] */
  const curve = (i: number, spline: boolean): void => {
    const p = [0, 1, 2, 3].map((k) => ({ x: nodes[i + k]!.x, y: nodes[i + k]!.y }));
    for (const q of p) update(q.x, q.y);
    if (spline) {
      const [a, b, c, d] = p as [{ x: number; y: number }, { x: number; y: number }, { x: number; y: number }, { x: number; y: number }];
      const x01 = Math.trunc((b.x - a.x) / 3);
      const y01 = Math.trunc((b.y - a.y) / 3);
      const x12 = Math.trunc((c.x - b.x) / 3);
      const y12 = Math.trunc((c.y - b.y) / 3);
      const x23 = Math.trunc((d.x - c.x) / 3);
      const y23 = Math.trunc((d.y - c.y) / 3);
      a.x = b.x + ((x12 - x01) >> 1);
      a.y = b.y + ((y12 - y01) >> 1);
      d.x = c.x + ((x23 - x12) >> 1);
      d.y = c.y + ((y23 - y12) >> 1);
      b.x += x12;
      b.y += y12;
      c.x -= x12;
      c.y -= y12;
    }
    if (!started) out.push(['M', p[0]!.x, p[0]!.y]);
    out.push(['C', p[1]!.x, p[1]!.y, p[2]!.x, p[2]!.y, p[3]!.x, p[3]!.y]);
    started = true;
  };
  for (let i = 0; i < nodes.length; ) {
    const t = nodes[i]!;
    switch (t.type) {
      case Token.MoveNc:
        penX = t.x; penY = t.y;
        update(penX, penY);
        i++;
        break;
      case Token.Move:
        penX = t.x; penY = t.y;
        update(penX, penY);
        if (started) close();
        i++;
        break;
      case Token.Line:
        update(t.x, t.y);
        if (!started) out.push(['M', penX, penY]);
        out.push(['L', t.x, t.y]);
        started = true;
        i++;
        break;
      case Token.CubicBezier:
        curve(i - 1, false);
        i += 3;
        break;
      case Token.BSpline:
        curve(i - 1, true);
        i += 3;
        break;
      case Token.ExtendSpline:
        curve(i - 3, true);
        i++;
        break;
    }
  }
  if (started) close();
  return { commands: out, cbox: x0 <= x1 ? [x0, y0, x1, y1] : null };
}

/** The drawing as a Path2D, each 26.6 point mapped by `map` (scale, offset, transform). */
export function toPath2D(d: Drawing, map: (x: number, y: number) => readonly [number, number], PathCtor: typeof Path2D): Path2D {
  const path = new PathCtor();
  for (const c of d.commands) {
    if (c[0] === 'M') path.moveTo(...map(c[1], c[2]));
    else if (c[0] === 'L') path.lineTo(...map(c[1], c[2]));
    else if (c[0] === 'C') path.bezierCurveTo(...map(c[1], c[2]), ...map(c[3], c[4]), ...map(c[5], c[6]));
    else path.closePath();
  }
  return path;
}
