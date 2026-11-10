// SPDX-License-Identifier: LGPL-3.0-or-later
import { appendFileSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, expect, it } from 'vitest';
import { NasClient } from '../../src/nas/client';
import { ensureMirror, HEAD_BYTES } from '../../src/nas/mirror';
import { NasLibrary } from '../../src/nas/nas-library';
import { NasUploadFailed, runNasEpisodes, type NasEpisodesOptions } from '../../src/nas/nas-episodes';
import { pairWithNas } from '../../src/nas/pairing';
import { fx } from '../paths';
import { startNasTestServer, type NasTestServer } from './nas-test-server';
import { retagged } from './retag';

/** The made-up show the episodes are filed under. */
const SHOW = 990004;

let nas: NasTestServer;
let dataDir: string;
let outDir: string;
let client: NasClient;
let key: string;
let mirrorDir: string;
/** The clips the mirror held whole as each episode's encode began. */
let wholeAtEncode: string[][];

/** Every clip `fetch.json` records whole. */
function whole(): string[] {
  const state = JSON.parse(readFileSync(join(mirrorDir, 'fetch.json'), 'utf8')) as { files: Record<string, number>; ranges: Record<string, [number, number][]> };
  return Object.entries(state.files)
    .filter(([path, size]) => path.startsWith('BDMV/STREAM/') && (state.ranges[path] ?? []).reduce((n, [a, b]) => n + b - a, 0) === size)
    .map(([path]) => path.slice('BDMV/STREAM/'.length))
    .sort();
}

const options = (over: Partial<NasEpisodesOptions> = {}): NasEpisodesOptions => ({
  dataDir,
  client,
  discDir: mirrorDir,
  discKey: key,
  playlistId: '00000',
  episodeSpec: '1-3,4-5',
  episodeCount: 2,
  fetchClips: true,
  uploadNames: [`${SHOW}-1.mkv`, `${SHOW}-2.mkv`],
  holder: 'cli:test',
  signal: new AbortController().signal,
  encode: (index) => {
    wholeAtEncode.push(whole());
    const path = join(outDir, `ep-${index}.mkv`);
    writeFileSync(path, retagged(SHOW, index));
    return Promise.resolve(path);
  },
  log: () => {},
  sleep: () => Promise.resolve(),
  ...over,
});

beforeAll(async () => {
  // the speech disc with clip 2 lengthened past a head, so a clip let go of shrinks
  nas = await startNasTestServer({
    prepare: (dir) => {
      cpSync(fx('fixtures/disc-speech'), join(dir, 'speech'), { recursive: true });
      appendFileSync(join(dir, 'speech/BDMV/STREAM/00002.m2ts'), randomBytes(192 * 100_000));
    },
  });
});
afterAll(async () => {
  await nas.close();
});
beforeEach(async () => {
  dataDir = mkdtempSync(join(tmpdir(), 'nas-episodes-'));
  outDir = join(dataDir, 'out');
  mkdirSync(outDir);
  wholeAtEncode = [];
  await pairWithNas(dataDir, { code: await nas.ownerCode(), base: nas.base }, 'Seikou encoder on test');
  client = (await NasClient.load(dataDir))!;
  const library = new NasLibrary({ dataDir, nas: { client } });
  await library.scan();
  const disc = library.discs().find((d) => d.label === 'speech')!;
  key = disc.key;
  mirrorDir = (await ensureMirror(dataDir, client, disc.discId, key)).dir;
});
afterEach(() => {
  client.close();
  rmSync(dataDir, { recursive: true, force: true });
  rmSync(join(nas.encodesDir!, String(SHOW)), { recursive: true, force: true });
  rmSync(join(nas.encodesDir!, '.uploads'), { recursive: true, force: true });
});

it('fetches each episode whole before its encode, uploads and deletes each MKV, and lets every clip go', async () => {
  const ids = await runNasEpisodes(options());
  expect(ids).toEqual([`${SHOW}-1`, `${SHOW}-2`]);
  // episode 1 plays clip 1; episode 2 clip 2, fetched ahead while episode 1 encoded and still whole at its encode
  expect(wholeAtEncode[0]).toContain('00001.M2TS');
  expect(wholeAtEncode[1]).toContain('00002.M2TS');
  expect(existsSync(join(nas.encodesDir!, `${SHOW}/1.mkv`))).toBe(true);
  expect(existsSync(join(nas.encodesDir!, `${SHOW}/2.mkv`))).toBe(true);
  expect(existsSync(join(outDir, 'ep-1.mkv'))).toBe(false);
  expect(existsSync(join(outDir, 'ep-2.mkv'))).toBe(false);
  // clip 2 is longer than a head, and is back to its head
  expect(whole().filter((c) => c === '00002.M2TS')).toEqual([]);
  expect(HEAD_BYTES).toBeLessThan(192 * 100_000);
});

it('without upload names keeps the MKVs; without fetching works on any disc folder', async () => {
  expect(await runNasEpisodes(options({ uploadNames: null }))).toEqual([]);
  expect(existsSync(join(outDir, 'ep-1.mkv'))).toBe(true);
  expect(existsSync(join(outDir, 'ep-2.mkv'))).toBe(true);
  expect(whole().filter((c) => c === '00002.M2TS')).toEqual([]);
  rmSync(join(outDir, 'ep-1.mkv'));
  rmSync(join(outDir, 'ep-2.mkv'));
  expect(await runNasEpisodes(options({ fetchClips: false, discDir: fx('fixtures/disc-speech') }))).toEqual([`${SHOW}-1`, `${SHOW}-2`]);
});

it('a refused upload stops the loop with the MKV kept, and lets every clip go', async () => {
  const failure = await runNasEpisodes(
    options({
      encode: (index) => {
        wholeAtEncode.push(whole());
        const path = join(outDir, `ep-${index}.mkv`);
        writeFileSync(path, retagged(SHOW, index, { noAniList: true }));
        return Promise.resolve(path);
      },
    }),
  ).catch((e: unknown) => e);
  expect(failure).toBeInstanceOf(NasUploadFailed);
  expect((failure as NasUploadFailed).episode).toBe(1);
  expect((failure as NasUploadFailed).path).toBe(join(outDir, 'ep-1.mkv'));
  expect(existsSync(join(outDir, 'ep-1.mkv'))).toBe(true);
  expect(wholeAtEncode).toHaveLength(1);
  // the fetch that ran ahead for episode 2 was let go of too
  expect(whole().filter((c) => c === '00002.M2TS')).toEqual([]);
});

it('an abort during an upload stops the loop with the MKV kept', async () => {
  const stop = new AbortController();
  const failure = await runNasEpisodes(
    options({
      signal: stop.signal,
      encode: (index) => {
        const path = join(outDir, `ep-${index}.mkv`);
        writeFileSync(path, retagged(SHOW, index));
        stop.abort();
        return Promise.resolve(path);
      },
    }),
  ).catch((e: unknown) => e);
  expect(failure).toBeInstanceOf(NasUploadFailed);
  expect([(failure as NasUploadFailed).episode, (failure as NasUploadFailed).path]).toEqual([1, join(outDir, 'ep-1.mkv')]);
  expect(existsSync(join(outDir, 'ep-1.mkv'))).toBe(true);
  expect(whole().filter((c) => c === '00002.M2TS')).toEqual([]);
});

it('a failed encode and an abort let every clip go', async () => {
  await expect(runNasEpisodes(options({ encode: () => Promise.reject(new Error('svt failed')) }))).rejects.toThrow('svt failed');
  expect(whole().filter((c) => c === '00002.M2TS')).toEqual([]);
  const stop = new AbortController();
  const stopped = runNasEpisodes(
    options({
      signal: stop.signal,
      encode: () => {
        stop.abort();
        return Promise.reject(new DOMException('Stopped', 'AbortError'));
      },
    }),
  );
  await expect(stopped).rejects.toThrow('Stopped');
  expect(whole().filter((c) => c === '00002.M2TS')).toEqual([]);
});

it('with `only` fetches, encodes and uploads just those episodes', async () => {
  const encoded: number[] = [];
  const base = options({
    only: [2],
    uploadNames: [`${SHOW}-2.mkv`],
    encode: (index) => {
      encoded.push(index);
      wholeAtEncode.push(whole());
      const path = join(outDir, `ep-${index}.mkv`);
      writeFileSync(path, retagged(SHOW, index));
      return Promise.resolve(path);
    },
  });
  expect(await runNasEpisodes(base)).toEqual([`${SHOW}-2`]);
  expect(encoded).toEqual([2]);
  expect(wholeAtEncode[0]).toContain('00002.M2TS');
  expect(wholeAtEncode[0]).not.toContain('00001.M2TS');
  expect(existsSync(join(nas.encodesDir!, `${SHOW}/2.mkv`))).toBe(true);
  expect(existsSync(join(nas.encodesDir!, `${SHOW}/1.mkv`))).toBe(false);
});
