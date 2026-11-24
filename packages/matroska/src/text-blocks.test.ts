// SPDX-License-Identifier: LGPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import { findAll, parseMkv } from './ebml-reader';
import { Id } from './ids';
import type { RangeReader } from './io';
import { openMatroska } from './playback';
import type { MkvBlock } from './reader';
import { memoryReader, memorySink } from './test-io';
import { textTrackBlocks } from './text-blocks';
import { writeMatroska, type MkvSubtitleTrack } from './writer';

const enc = new TextEncoder();

async function* frames(n: number): AsyncGenerator<{ index: number; keyframe: boolean; data: Uint8Array }> {
  for (let i = 0; i < n; i++) yield { index: i, keyframe: i % 25 === 0, data: new Uint8Array(4000).fill(i & 0xff) };
}

function track(name: string, count: number, offsetMs: number): MkvSubtitleTrack {
  return {
    name,
    language: 'eng',
    isDefault: true,
    codecId: 'S_TEXT/ASS',
    codecPrivate: enc.encode('[Script Info]\n'),
    blocks: Array.from({ length: count }, (_, i) => ({
      timeMs: offsetMs + i * 500,
      durationMs: 400,
      data: enc.encode(`${i},0,Default,,0,0,0,,${name} line ${i}`),
    })),
  };
}

/** 500 video frames at 25 fps (20 s, 4000 bytes each) with the given subtitle tracks (numbers 2, 3). */
async function written(subs: MkvSubtitleTrack[]): Promise<Uint8Array> {
  const sink = memorySink();
  await writeMatroska(sink, {
    title: 'Starfall Wanderer 01',
    video: { width: 64, height: 48, fpsNum: 25, fpsDen: 1, codecPrivate: new Uint8Array([0x81, 0, 0, 0]), name: 'Video', language: 'und', isDefault: true },
    videoPackets: frames(500),
    audio: [],
    subtitles: subs,
    attachments: [],
    chapters: [],
    tags: {},
  });
  return sink.bytes();
}

/** The blocks of `tracks` by reading every cluster through `openMatroska`. */
async function reference(bytes: Uint8Array, tracks: number[]): Promise<MkvBlock[]> {
  const mkv = await openMatroska(memoryReader(bytes));
  const out: MkvBlock[] = [];
  for await (const b of mkv.blocksFrom(0)) if (tracks.includes(b.track)) out.push(b);
  return out.sort((a, b) => a.timeMs - b.timeMs);
}

function countingReader(bytes: Uint8Array): RangeReader & { total: number } {
  const inner = memoryReader(bytes);
  const r = {
    size: inner.size,
    total: 0,
    async read(offset: number, length: number, signal?: AbortSignal) {
      const got = await inner.read(offset, length, signal);
      r.total += got.length;
      return got;
    },
  };
  return r;
}

/** Edits the data of every CueTrackPositions child `id` for which `pick` is true (same length). */
function patchCues(bytes: Uint8Array, edit: (positions: ReturnType<typeof findAll>[number], out: Uint8Array) => void): Uint8Array {
  const out = bytes.slice();
  for (const n of findAll(parseMkv(bytes), Id.CueTrackPositions)) edit(n, out);
  return out;
}

describe('textTrackBlocks', () => {
  it('reads every subtitle block through the Cues when each has a relative position', async () => {
    const bytes = await written([track('English', 20, 100), track('German', 10, 300)]);
    const reader = countingReader(bytes);
    const r = await textTrackBlocks(reader, [2, 3]);
    expect(r.via).toBe('cues');
    expect(r.blocks.length).toBe(30);
    expect(r.blocks).toEqual(await reference(bytes, [2, 3]));
    expect(reader.total).toBeLessThan(bytes.length * 0.05);
    const one = await textTrackBlocks(memoryReader(bytes), [3]);
    expect(one.via).toBe('cues');
    expect(one.blocks.every((b) => b.track === 3)).toBe(true);
    expect(one.blocks.length).toBe(10);
  });

  it('walks the clusters when the Cues miss a subtitle block (a ReadOrder gap)', async () => {
    const bytes = await written([track('English', 20, 100)]);
    let hidden = false;
    const cut = patchCues(bytes, (n, out) => {
      const t = n.children!.find((c) => c.id === Id.CueTrack)!;
      const value = out[t.offset + t.headerLength]!;
      if (value === 2 && !hidden && n.children!.some((c) => c.id === Id.CueRelativePosition)) {
        hidden = true;
        out[t.offset + t.headerLength] = 9;
      }
    });
    expect(hidden).toBe(true);
    const r = await textTrackBlocks(memoryReader(cut), [2]);
    expect(r.via).toBe('walk');
    expect(r.blocks).toEqual(await reference(bytes, [2]));
  });

  it('walks the clusters when the Cues have no relative positions or no subtitle cues', async () => {
    const bytes = await written([track('English', 20, 100)]);
    const expected = await reference(bytes, [2]);
    const noRelative = patchCues(bytes, (n, out) => {
      for (const c of n.children!) if (c.id === Id.CueRelativePosition) out[c.offset] = 0xec;
    });
    const a = await textTrackBlocks(memoryReader(noRelative), [2]);
    expect(a.via).toBe('walk');
    expect(a.blocks).toEqual(expected);
    const noSubs = patchCues(bytes, (n, out) => {
      const t = n.children!.find((c) => c.id === Id.CueTrack)!;
      if (out[t.offset + t.headerLength] === 2) out[t.offset + t.headerLength] = 9;
    });
    const b = await textTrackBlocks(memoryReader(noSubs), [2]);
    expect(b.via).toBe('walk');
    expect(b.blocks).toEqual(expected);
  });

  it('walks for a track that is not ASS or SSA (no ReadOrder to check)', async () => {
    const bytes = await written([track('English', 20, 100)]);
    const patched = bytes.slice();
    const at = indexOf(patched, enc.encode('S_TEXT/ASS'));
    expect(at).toBeGreaterThan(0);
    patched.set(enc.encode('S_TEXT/UTF'), at);
    const r = await textTrackBlocks(memoryReader(patched), [2]);
    expect(r.via).toBe('walk');
    expect(r.blocks).toEqual(await reference(bytes, [2]));
  });

  it('reports progress up to the file size and stops on abort', async () => {
    const bytes = await written([track('English', 20, 100)]);
    const calls: [number, number][] = [];
    const noRelative = patchCues(bytes, (n, out) => {
      for (const c of n.children!) if (c.id === Id.CueRelativePosition) out[c.offset] = 0xec;
    });
    await textTrackBlocks(memoryReader(noRelative), [2], { onProgress: (a, b) => calls.push([a, b]) });
    expect(calls.length).toBeGreaterThan(1);
    expect(calls[calls.length - 1]).toEqual([noRelative.length, noRelative.length]);
    for (let i = 1; i < calls.length; i++) expect(calls[i]![0]).toBeGreaterThanOrEqual(calls[i - 1]![0]);

    const ac = new AbortController();
    ac.abort(new Error('stop'));
    await expect(textTrackBlocks(memoryReader(bytes), [2], { signal: ac.signal })).rejects.toThrow('stop');
  });
});

function indexOf(hay: Uint8Array, needle: Uint8Array): number {
  outer: for (let i = 0; i + needle.length <= hay.length; i++) {
    for (let j = 0; j < needle.length; j++) if (hay[i + j] !== needle[j]) continue outer;
    return i;
  }
  return -1;
}
