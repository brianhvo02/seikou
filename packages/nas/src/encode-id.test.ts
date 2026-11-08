// SPDX-License-Identifier: LGPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import { encodeId, encodePlaceKey, parseEncodeId, parseEncodePlaceKey } from './encode-id';

describe('encode ids', () => {
  it('round-trips an id and a place key', () => {
    expect(encodeId(990001, 2)).toBe('990001-2');
    expect(parseEncodeId('990001-2')).toEqual({ anilistId: 990001, episode: 2 });
    expect(encodePlaceKey(990001, 2)).toBe('e.990001.2');
    expect(parseEncodePlaceKey('e.990001.2')).toEqual({ anilistId: 990001, episode: 2 });
  });
  it('refuses anything that is not two whole numbers of 1 or more', () => {
    for (const bad of ['', '1', '1-', '-1', '0-1', '1-0', '1-2-3', 'a-1', '1-1.5', '01-1', '1- 1', '../1-1']) expect(parseEncodeId(bad), bad).toBeNull();
    for (const bad of ['', 'e.1', 'e.0.1', 'e.1.0', 'e.1.2.3', 'd.1.2', 'f.1.2', 'e.a.b']) expect(parseEncodePlaceKey(bad), bad).toBeNull();
  });
});
