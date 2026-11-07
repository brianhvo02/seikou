/*
 * Original code for bluray-web, 2026. Evaluates the RPN expressions of mpv
 * user shaders (WIDTH, HEIGHT, WHEN). Semantics follow libplacebo's
 * eval_shexpr in src/shaders/custom_mpv.c.
 *
 * SPDX-License-Identifier: LGPL-2.1-or-later
 */

/** Size lookup for `NAME.w`/`.width`/`.h`/`.height`; undefined = unknown texture. */
export type SizeLookup = (
  name: string,
) => { readonly width: number; readonly height: number } | undefined;

export class RpnError extends Error {}

const NUMBER = /^[+-]?(\d+\.?\d*|\.\d+)(e[+-]?\d+)?$/i;
const TEX = /^(.+)\.(w|width|h|height)$/;

/**
 * Throws RpnError on malformed text (stack underflow, leftovers, unknown
 * token). Returns null when a texture name is unknown or a result is non-finite.
 */
export function evalRpn(expr: string, lookup: SizeLookup): number | null {
  const stack: number[] = [];
  for (const tok of expr.split(/\s+/).filter((t) => t.length > 0)) {
    if (NUMBER.test(tok)) {
      stack.push(Number(tok));
      continue;
    }
    if (tok === '!') {
      if (stack.length < 1) throw new RpnError('stack underflow');
      // libplacebo: stack[idx-1] = !stack[idx-1]
      stack.push(stack.pop() === 0 ? 1 : 0);
      continue;
    }
    if (tok.length === 1 && '+-*/%<>='.includes(tok)) {
      if (stack.length < 2) throw new RpnError('stack underflow');
      const b = stack.pop() as number;
      const a = stack.pop() as number;
      let r: number;
      switch (tok) {
        case '+': r = a + b; break;
        case '-': r = a - b; break;
        case '*': r = a * b; break;
        case '/': r = a / b; break;
        case '%': r = a % b; break; // fmodf
        case '>': r = a > b ? 1 : 0; break;
        case '<': r = a < b ? 1 : 0; break;
        // Negative operands make the tolerance negative (as in libplacebo).
        // libplacebo: res = fabsf(op1 - op2) <= 1e-6 * fmaxf(op1, op2)
        default: r = Math.abs(a - b) <= 1e-6 * Math.max(a, b) ? 1 : 0;
      }
      // libplacebo: "Illegal operation" when !isfinite(res). Data-dependent
      // (e.g. a zero texture size), not malformed text, so the pass is skipped.
      if (!Number.isFinite(r)) return null;
      stack.push(r);
      continue;
    }
    const m = TEX.exec(tok);
    if (!m) throw new RpnError(`unknown token ${tok}`);
    const size = lookup(m[1] as string);
    if (!size) return null;
    stack.push(m[2] === 'w' || m[2] === 'width' ? size.width : size.height);
  }
  if (stack.length !== 1) throw new RpnError('expression must leave one value');
  return stack[0] as number;
}
