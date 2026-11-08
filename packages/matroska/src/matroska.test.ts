// SPDX-License-Identifier: LGPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import { blocksInOrder, find, findAll, parseMkv, stringOf, uintOf } from './ebml-reader';
import { Id } from './ids';
import { MkvReadError, NotMatroskaError, readMatroska, type MkvBlock } from './reader';
import { memoryReader, memorySink } from './test-io';
import { writeMatroska, type MkvInput } from './writer';

const enc = new TextEncoder();

async function* of<T>(items: T[]): AsyncGenerator<T> {
  for (const i of items) yield i;
}

function input(over: Partial<MkvInput> = {}): MkvInput {
  return {
    title: 'Starfall Wanderer 01',
    video: { width: 64, height: 48, fpsNum: 25, fpsDen: 1, codecPrivate: new Uint8Array([0x81, 0, 0, 0]), name: 'Video', language: 'und', isDefault: true },
    videoPackets: of(Array.from({ length: 10 }, (_, i) => ({ index: i, keyframe: i % 5 === 0, data: new Uint8Array([i, i]) }))),
    audio: [
      {
        name: 'Japanese',
        language: 'jpn',
        isDefault: true,
        channels: 2,
        sampleRate: 48000,
        codecPrivate: enc.encode('OpusHead'),
        codecDelayNs: 6_500_000n,
        seekPreRollNs: 80_000_000n,
        packets: of(Array.from({ length: 20 }, (_, i) => ({ data: new Uint8Array([0xa0, i]), pts48: i * 960, durationSamples: 960 }))),
        end: Promise.resolve({ discardPadding48: 0 }),
      },
    ],
    subtitles: [
      {
        name: 'English',
        language: 'eng',
        isDefault: true,
        codecId: 'S_TEXT/ASS',
        codecPrivate: enc.encode('[Script Info]\n'),
        blocks: [
          { timeMs: 0, durationMs: 800, data: enc.encode('0,0,Default,,0,0,0,,The wanderer wakes') },
          { timeMs: 100, durationMs: 200, data: enc.encode('1,0,Default,,0,0,0,,Starfall') },
        ],
      },
    ],
    attachments: [{ name: 'StarfallSans.ttf', mediaType: 'font/ttf', data: new Uint8Array([0, 1, 0, 0, 7]) }],
    chapters: [
      { title: 'Opening', startNs: 0n },
      { title: 'Part A', startNs: 200_000_000n },
    ],
    ...over,
  };
}

async function written(over: Partial<MkvInput> = {}): Promise<Uint8Array> {
  const sink = memorySink();
  await writeMatroska(sink, input(over));
  return sink.bytes();
}

async function allBlocks(bytes: Uint8Array): Promise<MkvBlock[]> {
  const out: MkvBlock[] = [];
  for await (const b of (await readMatroska(memoryReader(bytes))).blocks()) out.push(b);
  return out;
}

describe('writeMatroska and readMatroska', () => {
  it('a file written through the sink reads back with its tracks, attachments and chapters', async () => {
    const sink = memorySink();
    const result = await writeMatroska(sink, input());
    expect(result.videoPackets).toBe(10);
    expect(result.audioPackets).toEqual([20]);
    expect(result.subtitleBlocks).toEqual([2]);
    const mkv = await readMatroska(memoryReader(sink.bytes()));
    expect(mkv.docType).toBe('matroska');
    expect(mkv.title).toBe('Starfall Wanderer 01');
    expect(mkv.durationMs).toBeCloseTo(Number(result.durationNs) / 1e6, 3);
    expect(mkv.durationMs).toBeCloseTo(400, 3);
    expect(mkv.tracks.map((t) => [t.number, t.type, t.codecId, t.name, t.language])).toEqual([
      [1, 1, 'V_AV1', 'Video', 'und'],
      [2, 2, 'A_OPUS', 'Japanese', 'jpn'],
      [3, 17, 'S_TEXT/ASS', 'English', 'eng'],
    ]);
    expect(mkv.tracks[0]!.video).toEqual({ width: 64, height: 48 });
    expect(mkv.tracks[1]!.audio).toEqual({ channels: 2, sampleRate: 48000 });
    expect(mkv.tracks[1]!.codecDelayNs).toBe(6_500_000n);
    expect(mkv.attachments).toEqual([{ name: 'StarfallSans.ttf', mediaType: 'font/ttf', data: new Uint8Array([0, 1, 0, 0, 7]) }]);
    expect(mkv.chapters).toEqual([
      { title: 'Opening', startNs: 0n },
      { title: 'Part A', startNs: 200_000_000n },
    ]);
  });

  it('blocks come back in timestamp order with their data and flags', async () => {
    const blocks = await allBlocks(await written());
    expect(blocks).toHaveLength(32);
    for (let i = 1; i < blocks.length; i++) expect(blocks[i]!.timeMs).toBeGreaterThanOrEqual(blocks[i - 1]!.timeMs);
    const video = blocks.filter((b) => b.track === 1);
    expect(video.map((b) => b.timeMs)).toEqual([0, 40, 80, 120, 160, 200, 240, 280, 320, 360]);
    expect(video.map((b) => b.keyframe)).toEqual([true, false, false, false, false, true, false, false, false, false]);
    expect([...video[3]!.data]).toEqual([3, 3]);
    const sub = blocks.filter((b) => b.track === 3);
    expect(sub.map((b) => [b.timeMs, b.durationMs])).toEqual([[0, 800], [100, 200]]);
    expect(new TextDecoder().decode(sub[1]!.data)).toBe('1,0,Default,,0,0,0,,Starfall');
  });

  it('reads one cluster at a time', async () => {
    const bytes = await written();
    const reader = memoryReader(bytes);
    const mkv = await readMatroska(reader);
    const afterOpen = reader.reads;
    let n = 0;
    for await (const b of mkv.blocks()) {
      void b;
      n++;
    }
    expect(n).toBe(32);
    expect(reader.reads - afterOpen).toBe(2);
    expect(reader.maxRead).toBeLessThan(bytes.length);
  });

  it('patches only the reserved places near the start of the file', async () => {
    const patches: number[] = [];
    const inner = memorySink();
    await writeMatroska(
      {
        write: (b) => inner.write(b),
        async writeAt(p, b) {
          patches.push(p);
          return inner.writeAt(p, b);
        },
        close: () => inner.close(),
      },
      input(),
    );
    expect(patches).toHaveLength(3);
    for (const p of patches) expect(p).toBeLessThan(400);
  });

  it('closes the sink once written, and when writing fails', async () => {
    let closed = 0;
    const base = memorySink();
    const sink = { ...base, close: async () => void closed++ };
    await writeMatroska(sink, input());
    expect(closed).toBe(1);
    await expect(writeMatroska(sink, input({ videoPackets: of([]) }))).rejects.toThrow('no video packets');
    expect(closed).toBe(2);
  });

  it('a WebM file has no subtitles or attachments and reads back as webm', async () => {
    await expect(writeMatroska(memorySink(), input({ docType: 'webm' }))).rejects.toThrow(/WebM/);
    const bytes = await written({ docType: 'webm', subtitles: [], attachments: [] });
    expect((await readMatroska(memoryReader(bytes))).docType).toBe('webm');
  });

  it('the EBML tree reader sees the same tracks and cues', async () => {
    const tree = parseMkv(await written());
    expect(stringOf(find(tree, Id.DocType))).toBe('matroska');
    expect(findAll(tree, Id.TrackEntry)).toHaveLength(3);
    expect(findAll(tree, Id.CuePoint).length).toBeGreaterThan(0);
    expect(uintOf(find(tree, Id.TimestampScale))).toBe(1_000_000n);
    expect(blocksInOrder(tree)).toHaveLength(32);
  });

  it('refuses what is not Matroska, or is cut short', async () => {
    await expect(readMatroska(memoryReader(enc.encode('not a matroska file at all')))).rejects.toThrow(NotMatroskaError);
    await expect(readMatroska(memoryReader(new Uint8Array(0)))).rejects.toThrow(NotMatroskaError);
    const bytes = await written();
    await expect(readMatroska(memoryReader(bytes.slice(0, bytes.length - 40)))).rejects.toThrow(MkvReadError);
  });
});
