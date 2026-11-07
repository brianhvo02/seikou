// SPDX-License-Identifier: LGPL-2.1-or-later
import { expect, it } from 'vitest';
import { parseDiscKey, normalizeTitle } from '@seikou/nas';

it('exposes the disc key and title helpers through the barrel', () => {
  const fp = 'A'.repeat(32);
  expect(parseDiscKey(`f.${fp}`)).toEqual({ kind: 'fingerprint', fingerprint: fp });
  expect(normalizeTitle('  Tsurune  ')).toBe('tsurune');
});
