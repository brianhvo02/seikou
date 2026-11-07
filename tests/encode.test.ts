// SPDX-License-Identifier: LGPL-3.0-or-later
import { existsSync, mkdtempSync, readdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { encodeEpisodes, opusArgs, svtArgs, type EncodeOptions } from '../src/encode';
import { Id } from '../src/mux/mkv-ids';
import { countVideoBlocks, find, findAll, floatOf, parseMkv, uintOf } from './helpers/ebml-reader';
import { haveTools, toolPaths } from './helpers/tools';

afterEach(() => {
  delete process.env.FAKE_ENC_EXIT;
});

it('builds encoder argument lists from the spec defaults', () => {
  expect(svtArgs({ crf: 25, preset: 4, extraSvtArgs: ['--lp', '4'] })).toEqual(['--preset', '4', '--crf', '25', '--enable-variance-boost', '1', '--tf-strength', '1', '--film-grain', '4', '--tile-columns', '1', '--keyint', '-2', '--color-primaries', '1', '--transfer-characteristics', '1', '--matrix-coefficients', '1', '--color-range', '0', '--progress', '0', '--lp', '4']);
  expect(opusArgs(2)).toEqual(['--bitrate', '160', '--ignorelength']);
  expect(opusArgs(6)).toEqual(['--bitrate', '320', '--ignorelength']);
});

describe.skipIf(!haveTools)('end to end on disc1', () => {
  const base = (out: string): EncodeOptions => ({ discDir: 'fixtures/disc1', playlistId: '00000', episodes: '1-2,3-4', outDir: out, namePattern: 'ep-{n}', crf: 40, preset: 8, extraSvtArgs: [], cacheDir: join(out, 'cache'), tools: toolPaths()! });

  it('encodes two episodes with chapters and no leftover files', async () => {
    const out = mkdtempSync(join(tmpdir(), 'et-'));
    const paths = await encodeEpisodes(base(out), () => {});
    expect(paths.map((p) => basename(p))).toEqual(['ep-01.mkv', 'ep-02.mkv']);
    const t = parseMkv(readFileSync(paths[0]!));
    expect(findAll(t, Id.ChapterTimeStart).map(uintOf)).toEqual([0n, 2002000000n]);
    expect(countVideoBlocks(t)).toBe(96);
    expect(floatOf(find(t, Id.Duration)!)).toBeCloseTo(4004, -1); // audio end includes the 6.5 ms Opus pre-skip, so allow 5 ms
    expect(readdirSync(out).sort()).toEqual(['cache', 'ep-01.mkv', 'ep-02.mkv']);
  }, 600_000);

  it('deletes the partial file when the encoder fails', async () => {
    const out = mkdtempSync(join(tmpdir(), 'et-'));
    const opts = { ...base(out), episodes: '1-2' };
    process.env.FAKE_ENC_EXIT = '3';
    await expect(encodeEpisodes({ ...opts, tools: { ...toolPaths()!, svt: 'tests/fake-bin/SvtAv1EncApp' } }, () => {})).rejects.toMatchObject({ tool: 'SvtAv1EncApp', code: 3 });
    expect(existsSync(join(out, 'ep-01.mkv'))).toBe(false);
  }, 120_000);
});
