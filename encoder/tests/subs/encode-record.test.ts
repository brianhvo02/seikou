// SPDX-License-Identifier: LGPL-3.0-or-later
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { discKeyOfFolder } from '../../src/disc/disc-key';
import { loadEncodeRecord, MissingSubtitleFilesError, NoAudioChosenError, RecordMismatchError } from '../../src/subs/encode-record';
import { RecordStore, type SubtitleRecord } from '../../src/subs/record';
import { fx } from '../paths';

const discDir = fx('fixtures/disc1');

async function recordFor(over: Partial<SubtitleRecord>): Promise<SubtitleRecord> {
  const { key, label } = await discKeyOfFolder(discDir);
  return {
    disc: { key, label },
    playlist: '00000',
    episodeSpec: '1-2',
    anilist: null,
    release: { source: 'local', id: 'r1', group: 'GroupA', label: 'GroupA batch' },
    fonts: [],
    episodes: [
      {
        index: 1,
        title: 'Harbor',
        tracks: [
          { file: 'cache/r1/ep1.ass', kind: 'full', language: 'eng', name: 'GroupA', shiftMs: 0, nudgeMs: 0, split: null, included: true },
        ],
        metadata: { title: 'Harbor', video: { name: '', language: 'und' }, audio: [{ pid: 0x1100, name: '', language: 'jpn', included: true }], chapters: [] },
      },
    ],
    savedAt: '2026-11-07T10:00:00Z',
    ...over,
  };
}

describe('loadEncodeRecord', () => {
  let dataDir: string;
  beforeEach(async () => {
    dataDir = await mkdtemp(join(tmpdir(), 'encode-record-'));
  });
  afterEach(() => rm(dataDir, { recursive: true, force: true }));
  const ask = (episodeSpec: string, noSubtitles = false) =>
    loadEncodeRecord({ discDir, playlistId: '00000', episodeSpec, dataDir, noSubtitles });

  it('no record gives null', async () => {
    expect(await ask('1-2')).toBeNull();
  });

  it('gives the saved record when it matches and its files are there', async () => {
    await mkdir(join(dataDir, 'cache/r1'), { recursive: true });
    await writeFile(join(dataDir, 'cache/r1/ep1.ass'), 'x');
    const saved = await recordFor({});
    await new RecordStore(dataDir).write(saved);
    expect(await ask('1-2')).toEqual(saved);
  });

  it('refuses a record that ticks no audio stream for an episode, naming it', async () => {
    const saved = await recordFor({});
    saved.episodes[0]!.metadata.audio = [{ pid: 0x1100, name: '', language: 'jpn', included: false }];
    await new RecordStore(dataDir).write(saved);
    const err = await ask('1-2').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(NoAudioChosenError);
    expect((err as Error).message).toBe('Episode 1 has no audio stream ticked in the saved choices; tick one in the helper or pass --no-subtitles');
    expect(await ask('1-2', true)).toBeNull();
  });

  it('--no-subtitles ignores a mismatched record', async () => {
    await new RecordStore(dataDir).write(await recordFor({ episodeSpec: '1-3,4-5' }));
    expect(await ask('1-4', true)).toBeNull();
  });

  it('a record for another spec throws RecordMismatchError naming both', async () => {
    await new RecordStore(dataDir).write(await recordFor({ episodeSpec: '1-3,4-5' }));
    const err = await ask('1-4').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(RecordMismatchError);
    expect((err as Error).message).toBe(
      'The saved subtitle choices are for playlist 00000 episodes 1-3,4-5; this encode asks for 00000 episodes 1-4. Re-save them in the helper or pass --no-subtitles.',
    );
  });

  it('a record whose track file is gone throws naming the release', async () => {
    await new RecordStore(dataDir).write(await recordFor({}));
    const err = await ask('1-2').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(MissingSubtitleFilesError);
    expect((err as Error).message).toContain('GroupA batch');
    expect((err as Error).message).toContain('cache/r1/ep1.ass');
  });
});
