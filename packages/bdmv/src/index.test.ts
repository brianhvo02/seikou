// SPDX-License-Identifier: LGPL-2.1-or-later
import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';
import { ByteReader } from './byte-reader';
import * as bdmv from '@seikou/bdmv';
import { CodingType, parseMpls } from '@seikou/bdmv';

it('resolves the package by name and through the barrel', () => {
  expect(new ByteReader(new Uint8Array([1, 2])).u8()).toBe(1);
  expect(typeof bdmv.ByteReader).toBe('function');
});

it('parses the synthetic playlist through the barrel', () => {
  const mpls = parseMpls(new Uint8Array(readFileSync('fixtures/synthetic/disc1/BDMV/PLAYLIST/00000.mpls')));
  expect(mpls.playItems).toHaveLength(2);
  expect(CodingType.LPCM).toBe(0x80);
});
