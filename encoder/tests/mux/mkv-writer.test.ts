// SPDX-License-Identifier: LGPL-3.0-or-later
import { execFileSync } from 'node:child_process';
import { createReadStream, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { readIvf } from '../../src/mux/ivf';
import { Id } from '../../src/mux/mkv-ids';
import { writeMkv, type MkvInput, type MkvResult } from '../../src/mux/mkv-writer';
import { readOggOpus, type OggOpusStream } from '../../src/mux/ogg';
import {
  blocksInOrder,
  countVideoBlocks,
  find,
  findAll,
  firstBlockIsVideoKeyframe,
  floatOf,
  parseMkv,
  segmentDataStart,
  stringOf,
  uintOf,
  type EbmlNode,
} from '../helpers/ebml-reader';
import { haveFfprobe } from '../helpers/tools';
import { fx } from '../paths';

const enc = new TextEncoder();
const ASS_HEADER = enc.encode('[Script Info]\nScriptType: v4.00+\n\n[V4+ Styles]\nFormat: Name, Fontname\nStyle: Default,Starfall Sans\n\n[Events]\nFormat: ReadOrder, Layer, Style, Name, MarginL, MarginR, MarginV, Effect, Text\n');
const ASS_1 = enc.encode('0,0,Default,,0,0,0,,The wanderer wakes');
const ASS_2 = enc.encode('1,0,Default,,0,0,0,,Starfall');
// One END segment each (type 0x80, size 0): the smallest display-set data a PGS decoder accepts.
const PGS_1 = new Uint8Array([0x80, 0x00, 0x00]);
const PGS_2 = new Uint8Array([0x80, 0x00, 0x00]);
const FONT_A = new Uint8Array([0, 1, 0, 0, 1, 2, 3]);
const FONT_B = new Uint8Array([0x4f, 0x54, 0x54, 0x4f, 9]);

type Sources = Pick<MkvInput, 'video' | 'videoPackets' | 'audio'>;

/** Fresh readers over the fixtures: one video stream and `audioLabels.length` copies of the Opus tone. */
async function sources(audioLabels: { name: string; language: string; isDefault: boolean }[]): Promise<Sources & { oggs: OggOpusStream[] }> {
  const ivf = await readIvf(createReadStream(fx('fixtures/small.ivf')));
  const seq = await ivf.sequenceHeader;
  const oggs = await Promise.all(audioLabels.map(() => readOggOpus(createReadStream(fx('fixtures/tone.opus')))));
  return {
    oggs,
    video: { width: 64, height: 64, fpsNum: 24000, fpsDen: 1001, codecPrivate: seq.av1C, name: 'Starfall Wanderer', language: 'und', isDefault: true },
    videoPackets: ivf.packets,
    audio: oggs.map((ogg, i) => ({
      ...audioLabels[i]!,
      channels: 2,
      sampleRate: 48000,
      codecPrivate: ogg.head.raw,
      codecDelayNs: (BigInt(ogg.head.preSkip) * 1_000_000_000n) / 48000n,
      seekPreRollNs: 80_000_000n,
      packets: ogg.packets,
      end: ogg.end,
    })),
  };
}

function trackEntries(t: EbmlNode): EbmlNode[] {
  return findAll(t, Id.TrackEntry);
}

function child(n: EbmlNode, id: number): EbmlNode | undefined {
  return n.children?.find((c) => c.id === id);
}

interface CueEntry {
  timeMs: number;
  track: number;
  clusterPos: number;
  relPos?: number;
  durationMs: number | undefined;
}

/** Every CueTrackPositions with its CuePoint's CueTime, in file order. */
function cueEntries(t: EbmlNode): CueEntry[] {
  return findAll(t, Id.CuePoint).flatMap((p) => {
    const timeMs = Number(uintOf(find(p, Id.CueTime)));
    return p
      .children!.filter((c) => c.id === Id.CueTrackPositions)
      .map((ctp) => {
        const rel = child(ctp, Id.CueRelativePosition);
        const dur = child(ctp, Id.CueDuration);
        return {
          timeMs,
          track: Number(uintOf(child(ctp, Id.CueTrack)!)),
          clusterPos: Number(uintOf(child(ctp, Id.CueClusterPosition)!)),
          ...(rel !== undefined ? { relPos: Number(uintOf(rel)) } : {}),
          durationMs: dur !== undefined ? Number(uintOf(dur)) : undefined,
        };
      });
  });
}

describe('writeMkv', () => {
  const dir = mkdtempSync(join(tmpdir(), 'encoding-tools-mkv-'));
  const out = join(dir, 'w.mkv');
  let r: MkvResult;
  let ogg: OggOpusStream;

  beforeAll(async () => {
    const s = await sources([
      { name: 'Japanese', language: 'jpn', isDefault: true },
      { name: 'Commentary', language: 'eng', isDefault: false },
    ]);
    ogg = s.oggs[0]!;
    r = await writeMkv(out, {
      title: 'Starfall Wanderer 01',
      video: s.video,
      videoPackets: s.videoPackets,
      audio: s.audio,
      subtitles: [
        {
          name: 'English (Starfall Subs)',
          language: 'eng',
          isDefault: true,
          codecId: 'S_TEXT/ASS',
          codecPrivate: ASS_HEADER,
          blocks: [
            { timeMs: 100, durationMs: 200, data: ASS_1 },
            { timeMs: 300, durationMs: 150, data: ASS_2 },
          ],
        },
        {
          name: 'Japanese (disc)',
          language: 'jpn',
          isDefault: false,
          codecId: 'S_HDMV/PGS',
          blocks: [
            { timeMs: 50, data: PGS_1 },
            { timeMs: 260, data: PGS_2 },
          ],
        },
      ],
      attachments: [
        { name: 'StarfallSans.ttf', mediaType: 'font/ttf', data: FONT_A },
        { name: 'WandererSerif.otf', mediaType: 'font/otf', data: FONT_B },
      ],
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
    expect(r).toMatchObject({ videoPackets: 10, audioPackets: [26, 26], subtitleBlocks: [2, 2], clusters: 3 });
    const t = parseMkv(readFileSync(out));
    expect(stringOf(find(t, Id.DocType))).toBe('matroska');
    expect(stringOf(find(t, Id.Title))).toBe('Starfall Wanderer 01');
    expect(findAll(t, Id.CodecID).map(stringOf)).toEqual(['V_AV1', 'A_OPUS', 'A_OPUS', 'S_TEXT/ASS', 'S_HDMV/PGS']);
    expect(findAll(t, Id.TrackNumber).map(uintOf)).toEqual([1n, 2n, 3n, 4n, 5n]);
    expect(findAll(t, Id.TrackType).map(uintOf)).toEqual([1n, 2n, 2n, 17n, 17n]);
    expect(uintOf(find(t, Id.CodecDelay))).toBe((BigInt(ogg.head.preSkip) * 1_000_000_000n) / 48000n);
    expect(findAll(t, Id.ChapterTimeStart).map(uintOf)).toEqual([0n, 166_833_333n]);
    expect(findAll(t, Id.Cluster)).toHaveLength(3);
    const videoCues = cueEntries(t).filter((c) => c.track === 1);
    expect(videoCues).toHaveLength(3);
    expect(videoCues.map((c) => BigInt(c.clusterPos))).toEqual(
      findAll(t, Id.Cluster).map((c) => BigInt(c.offset - segmentDataStart(t))),
    );
    for (const cluster of findAll(t, Id.Cluster)) expect(firstBlockIsVideoKeyframe(cluster)).toBe(true);
    expect(countVideoBlocks(t)).toBe(10);
    expect(floatOf(find(t, Id.Duration))).toBeCloseTo(Number(r.durationNs) / 1e6, 3);
    expect(floatOf(find(t, Id.Duration))).toBeCloseTo(500, 1); // audio end minus the Opus pre-skip (CodecDelay)
    expect(find(t, Id.Segment).size).toBe(statSync(out).size - segmentDataStart(t));
    expect(findAll(t, Id.DiscardPadding)).toHaveLength((await ogg.end).discardPadding48 > 0 ? 2 : 0);
  });

  it('writes Name, Language and an explicit FlagDefault on every track', () => {
    const t = parseMkv(readFileSync(out));
    const labels = trackEntries(t).map((e) => ({
      name: stringOf(child(e, Id.Name)!),
      language: stringOf(child(e, Id.Language)!),
      isDefault: uintOf(child(e, Id.FlagDefault)!),
    }));
    expect(labels).toEqual([
      { name: 'Starfall Wanderer', language: 'und', isDefault: 1n },
      { name: 'Japanese', language: 'jpn', isDefault: 1n },
      { name: 'Commentary', language: 'eng', isDefault: 0n },
      { name: 'English (Starfall Subs)', language: 'eng', isDefault: 1n },
      { name: 'Japanese (disc)', language: 'jpn', isDefault: 0n },
    ]);
  });

  it('writes two audio tracks with names, languages and one default', () => {
    const t = parseMkv(readFileSync(out));
    const audio = trackEntries(t).filter((e) => uintOf(child(e, Id.TrackType)!) === 2n);
    expect(audio.map((e) => [uintOf(child(e, Id.TrackNumber)!), stringOf(child(e, Id.Name)!), stringOf(child(e, Id.Language)!)])).toEqual([
      [2n, 'Japanese', 'jpn'],
      [3n, 'Commentary', 'eng'],
    ]);
    expect(audio.map((e) => uintOf(child(e, Id.FlagDefault)!))).toEqual([1n, 0n]);
    const blocks = blocksInOrder(t);
    expect(blocks.filter((b) => b.track === 2)).toHaveLength(26);
    expect(blocks.filter((b) => b.track === 3)).toHaveLength(26);
  });

  it('writes an ASS track with CodecPrivate and BlockGroups with BlockDuration', () => {
    const t = parseMkv(readFileSync(out));
    const ass = trackEntries(t)[3]!;
    expect(Buffer.from(child(ass, Id.CodecPrivate)!.bytes!)).toEqual(Buffer.from(ASS_HEADER));
    expect(uintOf(child(ass, Id.FlagLacing)!)).toBe(0n);
    const blocks = blocksInOrder(t).filter((b) => b.track === 4);
    expect(blocks.map((b) => ({ kind: b.kind, timeMs: b.timeMs, durationMs: b.durationMs, flags: b.flags }))).toEqual([
      { kind: 'group', timeMs: 100, durationMs: 200, flags: 0 },
      { kind: 'group', timeMs: 300, durationMs: 150, flags: 0 },
    ]);
    expect(blocks.map((b) => Buffer.from(b.data))).toEqual([Buffer.from(ASS_1), Buffer.from(ASS_2)]);
  });

  it('writes a PGS track as SimpleBlocks', () => {
    const t = parseMkv(readFileSync(out));
    const pgs = trackEntries(t)[4]!;
    expect(child(pgs, Id.CodecPrivate)).toBeUndefined();
    expect(uintOf(child(pgs, Id.FlagLacing)!)).toBe(0n);
    const blocks = blocksInOrder(t).filter((b) => b.track === 5);
    expect(blocks.map((b) => ({ kind: b.kind, timeMs: b.timeMs, flags: b.flags }))).toEqual([
      { kind: 'simple', timeMs: 50, flags: 0x80 },
      { kind: 'simple', timeMs: 260, flags: 0x80 },
    ]);
    expect(blocks.map((b) => Buffer.from(b.data))).toEqual([Buffer.from(PGS_1), Buffer.from(PGS_2)]);
  });

  it('writes attachments with MIME types and lists them in the SeekHead', () => {
    const t = parseMkv(readFileSync(out));
    const files = findAll(t, Id.AttachedFile);
    expect(
      files.map((f) => ({
        name: stringOf(child(f, Id.FileName)!),
        type: stringOf(child(f, Id.FileMediaType)!),
        data: Buffer.from(child(f, Id.FileData)!.bytes!),
      })),
    ).toEqual([
      { name: 'StarfallSans.ttf', type: 'font/ttf', data: Buffer.from(FONT_A) },
      { name: 'WandererSerif.otf', type: 'font/otf', data: Buffer.from(FONT_B) },
    ]);
    const uids = files.map((f) => uintOf(child(f, Id.FileUID)!));
    for (const u of uids) expect(u).not.toBe(0n);
    expect(new Set(uids).size).toBe(2);
    expect(findAll(t, Id.FileDescription)).toEqual([]);

    const top = find(t, Id.Segment).children!.map((c) => c.id).filter((id) => id !== Id.Void && id !== Id.Cluster);
    expect(top).toEqual([Id.SeekHead, Id.Info, Id.Tracks, Id.Attachments, Id.Chapters, Id.Cues]);
    const base = segmentDataStart(t);
    const seeks = findAll(t, Id.Seek).map((s) => ({
      id: Number(uintOf(find(s, Id.SeekID))),
      pos: Number(uintOf(find(s, Id.SeekPosition))),
    }));
    expect(seeks.map((s) => s.id)).toEqual([Id.Info, Id.Tracks, Id.Attachments, Id.Chapters, Id.Cues]);
    for (const s of seeks) expect(find(t, s.id).offset - base).toBe(s.pos);
  });

  it('writes a cue for every subtitle block that points at the block itself', () => {
    const t = parseMkv(readFileSync(out));
    const times = findAll(t, Id.CuePoint).map((p) => Number(uintOf(find(p, Id.CueTime))));
    for (let i = 1; i < times.length; i++) expect(times[i]!).toBeGreaterThan(times[i - 1]!);
    const subCues = cueEntries(t).filter((c) => c.track === 4 || c.track === 5);
    expect(subCues.map((c) => ({ track: c.track, timeMs: c.timeMs, durationMs: c.durationMs }))).toEqual([
      { track: 5, timeMs: 50, durationMs: undefined },
      { track: 4, timeMs: 100, durationMs: 200 },
      { track: 5, timeMs: 260, durationMs: undefined },
      { track: 4, timeMs: 300, durationMs: 150 },
    ]);
    const base = segmentDataStart(t);
    const clusters = findAll(t, Id.Cluster);
    for (const c of subCues) {
      const cluster = clusters.find((cl) => cl.offset - base === c.clusterPos);
      expect(cluster).toBeDefined();
      expect(c.relPos).toBeDefined();
      // CueRelativePosition counts from the first byte of the Cluster's data.
      const el = cluster!.children!.find((k) => k.offset === cluster!.offset + cluster!.headerLength + c.relPos!);
      expect(el).toBeDefined();
      const [block] = blocksInOrder({ ...t, children: [{ ...cluster!, children: [find(cluster!, Id.Timestamp), el!] }] });
      expect({ track: block!.track, timeMs: block!.timeMs }).toEqual({ track: c.track, timeMs: c.timeMs });
    }
  });

  it('orders blocks by time across tracks', () => {
    const blocks = blocksInOrder(parseMkv(readFileSync(out)));
    expect(blocks).toHaveLength(10 + 26 + 26 + 2 + 2);
    for (let i = 1; i < blocks.length; i++) expect(blocks[i]!.timeMs).toBeGreaterThanOrEqual(blocks[i - 1]!.timeMs);
    // At one timestamp: video first, then audio in track order, then subtitles in track order.
    const at = (ms: number): number[] => blocks.filter((b) => b.timeMs === ms).map((b) => b.track);
    expect(at(0)).toEqual([1, 2, 3]);
    const pgsAt260 = blocks.findIndex((b) => b.track === 5 && b.timeMs === 260);
    expect(blocks[pgsAt260 - 1]!.timeMs).toBeLessThanOrEqual(260);
    expect(blocks[pgsAt260 + 1]!.timeMs).toBeGreaterThanOrEqual(260);
  });

  describe.skipIf(!haveFfprobe)('ffprobe oracle', () => {
    it('sees every stream, both attachments and two chapters', () => {
      const j = JSON.parse(
        execFileSync('ffprobe', ['-v', 'error', '-show_streams', '-show_chapters', '-of', 'json', out]).toString(),
      ) as { streams: { codec_name?: string; codec_type: string; disposition?: { default: number }; tags?: { language?: string; title?: string; filename?: string; mimetype?: string } }[]; chapters: unknown[] };
      const media = j.streams.filter((s) => s.codec_type !== 'attachment');
      expect(media.map((s) => s.codec_name)).toEqual(['av1', 'opus', 'opus', 'ass', 'hdmv_pgs_subtitle']);
      // libavformat leaves out the language tag when it is `und`.
      expect(media.map((s) => s.tags?.language)).toEqual([undefined, 'jpn', 'eng', 'eng', 'jpn']);
      expect(media.map((s) => s.disposition?.default)).toEqual([1, 1, 0, 1, 0]);
      expect(media.map((s) => s.tags?.title)).toEqual(['Starfall Wanderer', 'Japanese', 'Commentary', 'English (Starfall Subs)', 'Japanese (disc)']);
      const att = j.streams.filter((s) => s.codec_type === 'attachment');
      expect(att.map((s) => [s.tags?.filename, s.tags?.mimetype])).toEqual([
        ['StarfallSans.ttf', 'font/ttf'],
        ['WandererSerif.otf', 'font/otf'],
      ]);
      expect(j.chapters).toHaveLength(2);
    });
  });
});

describe('writeMkv with subtitles far from video key frames', () => {
  const dir = mkdtempSync(join(tmpdir(), 'encoding-tools-mkv-'));

  afterAll(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  async function write(path: string, blocks: { timeMs: number; durationMs?: number; data: Uint8Array }[]): Promise<MkvResult> {
    const s = await sources([{ name: 'Japanese', language: 'jpn', isDefault: true }]);
    return writeMkv(path, {
      video: s.video,
      videoPackets: s.videoPackets,
      audio: s.audio,
      subtitles: [{ name: 'English', language: 'eng', isDefault: false, codecId: 'S_TEXT/ASS', codecPrivate: ASS_HEADER, blocks }],
      attachments: [],
      chapters: [],
    });
  }

  it('a subtitle block 40 s after the last key frame opens a new cluster', async () => {
    const path = join(dir, 'late.mkv');
    const r = await write(path, [
      { timeMs: 100, durationMs: 500, data: ASS_1 },
      { timeMs: 40_000, durationMs: 2_000, data: ASS_2 },
    ]);
    expect(r.clusters).toBe(4);
    const t = parseMkv(readFileSync(path));
    const clusters = findAll(t, Id.Cluster);
    expect(clusters.map((c) => Number(uintOf(find(c, Id.Timestamp))))).toEqual([0, expect.any(Number), expect.any(Number), 40_000]);
    const last = blocksInOrder({ ...t, children: [clusters[3]!] });
    expect(last.map((b) => ({ track: b.track, timeMs: b.timeMs, durationMs: b.durationMs }))).toEqual([
      { track: 3, timeMs: 40_000, durationMs: 2_000 },
    ]);
    // Video cues point only at the clusters that open with a video key frame; every subtitle block has its own cue.
    const cues = cueEntries(t);
    expect(cues.filter((c) => c.track === 1)).toHaveLength(3);
    expect(cues.filter((c) => c.track === 3).map((c) => ({ timeMs: c.timeMs, durationMs: c.durationMs }))).toEqual([
      { timeMs: 100, durationMs: 500 },
      { timeMs: 40_000, durationMs: 2_000 },
    ]);
    expect(cues.find((c) => c.timeMs === 40_000)!.clusterPos).toBe(clusters[3]!.offset - segmentDataStart(t));
    // No attachments: neither the element nor its SeekHead entry.
    expect(findAll(t, Id.Attachments)).toEqual([]);
    expect(findAll(t, Id.SeekID).map((s) => Number(uintOf(s)))).toEqual([Id.Info, Id.Tracks, Id.Cues]);
  });

  it('refuses a subtitle block before 0 ms', async () => {
    await expect(write(join(dir, 'neg.mkv'), [{ timeMs: -1, data: ASS_1 }])).rejects.toThrow(RangeError);
  });

  it('refuses subtitle blocks out of time order', async () => {
    await expect(
      write(join(dir, 'unsorted.mkv'), [
        { timeMs: 300, data: ASS_1 },
        { timeMs: 200, data: ASS_2 },
      ]),
    ).rejects.toThrow(/order/);
  });
});
