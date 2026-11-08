// SPDX-License-Identifier: LGPL-3.0-or-later
import { createReadStream, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { readIvf, type Av1Packet } from '../../src/mux/ivf';
import { readMkv } from '../../src/mux/mkv-file';
import { type MkvAudioTrack } from '@seikou/matroska';
import { writeMkv } from '../../src/mux/mkv-file';
import { readOggOpus, type OpusPacket } from '../../src/mux/ogg';
import { Id } from '@seikou/matroska';
import { countBlocks, WebmError, writeWebm } from '../../src/package/webm';
import { blocksInOrder, findAll, parseMkv, uintOf } from '../helpers/ebml-reader';
import { fx } from '../paths';

/** The fixture video's packets repeated `times` times, numbered on: about 0.42 s per repeat. */
async function videoPackets(times: number): Promise<{ packets: Av1Packet[]; av1C: Uint8Array }> {
  const ivf = await readIvf(createReadStream(fx('fixtures/small.ivf')));
  const av1C = (await ivf.sequenceHeader).av1C;
  const one: Av1Packet[] = [];
  for await (const p of ivf.packets) one.push(p);
  const packets: Av1Packet[] = [];
  for (let r = 0; r < times; r++) for (const p of one) packets.push({ ...p, index: packets.length });
  return { packets, av1C };
}

/** An Opus track of the fixture tone's packets repeated `times` times, starting `startMs` in. */
async function opusTrack(name: string, times: number, startMs: number): Promise<MkvAudioTrack> {
  const ogg = await readOggOpus(createReadStream(fx('fixtures/tone.opus')));
  const one: OpusPacket[] = [];
  for await (const p of ogg.packets) one.push(p);
  const packets: OpusPacket[] = [];
  let pts48 = startMs * 48;
  for (let r = 0; r < times; r++) {
    for (const p of one) {
      packets.push({ ...p, pts48 });
      pts48 += p.durationSamples;
    }
  }
  return {
    channels: 2,
    sampleRate: 48000,
    codecPrivate: ogg.head.raw,
    codecDelayNs: (BigInt(ogg.head.preSkip) * 1_000_000_000n) / 48000n,
    seekPreRollNs: 80_000_000n,
    name,
    language: 'jpn',
    isDefault: name === 'Main',
    packets: (async function* () {
      yield* packets;
    })(),
    end: Promise.resolve({ discardPadding48: 0 }),
  };
}

async function writeSource(path: string, second: { times: number; startMs: number }): Promise<void> {
  const { packets, av1C } = await videoPackets(30);
  await writeMkv(path, {
    title: 'Starfall Wanderer - 02',
    video: { width: 64, height: 64, fpsNum: 24000, fpsDen: 1001, codecPrivate: av1C, name: '', language: 'und', isDefault: true },
    videoPackets: (async function* () {
      yield* packets;
    })(),
    audio: [await opusTrack('Main', 25, 0), await opusTrack('Short', second.times, second.startMs)],
    subtitles: [],
    attachments: [],
    chapters: [],
  });
}

describe('writeWebm queueing', () => {
  const dir = mkdtempSync(join(tmpdir(), 'seikou-webm-'));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));
  // Ample for blocks that interleave, a small part of what reading on to the end of the file would hold.
  const CAP = 8 * 1024;

  it('remuxes an Opus track that ends long before the video with only a few blocks waiting', async () => {
    const src = join(dir, 'short-audio.mkv');
    // The video and the main track last about 12.5 s; the second track ends after 0.5 s.
    await writeSource(src, { times: 1, startMs: 0 });
    const mkv = await readMkv(src);
    const counts = await countBlocks(mkv);
    expect(readFileSync(src).length).toBeGreaterThan(10 * CAP);
    const out = join(dir, 'short-audio.webm');
    await writeWebm(mkv, out, { blockCounts: counts, maxQueuedBytes: CAP });
    const blocks = blocksInOrder(parseMkv(readFileSync(out)));
    expect([1, 2, 3].map((t) => blocks.filter((b) => b.track === t).length)).toEqual([1, 2, 3].map((t) => counts.get(t)));
    // Without the counts it counts them itself, with the same cap.
    await writeWebm(mkv, join(dir, 'short-audio-2.webm'), { maxQueuedBytes: CAP });
    expect(findAll(parseMkv(readFileSync(join(dir, 'short-audio-2.webm'))), Id.TrackNumber).map(uintOf)).toEqual([1n, 2n, 3n]);
  });

  it('throws WebmError when an Opus track starts so late that too much would wait', async () => {
    const src = join(dir, 'late-audio.mkv');
    await writeSource(src, { times: 1, startMs: 10_000 });
    const mkv = await readMkv(src);
    await expect(writeWebm(mkv, join(dir, 'late-audio.webm'), { maxQueuedBytes: CAP })).rejects.toBeInstanceOf(WebmError);
    // The default cap takes it.
    await writeWebm(mkv, join(dir, 'late-audio.webm'));
  });
});
