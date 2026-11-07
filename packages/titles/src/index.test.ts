// SPDX-License-Identifier: LGPL-3.0-or-later
import { expect, it } from 'vitest';
import { createAniList, NAME_CORPUS, parseName, Pacer } from '@seikou/titles';

it('builds a source from a fetch and a pacer through the barrel', () => {
  const fetchStub = (async () => new Response('{}')) as typeof globalThis.fetch;
  expect(typeof createAniList(fetchStub, new Pacer(100, 1_000)).search).toBe('function');
});

it('parses the first corpus name through the barrel', () => {
  const { text, expected } = NAME_CORPUS[0]!;
  const parsed = parseName(text);
  for (const [key, value] of Object.entries(expected)) expect(parsed[key as keyof typeof parsed], key).toEqual(value);
});
