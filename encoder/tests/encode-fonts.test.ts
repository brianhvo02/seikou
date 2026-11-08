// SPDX-License-Identifier: LGPL-3.0-or-later
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';
import { discKeyOfFolder } from '../src/disc/disc-key';
import { encodeEpisodes, type EncodeOptions } from '../src/encode';
import type { SubtitleRecord } from '../src/subs/record';
import { fx } from './paths';

// Every readFile in the encode's module graph goes through this spy, so the test can count font reads.
vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return { ...actual, readFile: vi.fn(actual.readFile) };
});

it("reads the record's fonts once for all its episodes", async () => {
  const out = mkdtempSync(join(tmpdir(), 'et-fonts-'));
  try {
    const discDir = fx('fixtures/disc1');
    const dataDir = join(out, 'data');
    const font = `fonts/${'b'.repeat(64)}.ttf`;
    mkdirSync(join(dataDir, 'cache'), { recursive: true });
    mkdirSync(join(dataDir, 'fonts'), { recursive: true });
    writeFileSync(join(dataDir, font), new Uint8Array([1, 2, 3]));
    writeFileSync(
      join(dataDir, 'cache/ep.ass'),
      '[Script Info]\nScriptType: v4.00+\n\n[Events]\nFormat: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text\nDialogue: 0,0:00:00.10,0:00:00.50,Default,,0,0,0,,Hi\n',
    );
    const { key, label } = await discKeyOfFolder(discDir);
    const episode = (index: number): SubtitleRecord['episodes'][number] => ({
      index,
      title: `Episode ${index}`,
      tracks: [{ release: 'local-0', file: 'cache/ep.ass', kind: 'full', language: 'eng', name: 'English', shiftMs: 0, nudgeMs: 0, split: null, included: true }],
      metadata: { title: `Episode ${index}`, video: { name: '', language: 'und' }, audio: [{ pid: 0x1100, name: '', language: 'eng', included: true }], chapters: [] },
    });
    const record: SubtitleRecord = { disc: { key, label }, playlist: '00000', episodeSpec: '1-2,3-4', anilist: null, releases: [{ source: 'local', id: 'local-0', group: '', label: 'own files' }], fonts: [font], episodes: [episode(1), episode(2)], savedAt: '2026-11-07T00:00:00Z' };
    const missing = { vspipe: '/nonexistent/vspipe', svt: '/nonexistent/SvtAv1EncApp', opusenc: '/nonexistent/opusenc' };
    const opts: EncodeOptions = { discDir, playlistId: '00000', episodes: '1-2,3-4', outDir: join(out, 'mkv'), namePattern: 'ep-{n}', crf: 50, preset: 10, extraSvtArgs: [], filmGrain: 4, cacheDir: join(out, 'cache'), tools: missing, dataDir, noSubtitles: false, noPgs: true, record };
    vi.mocked(readFile).mockClear();
    // The tools are missing, so the run stops at the first encode, after every episode's subtitles are built.
    await expect(encodeEpisodes(opts, () => {})).rejects.toThrow();
    const fontReads = vi.mocked(readFile).mock.calls.filter(([path]) => String(path).endsWith(font));
    expect(fontReads).toHaveLength(1);
  } finally {
    rmSync(out, { recursive: true, force: true });
  }
}, 60_000);
