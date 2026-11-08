// SPDX-License-Identifier: LGPL-3.0-or-later
import type { MkvBlock, MkvTrack, ParsedMkv } from '../mux/mkv-reader';
import { writeMkv, type MkvAudioTrack, type MkvVideoPacket } from '../mux/mkv-writer';
import { opusPacketDuration, type OpusPacket } from '../mux/ogg';

// A WebM file (WebM container guidelines) is a Matroska file with DocType `webm` and a restricted
// set of codecs and elements. Browsers play AV1 and Opus in it; they do not take ASS, PGS or
// attachments, which is why the episode MKV is remuxed rather than served as is. The remux copies
// the MKV's AV1 and Opus blocks unchanged, at their own timestamps, through the same writer that
// wrote the MKV, so the clusters, Cues (video key frames only, as the guidelines ask) and the
// patched SeekHead and Duration are built the same way.

/** Thrown when an MKV has no AV1 video track a WebM can carry, or a track lacks what its codec mapping needs. */
export class WebmError extends Error {}

/** Default for `WebmOptions.maxQueuedBytes`: 64 MiB, far above what interleaved tracks ever queue. */
export const DEFAULT_MAX_QUEUED_BYTES = 64 * 1024 * 1024;

/** How `writeWebm` reads the MKV. */
export interface WebmOptions {
  /**
   * Blocks per track number, from a pass the caller has already made over the file (`countBlocks`).
   * Each track's stream ends after its count, so finding a track's last block never reads ahead.
   * When left out, `writeWebm` counts them itself with one more pass.
   */
  blockCounts?: ReadonlyMap<number, number>;
  /** The most block bytes the remux may hold for tracks waiting their turn; above it `writeWebm` throws `WebmError`. Default `DEFAULT_MAX_QUEUED_BYTES`. */
  maxQueuedBytes?: number;
  /**
   * Another file to take the Opus tracks from instead of `mkv`'s, such as one sample's audio shared by samples of
   * several video encodes. Its blocks are read in a pass of their own; `blockCounts` counts only `mkv`'s.
   */
  audioFrom?: ParsedMkv;
}

/**
 * Hands out the blocks of one pass over the file as one stream per track. The writer pulls the
 * tracks in timestamp order, so blocks of the other tracks wait in a queue only for as long as they
 * are interleaved ahead of the one asked for; blocks of tracks nobody asked for are dropped. Each
 * stream ends after its track's known block count without reading further, so learning that a
 * block is a track's last costs nothing; a track that starts late still makes the blocks before
 * its first one wait, and the bytes waiting are capped. Pulls are serialized, and a read error is
 * given to every later pull too.
 */
class TrackSplitter {
  private readonly source: AsyncIterator<MkvBlock>;
  private readonly queues = new Map<number, MkvBlock[]>();
  private queuedBytes = 0;
  private done = false;
  private error: unknown = undefined;
  private chain: Promise<unknown> = Promise.resolve();

  constructor(
    source: AsyncIterable<MkvBlock>,
    private readonly counts: ReadonlyMap<number, number>,
    private readonly maxQueuedBytes: number,
  ) {
    this.source = source[Symbol.asyncIterator]();
    for (const t of counts.keys()) this.queues.set(t, []);
  }

  private async pull(track: number): Promise<MkvBlock | null> {
    if (this.error !== undefined) throw this.error;
    const queue = this.queues.get(track)!;
    try {
      while (queue.length === 0 && !this.done) {
        const r = await this.source.next();
        if (r.done === true) {
          this.done = true;
          break;
        }
        const target = this.queues.get(r.value.track);
        if (target === undefined) continue;
        target.push(r.value);
        this.queuedBytes += r.value.data.length;
        if (target !== queue && this.queuedBytes > this.maxQueuedBytes) {
          throw new WebmError(`track ${track} is too far from the other tracks: over ${this.maxQueuedBytes} bytes of their blocks would wait in memory`);
        }
      }
    } catch (err) {
      this.error = err;
      throw err;
    }
    const block = queue.shift() ?? null;
    if (block !== null) this.queuedBytes -= block.data.length;
    return block;
  }

  /** Stops the pass and lets the source close its file; waits for a pull in progress first. */
  async close(): Promise<void> {
    await this.chain;
    await this.source.return?.();
  }

  /** The blocks of `track`: exactly its counted number, then done. Throws `WebmError` when the file holds fewer. */
  async *stream(track: number): AsyncGenerator<MkvBlock> {
    for (let left = this.counts.get(track) ?? 0; left > 0; left--) {
      const next = this.chain.then(() => this.pull(track));
      this.chain = next.catch(() => undefined);
      const block = await next;
      if (block === null) throw new WebmError(`track ${track} has fewer blocks than were counted (did the file change?)`);
      yield block;
    }
  }
}

/** Counts the blocks of every track of `mkv` in one pass over its clusters. */
export async function countBlocks(mkv: ParsedMkv): Promise<Map<number, number>> {
  const counts = new Map<number, number>();
  for await (const b of mkv.blocks()) counts.set(b.track, (counts.get(b.track) ?? 0) + 1);
  return counts;
}

function needPrivate(track: MkvTrack): Uint8Array {
  if (track.codecPrivate === undefined) throw new WebmError(`track ${track.number} (${track.codecId}) has no CodecPrivate`);
  return track.codecPrivate;
}

/** The tracks of `mkv` a WebM keeps: its first `V_AV1` track and every `A_OPUS` track, in file order. Throws `WebmError` when there is no AV1 track. */
export function webmTracks(mkv: ParsedMkv): { video: MkvTrack; audio: MkvTrack[] } {
  const video = mkv.tracks.find((t) => t.codecId === 'V_AV1');
  if (video === undefined) throw new WebmError('the MKV has no AV1 video track');
  return { video, audio: mkv.tracks.filter((t) => t.codecId === 'A_OPUS') };
}

/**
 * Writes a WebM file at `path` holding the AV1 video and every Opus track of `mkv`, renumbered from
 * 1 (the video, then the audio tracks in file order), with their names, languages and default flags,
 * the title and the chapters. Subtitle tracks, attachments and tags are left out, as the WebM
 * container guidelines exclude them; the Cues point at video key frames only. Blocks keep their
 * data and timestamps (rounded to whole milliseconds), and an Opus block's DiscardPadding is kept on
 * the track's last block. Reads the file one cluster at a time: once to count each track's blocks
 * unless `options.blockCounts` gives them, then once to remux. Memory is one cluster plus the
 * blocks waiting for their turn, which stay few because each track ends at its count; a track that
 * starts far later than the others is the one case that makes many wait. Throws `WebmError` when
 * there is no AV1 track, a kept track has no CodecPrivate, no DefaultDuration (video) or no Audio
 * element (Opus), more than `options.maxQueuedBytes` would wait, or a track has fewer blocks than
 * counted, and whatever reading or writing throws; a partial file is left for the caller to delete. With
 * `options.audioFrom` the Opus tracks are that file's instead of `mkv`'s.
 */
export async function writeWebm(mkv: ParsedMkv, path: string, options: WebmOptions = {}): Promise<void> {
  const { video, audio: ownAudio } = webmTracks(mkv);
  const audioFile = options.audioFrom;
  const audio = audioFile === undefined ? ownAudio : audioFile.tracks.filter((t) => t.codecId === 'A_OPUS');
  if (video.defaultDurationNs === undefined || video.defaultDurationNs === 0n) throw new WebmError(`the AV1 track has no DefaultDuration`);
  if (video.video === undefined) throw new WebmError('the AV1 track has no Video element');
  const frameNs = video.defaultDurationNs;
  const counts = options.blockCounts ?? (await countBlocks(mkv));
  const maxQueued = options.maxQueuedBytes ?? DEFAULT_MAX_QUEUED_BYTES;
  const tracksOf = (tracks: MkvTrack[], c: ReadonlyMap<number, number>): Map<number, number> => new Map(tracks.map((t) => [t.number, c.get(t.number) ?? 0]));
  // With a separate audio file, each file is read in its own pass, so neither queues the other's blocks.
  const splitter = new TrackSplitter(mkv.blocks(), tracksOf(audioFile === undefined ? [video, ...audio] : [video], counts), maxQueued);
  const audioSplitter =
    audioFile === undefined ? splitter : new TrackSplitter(audioFile.blocks(), tracksOf(audio, await countBlocks(audioFile)), maxQueued);

  async function* videoPackets(): AsyncGenerator<MkvVideoPacket> {
    let index = 0;
    for await (const b of splitter.stream(video.number)) {
      yield { index: index++, data: b.data, keyframe: b.keyframe, timeMs: Math.round(b.timeMs) };
    }
  }

  const audioTracks = audio.map((track): MkvAudioTrack => {
    if (track.audio === undefined) throw new WebmError(`Opus track ${track.number} has no Audio element`);
    let resolveEnd!: (v: { discardPadding48: number }) => void;
    const end = new Promise<{ discardPadding48: number }>((r) => (resolveEnd = r));
    async function* packets(): AsyncGenerator<OpusPacket> {
      let lastPaddingNs = 0n;
      for await (const b of audioSplitter.stream(track.number)) {
        lastPaddingNs = b.discardPaddingNs ?? 0n;
        yield { data: b.data, pts48: Math.round(b.timeMs) * 48, durationSamples: opusPacketDuration(b.data) };
      }
      resolveEnd({ discardPadding48: lastPaddingNs > 0n ? Number((lastPaddingNs * 48000n + 500_000_000n) / 1_000_000_000n) : 0 });
    }
    return {
      channels: track.audio.channels,
      sampleRate: track.audio.sampleRate,
      codecPrivate: needPrivate(track),
      codecDelayNs: track.codecDelayNs,
      seekPreRollNs: track.seekPreRollNs,
      name: track.name,
      language: track.language,
      isDefault: track.isDefault,
      packets: packets(),
      end,
    };
  });

  try {
    await writeMkv(path, {
      docType: 'webm',
      ...(mkv.title !== undefined ? { title: mkv.title } : {}),
      // A frame rate of 1e9 / DefaultDuration writes the source's DefaultDuration back unchanged.
      video: {
        width: video.video.width,
        height: video.video.height,
        fpsNum: 1_000_000_000,
        fpsDen: Number(frameNs),
        codecPrivate: needPrivate(video),
        name: video.name,
        language: video.language,
        isDefault: video.isDefault,
      },
      videoPackets: videoPackets(),
      audio: audioTracks,
      subtitles: [],
      attachments: [],
      chapters: mkv.chapters,
    });
  } finally {
    await splitter.close();
    if (audioSplitter !== splitter) await audioSplitter.close();
  }
}
