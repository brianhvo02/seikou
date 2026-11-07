// SPDX-License-Identifier: LGPL-3.0-or-later
import { execFileSync } from 'node:child_process';
import { createReadStream, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { readIvf } from '../../src/mux/ivf';
import { Id } from '../../src/mux/mkv-ids';
import { writeMkv, type MkvResult } from '../../src/mux/mkv-writer';
import { readOggOpus, type OggOpusStream } from '../../src/mux/ogg';
import {
  countVideoBlocks,
  find,
  findAll,
  firstBlockIsVideoKeyframe,
  floatOf,
  parseMkv,
  segmentDataStart,
  stringOf,
  uintOf,
} from '../helpers/ebml-reader';
import { haveFfprobe } from '../helpers/tools';
import { fx } from '../paths';

describe('writeMkv', () => {
  const dir = mkdtempSync(join(tmpdir(), 'encoding-tools-mkv-'));
  const out = join(dir, 'w.mkv');
  let r: MkvResult;
  let ogg: OggOpusStream;

  beforeAll(async () => {
    const ivf = await readIvf(createReadStream(fx('fixtures/small.ivf')));
    const seq = await ivf.sequenceHeader;
    ogg = await readOggOpus(createReadStream(fx('fixtures/tone.opus')));
    r = await writeMkv(out, {
      video: { width: 64, height: 64, fpsNum: 24000, fpsDen: 1001, codecPrivate: seq.av1C },
      audio: {
        channels: 2,
        sampleRate: 48000,
        codecPrivate: ogg.head.raw,
        codecDelayNs: (BigInt(ogg.head.preSkip) * 1_000_000_000n) / 48000n,
        seekPreRollNs: 80_000_000n,
        language: 'und',
      },
      videoPackets: ivf.packets,
      audioPackets: ogg.packets,
      audioEnd: ogg.end,
      chapters: [
        { title: 'Chapter 1', startNs: 0n },
        { title: 'Chapter 2', startNs: 166_833_333n },
      ],
    });
  });

  afterAll(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('writes AV1 + Opus with chapters, clusters at keyframes, cues and patched duration', async () => {
    expect(r).toMatchObject({ videoPackets: 10, audioPackets: 26, clusters: 3 });
    const t = parseMkv(readFileSync(out));
    expect(stringOf(find(t, Id.DocType))).toBe('matroska');
    expect(findAll(t, Id.CodecID).map(stringOf)).toEqual(['V_AV1', 'A_OPUS']);
    expect(uintOf(find(t, Id.CodecDelay))).toBe((BigInt(ogg.head.preSkip) * 1_000_000_000n) / 48000n);
    expect(findAll(t, Id.ChapterTimeStart).map(uintOf)).toEqual([0n, 166_833_333n]);
    expect(findAll(t, Id.Cluster)).toHaveLength(3);
    expect(findAll(t, Id.CuePoint)).toHaveLength(3);
    expect(findAll(t, Id.CueClusterPosition).map(uintOf)).toEqual(
      findAll(t, Id.Cluster).map((c) => BigInt(c.offset - segmentDataStart(t))),
    );
    for (const cluster of findAll(t, Id.Cluster)) expect(firstBlockIsVideoKeyframe(cluster)).toBe(true);
    expect(countVideoBlocks(t)).toBe(10);
    expect(floatOf(find(t, Id.Duration))).toBeCloseTo(Number(r.durationNs) / 1e6, 3);
    expect(floatOf(find(t, Id.Duration))).toBeCloseTo(500, 1); // audio end minus the Opus pre-skip (CodecDelay)
    expect(find(t, Id.Segment).size).toBe(statSync(out).size - segmentDataStart(t));
    expect(findAll(t, Id.DiscardPadding)).toHaveLength((await ogg.end).discardPadding48 > 0 ? 1 : 0);
  });

  it('points the SeekHead at Info, Tracks, Chapters and Cues', () => {
    const t = parseMkv(readFileSync(out));
    const base = segmentDataStart(t);
    const seeks = findAll(t, Id.Seek).map((s) => ({
      id: Number(uintOf(find(s, Id.SeekID))),
      pos: Number(uintOf(find(s, Id.SeekPosition))),
    }));
    expect(seeks.map((s) => s.id)).toEqual([Id.Info, Id.Tracks, Id.Chapters, Id.Cues]);
    for (const s of seeks) expect(find(t, s.id).offset - base).toBe(s.pos);
  });

  describe.skipIf(!haveFfprobe)('ffprobe oracle', () => {
    it('sees two streams and two chapters', () => {
      const j = JSON.parse(
        execFileSync('ffprobe', ['-v', 'error', '-show_streams', '-show_chapters', '-of', 'json', out]).toString(),
      ) as { streams: { codec_name: string }[]; chapters: unknown[] };
      expect(j.streams.map((s) => s.codec_name)).toEqual(['av1', 'opus']);
      expect(j.chapters).toHaveLength(2);
    });
  });
});
