// SPDX-License-Identifier: LGPL-3.0-or-later
import { fileURLToPath } from 'node:url';
import { expect, it, vi } from 'vitest';
import { createSources } from '../../src/server/sources';

const FANSUBS = fileURLToPath(new URL('../fixtures/fansubs/', import.meta.url));

it('fixture sources come from SEIKOU_ENCODE_FIXTURE and never touch the network', async () => {
  const fetch = vi.fn<typeof globalThis.fetch>(async () => {
    throw new Error('network used');
  });
  const sources = createSources({ SEIKOU_ENCODE_FIXTURE: FANSUBS }, fetch);
  expect(await sources.seadex.entry(900101)).not.toBeNull();
  expect((await sources.anilist.search('lantern', {})).length).toBeGreaterThan(0);
  expect((await sources.episodes.titles(900101)).size).toBeGreaterThan(0);
  expect(fetch).not.toHaveBeenCalled();
});

it('a missing fixture folder throws naming the variable', () => {
  expect(() => createSources({ SEIKOU_ENCODE_FIXTURE: '/nonexistent/fixture' }, fetch)).toThrowError(/SEIKOU_ENCODE_FIXTURE/);
});

it('live sources are built without any request being made', () => {
  const fetch = vi.fn<typeof globalThis.fetch>();
  const sources = createSources({}, fetch);
  expect(typeof sources.seadex.entry).toBe('function');
  expect(typeof sources.tosho.search).toBe('function');
  expect(typeof sources.anilist.search).toBe('function');
  expect(fetch).not.toHaveBeenCalled();
});
