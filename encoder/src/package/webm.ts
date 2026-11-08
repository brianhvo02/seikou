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

/**
 * Hands out the blocks of one pass over the file as one stream per track. The writer pulls the
 * tracks in timestamp order, so blocks of the other tracks wait in a queue only for as long as they
 * are interleaved ahead of the one asked for; blocks of tracks nobody asked for are dropped.
 * Pulls are serialized, and a read error is given to every later pull too.
 */
class TrackSplitter {
  private readonly source: AsyncIterator<MkvBlock>;
  private readonly queues = new Map<number, MkvBlock[]>();
  private done = false;
  private error: unknown = undefined;
  private chain: Promise<unknown> = Promise.resolve();

  constructor(source: AsyncIterable<MkvBlock>, tracks: readonly number[]) {
    this.source = source[Symbol.asyncIterator]();
    for (const t of tracks) this.queues.set(t, []);
  }

  private async pull(track: number): Promise<MkvBlock | null> {
    if (this.error !== undefined) throw this.error;
    const queue = this.queues.get(track)!;
    try {
      while (queue.length === 0 && !this.done) {
        const r = await this.source.next();
        if (r.done === true) this.done = true;
        else this.queues.get(r.value.track)?.push(r.value);
      }
    } catch (err) {
      this.error = err;
      throw err;
    }
    return queue.shift() ?? null;
  }

  /** Stops the pass and lets the source close its file; waits for a pull in progress first. */
  async close(): Promise<void> {
    await this.chain;
    await this.source.return?.();
  }

  async *stream(track: number): AsyncGenerator<MkvBlock> {
    for (;;) {
      const next = this.chain.then(() => this.pull(track));
      this.chain = next.catch(() => undefined);
      const block = await next;
      if (block === null) return;
      yield block;
    }
  }
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
 * the track's last block. Reads the file once, one cluster at a time. Throws `WebmError` when
 * there is no AV1 track or a kept track has no CodecPrivate, no DefaultDuration (video) or no Audio
 * element (Opus), and whatever reading or writing throws; a partial file is left for the caller to
 * delete.
 */
export async function writeWebm(mkv: ParsedMkv, path: string): Promise<void> {
  const { video, audio } = webmTracks(mkv);
  if (video.defaultDurationNs === undefined || video.defaultDurationNs === 0n) throw new WebmError(`the AV1 track has no DefaultDuration`);
  if (video.video === undefined) throw new WebmError('the AV1 track has no Video element');
  const frameNs = video.defaultDurationNs;
  const splitter = new TrackSplitter(mkv.blocks(), [video.number, ...audio.map((a) => a.number)]);

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
      for await (const b of splitter.stream(track.number)) {
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
  }
}
