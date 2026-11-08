// SPDX-License-Identifier: LGPL-3.0-or-later
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { MkvReadError, NotMatroskaError, type MkvBlock, type ParsedMkv } from '@seikou/matroska';
import { readMkv } from '../../src/mux/mkv-file';
import { blocksInOrder, parseMkv } from '../helpers/ebml-reader';
import { FONT, PGS_SET, writeEpisodeMkv } from './episode-mkv';

describe('readMkv', () => {
  const dir = mkdtempSync(join(tmpdir(), 'seikou-mkv-reader-'));
  const path = join(dir, 'ep.mkv');
  let mkv: ParsedMkv;
  let blocks: MkvBlock[];

  beforeAll(async () => {
    await writeEpisodeMkv(path);
    mkv = await readMkv(path);
    blocks = [];
    for await (const b of mkv.blocks()) blocks.push(b);
  });

  afterAll(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('reads the header elements', () => {
    expect(mkv.docType).toBe('matroska');
    expect(mkv.title).toBe('Starfall Wanderer - 01');
    expect(mkv.durationMs).toBeGreaterThan(400);
    expect(mkv.tracks.map((t) => [t.number, t.codecId, t.name, t.language, t.isDefault, t.isForced])).toEqual([
      [1, 'V_AV1', 'Starfall Wanderer', 'jpn', true, false],
      [2, 'A_OPUS', 'Japanese', 'jpn', true, false],
      [3, 'A_OPUS', 'Commentary', 'eng', false, false],
      [4, 'S_TEXT/ASS', 'English (Starfall Subs)', 'eng', true, false],
      [5, 'S_TEXT/ASS', 'Signs (Starfall Subs)', 'eng', false, true],
      [6, 'S_HDMV/PGS', 'Japanese (disc)', 'jpn', false, false],
    ]);
    expect(mkv.tracks[0]!.video).toEqual({ width: 64, height: 64 });
    expect(mkv.tracks[0]!.defaultDurationNs).toBe(41_708_333n);
    expect(mkv.tracks[1]!.audio).toEqual({ channels: 2, sampleRate: 48000 });
    expect(mkv.tracks[1]!.seekPreRollNs).toBe(80_000_000n);
    expect(mkv.tracks[1]!.codecDelayNs).toBeGreaterThan(0n);
    expect(mkv.attachments).toEqual([{ name: 'StarfallSans.ttf', mediaType: 'font/ttf', data: FONT }]);
    expect(mkv.chapters).toEqual([
      { title: 'Cold open', startNs: 0n },
      { title: 'Part <A> & B', startNs: 250_250_000n },
    ]);
  });

  it('streams every block in file order with its time, key-frame flag and duration', () => {
    const expected = blocksInOrder(parseMkv(readFileSync(path)));
    expect(blocks.map((b) => [b.track, b.timeMs, b.durationMs, Buffer.from(b.data).toString('hex')])).toEqual(
      expected.map((b) => [b.track, b.timeMs, b.durationMs, Buffer.from(b.data).toString('hex')]),
    );
    expect(blocks.find((b) => b.track === 1)!.keyframe).toBe(true);
    expect(blocks.filter((b) => b.track === 6).map((b) => [b.timeMs, Buffer.from(b.data)])).toEqual([
      [50, Buffer.from(PGS_SET)],
      [260, Buffer.from(PGS_SET)],
    ]);
  });

  it('refuses a file that is not EBML, and EBML that is not Matroska', async () => {
    const wav = join(dir, 'a.wav');
    writeFileSync(wav, 'RIFF....WAVEfmt ');
    await expect(readMkv(wav)).rejects.toBeInstanceOf(NotMatroskaError);
    // An EBML header whose DocType is something else.
    const other = join(dir, 'other.ebml');
    const docType = Buffer.from('notmkv');
    const body = Buffer.concat([Buffer.from([0x42, 0x82, 0x80 | docType.length]), docType]);
    writeFileSync(other, Buffer.concat([Buffer.from([0x1a, 0x45, 0xdf, 0xa3, 0x80 | body.length]), body]));
    await expect(readMkv(other)).rejects.toBeInstanceOf(NotMatroskaError);
    const empty = join(dir, 'empty.mkv');
    writeFileSync(empty, '');
    await expect(readMkv(empty)).rejects.toBeInstanceOf(NotMatroskaError);
  });

  it('reports a truncated file as an MkvReadError', async () => {
    const cut = join(dir, 'cut.mkv');
    const whole = readFileSync(path);
    writeFileSync(cut, whole.subarray(0, whole.length - 40));
    const read = async (): Promise<void> => {
      const m = await readMkv(cut);
      for await (const b of m.blocks()) void b;
    };
    await expect(read()).rejects.toBeInstanceOf(MkvReadError);
  });
});
