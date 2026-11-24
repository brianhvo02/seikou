// SPDX-License-Identifier: LGPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import { plainEventText, plainText } from './plain-text';
import type { AssEvent } from './types';

const ev = (text: string, readOrder = 0, layer = 0): AssEvent => ({ readOrder, layer, start: 0, duration: 1000, style: 0, name: '', marginL: 0, marginR: 0, marginV: 0, effect: '', text });

describe('plainEventText', () => {
  it('drops override blocks and keeps line breaks and hard spaces', () => {
    expect(plainEventText(ev('{\\i1}Hello{\\i0} there\\Nsecond\\hline'))).toBe('Hello there\nsecond line');
    expect(plainEventText(ev('{\\an8}Top line\\n'))).toBe('Top line');
  });
  it('leaves out signs and drawings', () => {
    expect(plainEventText(ev('{\\pos(320,40)}SHOP SIGN'))).toBeNull();
    expect(plainEventText(ev('{\\move(0,0,10,10)}moving'))).toBeNull();
    expect(plainEventText(ev('{\\clip(0,0,5,5)}clipped'))).toBeNull();
    expect(plainEventText(ev('{\\p1}m 0 0 l 10 0 10 10'))).toBeNull();
    expect(plainEventText(ev('{\\fad(200,200)}   '))).toBeNull();
  });
});

describe('plainText', () => {
  it('orders by file order and keeps each distinct text once', () => {
    expect(plainText([ev('second', 2), ev('first', 1, 1), ev('first', 3, 0), ev('{\\pos(1,1)}sign', 0)])).toEqual(['first', 'second']);
  });
});
