// SPDX-License-Identifier: LGPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import { blobRangeReader } from './blob-reader';
import { findAll, find, parseMkv } from './ebml-reader';
import { Id } from './ids';
import type { RangeReader } from './io';
import { openMatroska } from './playback';
import { MkvReadError, NotMatroskaError, readMatroska, type MkvBlock } from './reader';
import { memoryReader, memorySink } from './test-io';
import { writeMatroska, type MkvInput, type MkvSubtitleTrack } from './writer';

const enc = new TextEncoder();
const FONT = Uint8Array.from({ length: 4000 }, (_, i) => i % 251);

async function* of<T>(items: T[]): AsyncGenerator<T> {
  for (const i of items) yield i;
}

function subtitles(blocks: MkvSubtitleTrack['blocks']): MkvSubtitleTrack[] {
  return [{ name: 'English', language: 'eng', isDefault: true, codecId: 'S_TEXT/ASS', codecPrivate: enc.encode('[Script Info]\n'), blocks }];
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
    subtitles: subtitles([{ timeMs: 0, durationMs: 800, data: enc.encode('0,0,Default,,0,0,0,,The wanderer wakes') }]),
    attachments: [{ name: 'StarfallSans.ttf', mediaType: 'font/ttf', data: FONT }],
    chapters: [
      { title: 'Opening', startNs: 0n },
      { title: 'Part A', startNs: 200_000_000n, endNs: 400_000_000n },
    ],
    tags: { TITLE: 'Starfall Wanderer', EPISODE: '1' },
    ...over,
  };
}

async function written(over: Partial<MkvInput> = {}): Promise<Uint8Array> {
  const sink = memorySink();
  await writeMatroska(sink, input(over));
  return sink.bytes();
}

async function collect(it: AsyncIterable<MkvBlock>): Promise<MkvBlock[]> {
  const out: MkvBlock[] = [];
  for await (const b of it) out.push(b);
  return out;
}

/** A reader that records every read. */
function countingReader(bytes: Uint8Array): RangeReader & { log: { offset: number; length: number }[] } {
  const inner = memoryReader(bytes);
  const log: { offset: number; length: number }[] = [];
  return {
    size: inner.size,
    log,
    async read(offset, length, signal) {
      log.push({ offset, length });
      return inner.read(offset, length, signal);
    },
  };
}

/** Overwrites the 4 bytes of the id of the first element `id` with an id nothing uses. */
function breakId(bytes: Uint8Array, id: number): Uint8Array {
  const out = bytes.slice();
  const node = findAll(parseMkv(bytes), id)[0]!;
  out.set([0x1b, 0x53, 0xbb, 0x6c], node.offset);
  return out;
}

describe('openMatroska', () => {
  it('opens a written file and reads tracks, attachments, chapter names, tags and duration without reading clusters', async () => {
    const bytes = await written();
    const tree = parseMkv(bytes);
    const firstCluster = findAll(tree, Id.Cluster)[0]!;
    const cues = findAll(tree, Id.Cues)[0]!;
    const reader = countingReader(bytes);
    const mkv = await openMatroska(reader);

    for (const r of reader.log) {
      const inCues = r.offset >= cues.offset;
      expect(inCues || r.offset + r.length <= firstCluster.offset, `read of ${r.length} bytes at ${r.offset}`).toBe(true);
    }
    expect(mkv.durationMs).toBeCloseTo(400, 3);
    expect(mkv.tracks.map((t) => [t.number, t.type, t.codecId, t.name, t.language])).toEqual([
      [1, 1, 'V_AV1', 'Video', 'und'],
      [2, 2, 'A_OPUS', 'Japanese', 'jpn'],
      [3, 17, 'S_TEXT/ASS', 'English', 'eng'],
    ]);
    expect(mkv.chapters).toEqual([
      { startMs: 0, endMs: null, name: 'Opening' },
      { startMs: 200, endMs: 400, name: 'Part A' },
    ]);
    expect(mkv.tags).toEqual({ TITLE: 'Starfall Wanderer', EPISODE: '1' });
    expect(mkv.attachments.map((a) => [a.name, a.mediaType])).toEqual([['StarfallSans.ttf', 'font/ttf']]);
  });

  it('reads an attachment only when asked', async () => {
    const reader = countingReader(await written());
    const mkv = await openMatroska(reader);
    expect(Math.max(...reader.log.map((r) => r.length))).toBeLessThan(FONT.length);
    const before = reader.log.length;
    expect([...(await mkv.attachments[0]!.data())]).toEqual([...FONT]);
    expect(reader.log).toHaveLength(before + 1);
  });

  it('tags written through MkvInput.tags read back, and a file without tags has none', async () => {
    expect((await openMatroska(memoryReader(await written({ tags: { 'ÉPISODE': 'Ünï', K: 'v' } })))).tags).toEqual({ 'ÉPISODE': 'Ünï', K: 'v' });
    expect((await openMatroska(memoryReader(await written({ tags: undefined })))).tags).toEqual({});
    expect((await openMatroska(memoryReader(await written({ tags: {} })))).tags).toEqual({});
  });

  it('blocksFrom starts at the video key frame at or before the time', async () => {
    const mkv = await openMatroska(memoryReader(await written({ subtitles: subtitles([{ timeMs: 0, durationMs: 100, data: enc.encode('a') }]) })));
    const all = await collect(mkv.blocksFrom(0));
    expect(all).toHaveLength(31);
    const from = await collect(mkv.blocksFrom(250));
    expect(from[0]).toMatchObject({ track: 1, timeMs: 200, keyframe: true });
    expect(from.some((b) => b.timeMs < 200)).toBe(false);
    expect(from).toHaveLength(all.filter((b) => b.timeMs >= 200).length);
    const early = await collect(mkv.blocksFrom(-50));
    expect(early[0]).toMatchObject({ track: 1, timeMs: 0 });
    expect(await collect(mkv.blocksFrom(5000))).toHaveLength(from.length);
  });

  it('blocksFrom includes a subtitle block that started before the seek time and is still on screen', async () => {
    const mkv = await openMatroska(memoryReader(await written()));
    const from = await collect(mkv.blocksFrom(250));
    expect(from[0]!.timeMs).toBe(0);
    expect(from.some((b) => b.track === 3 && b.timeMs === 0 && b.durationMs === 800)).toBe(true);
    // The event ends at 800: a seek past it starts at the video's key frame alone.
    const late = await openMatroska(memoryReader(await written({ subtitles: subtitles([{ timeMs: 0, durationMs: 250, data: enc.encode('a') }]) })));
    expect((await collect(late.blocksFrom(250)))[0]!.timeMs).toBe(200);
    expect((await collect(late.blocksFrom(249)))[0]!.timeMs).toBe(0);
  });

  it('splits Xiph, EBML and fixed laced blocks', async () => {
    const xiph = Uint8Array.from([2, 3, 2, 0xa1, 0xa1, 0xa1, 0xb1, 0xb1, 0xc1, 0xc1, 0xc1, 0xc1]);
    const fixed = Uint8Array.from([1, 0x91, 0x91, 0x81, 0x81]);
    const ebml = Uint8Array.from([2, 0x82, 0xc0, 0x61, 0x61, 0x62, 0x62, 0x62, 0x63]);
    const packets = Array.from({ length: 10 }, (_, i) => ({
      index: i,
      keyframe: i % 5 === 0,
      data: i === 1 ? xiph : i === 2 ? fixed : new Uint8Array([i, i]),
    }));
    const bytes = (await written({ videoPackets: of(packets), subtitles: subtitles([{ timeMs: 0, durationMs: 300, data: ebml }]) })).slice();
    const tree = parseMkv(bytes);
    const flagsOf = (node: { offset: number; headerLength: number }): number => node.offset + node.headerLength + 3;
    const video = findAll(tree, Id.SimpleBlock).filter((b) => b.bytes![0] === 0x81);
    bytes[flagsOf(video[1]!)]! |= 0x02;
    bytes[flagsOf(video[2]!)]! |= 0x04;
    bytes[flagsOf(findAll(tree, Id.Block)[0]!)]! |= 0x06;

    const mkv = await openMatroska(memoryReader(bytes));
    const blocks = await collect(mkv.blocksFrom(0));
    const text = (b: MkvBlock): number[] => [...b.data];
    const v = blocks.filter((b) => b.track === 1);
    // The video track's DefaultDuration is 40 ms, which spaces the frames of a laced block.
    expect(v.filter((b) => [0xa1, 0xb1, 0xc1].includes(b.data[0]!)).map((b) => [b.timeMs, text(b)])).toEqual([
      [40, [0xa1, 0xa1, 0xa1]],
      [80, [0xb1, 0xb1]],
      [120, [0xc1, 0xc1, 0xc1, 0xc1]],
    ]);
    expect(v.filter((b) => b.data[0] === 0x91 || b.data[0] === 0x81).map((b) => [b.timeMs, text(b)])).toEqual([
      [80, [0x91, 0x91]],
      [120, [0x81, 0x81]],
    ]);
    const sub = blocks.filter((b) => b.track === 3);
    expect(sub.map((b) => [b.timeMs, b.durationMs, new TextDecoder().decode(b.data)])).toEqual([
      [0, 100, 'aa'],
      [100, 100, 'bbb'],
      [200, 100, 'c'],
    ]);
  });

  it('splits a Xiph frame of 255 bytes or more and an EBML size with a negative delta', async () => {
    const big = Uint8Array.from({ length: 300 }, (_, i) => i % 200);
    const small = Uint8Array.from([7, 7, 7, 7, 7]);
    const xiph = Uint8Array.from([1, 255, 45, ...big, ...small]);
    const ebml = Uint8Array.from([2, 0x85, 0xbd, 1, 1, 1, 1, 1, 2, 2, 2, 3, 3]);
    const packets = Array.from({ length: 10 }, (_, i) => ({ index: i, keyframe: i % 5 === 0, data: i === 1 ? xiph : new Uint8Array([i, i]) }));
    const bytes = (await written({ videoPackets: of(packets), subtitles: subtitles([{ timeMs: 0, durationMs: 300, data: ebml }]) })).slice();
    const tree = parseMkv(bytes);
    const video = findAll(tree, Id.SimpleBlock).filter((b) => b.bytes![0] === 0x81);
    bytes[video[1]!.offset + video[1]!.headerLength + 3]! |= 0x02;
    bytes[findAll(tree, Id.Block)[0]!.offset + findAll(tree, Id.Block)[0]!.headerLength + 3]! |= 0x06;
    const blocks = await collect((await openMatroska(memoryReader(bytes))).blocksFrom(0));
    const laced = blocks.filter((b) => b.track === 1 && b.frameCount !== undefined);
    expect(laced.map((b) => [b.timeMs, b.frameIndex, b.frameCount, b.data.length])).toEqual([[40, 0, 2, 300], [80, 1, 2, 5]]);
    expect([...laced[0]!.data]).toEqual([...big]);
    const sub = blocks.filter((b) => b.track === 3);
    expect(sub.map((b) => [b.frameIndex, b.frameCount, [...b.data]])).toEqual([
      [0, 3, [1, 1, 1, 1, 1]],
      [1, 3, [2, 2, 2]],
      [2, 3, [3, 3]],
    ]);
    expect(blocks.filter((b) => b.track === 2).every((b) => b.frameIndex === undefined && b.frameCount === undefined)).toBe(true);
  });

  it('a file without Cues seeks by scanning', async () => {
    const bytes = breakId(await written(), Id.Cues);
    const mkv = await openMatroska(memoryReader(bytes));
    const from = await collect(mkv.blocksFrom(250));
    expect(from[0]!.timeMs).toBe(0);
    expect(from.some((b) => b.track === 3 && b.durationMs === 800)).toBe(true);
    const late = await openMatroska(memoryReader(breakId(await written({ subtitles: subtitles([{ timeMs: 0, durationMs: 100, data: enc.encode('a') }]) }), Id.Cues)));
    expect((await collect(late.blocksFrom(250)))[0]).toMatchObject({ track: 1, timeMs: 200, keyframe: true });
    expect(await collect(late.blocksFrom(0))).toHaveLength(31);
    expect(mkv.durationMs).toBeCloseTo(400, 3);
  });

  it('a file without a SeekHead is scanned for its parts, and Cues still seek', async () => {
    const bytes = breakId(await written(), Id.SeekHead);
    const reader = countingReader(bytes);
    const mkv = await openMatroska(reader);
    expect(mkv.chapters).toHaveLength(2);
    expect(mkv.tags.EPISODE).toBe('1');
    expect(mkv.attachments).toHaveLength(1);
    expect(mkv.tracks).toHaveLength(3);
    expect((await collect(mkv.blocksFrom(250)))[0]!.timeMs).toBe(0);
    const late = await openMatroska(memoryReader(breakId(await written({ subtitles: subtitles([{ timeMs: 0, durationMs: 100, data: enc.encode('a') }]) }), Id.SeekHead)));
    expect((await collect(late.blocksFrom(250)))[0]).toMatchObject({ track: 1, timeMs: 200 });
  });

  it('honours an abort signal between reads', async () => {
    const mkv = await openMatroska(memoryReader(await written()));
    const ac = new AbortController();
    const it = mkv.blocksFrom(0, ac.signal)[Symbol.asyncIterator]();
    await it.next();
    ac.abort(new Error('stop'));
    // The first cluster's blocks are already read; the next read throws.
    await expect((async () => { for (;;) if ((await it.next()).done === true) return; })()).rejects.toThrow('stop');
    const aborted = AbortSignal.abort(new Error('never opened'));
    await expect(openMatroska(memoryReader(await written()), aborted)).rejects.toThrow('never opened');
  });

  it('a later blocksFrom is not stopped by the signal the file was opened with', async () => {
    for (const bytes of [await written(), breakId(await written(), Id.Cues), breakId(await written(), Id.SeekHead)]) {
      const open = new AbortController();
      const mkv = await openMatroska(memoryReader(bytes), open.signal);
      open.abort(new Error('open is over'));
      const own = new AbortController();
      expect((await collect(mkv.blocksFrom(250, own.signal)))[0]!.timeMs).toBe(0);
      expect(await collect(mkv.blocksFrom(250))).not.toHaveLength(0);
    }
  });

  it('refuses an element too large to read whole, naming it', async () => {
    const bytes = await written({ tags: { BIG: 'a'.repeat(65 * 1024 * 1024) } });
    await expect(openMatroska(memoryReader(bytes))).rejects.toThrow(/Tags element/);
  }, 30_000);

  it('refuses an oversized cluster in the scanning slow path', async () => {
    const bytes = breakId(await written(), Id.Cues);
    const cluster = findAll(parseMkv(bytes), Id.Cluster)[0]!;
    // Declare the first cluster 2 GiB: the scan must refuse it before reading.
    bytes.set([0x01, 0x00, 0x00, 0x00, 0x80, 0x00, 0x00, 0x00], cluster.offset + cluster.headerLength - 8);
    const mkv = await openMatroska(memoryReader(bytes)).catch((e: unknown) => e);
    // The oversized cluster runs past the Segment, so opening may refuse it first; either way it is an MkvReadError.
    expect(mkv).toBeInstanceOf(MkvReadError);
  });

  it('refuses what is not Matroska and names the source in errors', async () => {
    const named = (bytes: Uint8Array): RangeReader => ({ ...memoryReader(bytes), size: bytes.length, name: '/discs/Starfall/ep01.mkv', read: memoryReader(bytes).read });
    await expect(openMatroska(named(enc.encode('not a matroska file at all')))).rejects.toThrow(NotMatroskaError);
    await expect(openMatroska(named(enc.encode('not a matroska file at all')))).rejects.toThrow('/discs/Starfall/ep01.mkv');
    const bytes = await written();
    await expect(openMatroska(named(bytes.slice(0, bytes.length - 40)))).rejects.toThrow(MkvReadError);
  });

  it('reads through a Blob', async () => {
    const bytes = await written();
    const mkv = await openMatroska(blobRangeReader(new Blob([bytes as BlobPart])));
    expect(mkv.chapters).toHaveLength(2);
    expect((await collect(mkv.blocksFrom(250)))[0]!.timeMs).toBe(0);
    expect(blobRangeReader(new Blob([bytes as BlobPart])).name).toBeUndefined();
    expect(blobRangeReader(new File([bytes as BlobPart], 'ep01.mkv')).name).toBe('ep01.mkv');
    expect(find(parseMkv(bytes), Id.Tags)).toBeDefined();
  });
});

describe('readMatroska refusals', () => {
  it('refuses a laced block', async () => {
    const bytes = (await written()).slice();
    const tree = parseMkv(bytes);
    const block = findAll(tree, Id.SimpleBlock)[0]!;
    bytes[block.offset + block.headerLength + 3]! |= 0x02;
    const mkv = await readMatroska(memoryReader(bytes));
    await expect(collect(mkv.blocks())).rejects.toThrow(/lacing/);
  });

  it('refuses an element of unknown size at the top level', async () => {
    const bytes = (await written()).slice();
    const cluster = findAll(parseMkv(bytes), Id.Cluster)[0]!;
    // The cluster's 8-byte size field, all ones.
    bytes.set([0x01, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff], cluster.offset + cluster.headerLength - 8);
    await expect(readMatroska(memoryReader(bytes))).rejects.toThrow(/unknown size/);
    const opened = await openMatroska(memoryReader(bytes));
    await expect(collect(opened.blocksFrom(0))).rejects.toThrow(/unknown size/);
  });

  it('names the source in its errors', async () => {
    const bytes = await written();
    const reader: RangeReader = { size: bytes.length - 40, name: 'ep01.mkv', read: memoryReader(bytes).read };
    await expect(readMatroska(reader)).rejects.toThrow('ep01.mkv');
  });
});
