import { describe, expect, it } from 'vitest';
import { evalRpn, RpnError, type SizeLookup } from './rpn';

const mk = (sizes: Record<string, [number, number]>): SizeLookup => (n) => {
  const s = sizes[n];
  return s ? { width: s[0], height: s[1] } : undefined;
};
const std = mk({ MAIN: [1920, 1080], HOOKED: [1920, 1080], OUTPUT: [3840, 2160], NATIVE: [1920, 1080] });

describe('evalRpn', () => {
  it('evaluates sizes and arithmetic', () => {
    expect(evalRpn('MAIN.w 2 *', std)).toBe(3840);
    expect(evalRpn('HOOKED.h 2 /', std)).toBe(540);
    expect(evalRpn('MAIN.width', std)).toBe(1920);
    expect(evalRpn('MAIN.height', std)).toBe(1080);
  });
  it('evaluates WHEN conditions', () => {
    const e = 'OUTPUT.w MAIN.w / 1.200 > OUTPUT.h MAIN.h / 1.200 > *';
    expect(evalRpn(e, std)).toBe(1);
    expect(evalRpn(e, mk({ MAIN: [1920, 1080], OUTPUT: [1920, 1080] }))).toBe(0);
    const d = 'OUTPUT.w NATIVE.w / 2.0 < OUTPUT.w NATIVE.w / 1.2 > *';
    expect(evalRpn(d, std)).toBe(0);
  });
  it('supports %, ! and fuzzy =', () => {
    expect(evalRpn('7 3 %', std)).toBe(1);
    expect(evalRpn('0 !', std)).toBe(1);
    expect(evalRpn('5 !', std)).toBe(0);
    expect(evalRpn('1 1.0000001 =', std)).toBe(1);
    expect(evalRpn('1 2 =', std)).toBe(0);
  });
  it('returns null for unknown textures', () => {
    expect(evalRpn('FOO.w 2 *', std)).toBeNull();
  });
  it('returns null for a non-finite result', () => {
    expect(evalRpn('1 0 /', std)).toBeNull();
    expect(evalRpn('MAIN.w 0 /', std)).toBeNull();
  });
  it('throws on malformed text', () => {
    expect(() => evalRpn('1 +', std)).toThrow(RpnError);
    expect(() => evalRpn('1 2', std)).toThrow(RpnError);
    expect(() => evalRpn('1 bogus', std)).toThrow(RpnError);
  });
});
