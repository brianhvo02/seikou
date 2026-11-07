// SPDX-License-Identifier: LGPL-3.0-or-later
import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';
import { parseMpls } from '@seikou/bdmv/mpls-parser';
import { fx } from './paths';

it('parses the fixture playlist through the seikou alias', () => {
  const m = parseMpls(new Uint8Array(readFileSync(fx('fixtures/disc1/BDMV/PLAYLIST/00000.mpls'))));
  expect(m.playItems.map((p) => p.clipId)).toEqual(['00001', '00002']);
  expect(m.marks).toHaveLength(4);
});
