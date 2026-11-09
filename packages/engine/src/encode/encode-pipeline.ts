// SPDX-License-Identifier: LGPL-3.0-or-later
import type { DemuxStats } from '@seikou/bdmv/demux/m2ts-reader';
import type { MatroskaFile } from '@seikou/matroska';
import { CODING_OPUS } from '../decode/opus-decoder';
import type { PipelineSinks, SessionPipeline } from '../playback/pipeline';

/** One of the encode's audio tracks: its Matroska track number and how much earlier than a seek its decoding starts. */
export interface EncodeAudioRoute {
  readonly track: number;
  /** SeekPreRoll in microseconds (80 ms for Opus). */
  readonly preRollUs: number;
}

/** A block of one of the encode's subtitle tracks, in episode time. */
export interface EncodeSubtitleUnit {
  /** The 1-based subtitle stream (the position in `subtitleTracks`). */
  readonly stream: number;
  readonly data: Uint8Array;
  readonly ptsUs: number;
  /** BlockDuration, when the block has one (an ASS event's length). */
  readonly durationUs?: number;
}

/** The sinks an encode's reads feed: the M2TS pipeline's, and its subtitle blocks. */
export interface EncodeSinks extends PipelineSinks {
  /** Every block of every subtitle track, whichever shows: ASS events are collected whatever the choice. */
  subtitle(unit: EncodeSubtitleUnit): void;
}

/** What an encode's reads need: the opened file, the track numbers to deliver, and where its bytes come from. */
export interface EncodePipelineConfig {
  readonly file: MatroskaFile;
  /** The Matroska track number of the video; its blocks go to the video sink. */
  readonly videoTrack: number;
  /** The file's path in the source (for the NAS start-up read-ahead) and its size in bytes. */
  readonly path: string;
  readonly size: number;
  /** The episode's duration (its Info Duration). */
  readonly durationUs: number;
  /** The audio tracks by stream number (index 0 is stream 1); setAudioStream picks the one delivered. */
  readonly audio?: readonly EncodeAudioRoute[];
  /** The Matroska track numbers of the subtitle tracks, by stream number (index 0 is stream 1). */
  readonly subtitleTracks?: readonly number[];
}

const NO_STATS: DemuxStats = { corruptPackets: 0, continuityErrors: 0 };

/**
 * Reads an encoded episode's Matroska blocks in file order from a start time and feeds them to the sinks the M2TS
 * pipeline feeds: video blocks as units with the block's key-frame flag, the chosen audio track's blocks as Opus units
 * (routed by track number: the session's play item has no STN), and every subtitle track's blocks. With audio, reading
 * starts the track's SeekPreRoll before the start time and drops the audio before that, so the decoder is primed by
 * the time the start comes (the ring drops what decodes before it). Reading pauses while the sinks are full, and a new
 * start() or a stop() cancels the read in flight (its AbortSignal reaches the byte source).
 */
export class EncodePipeline implements SessionPipeline {
  private generation = 0;
  private controller: AbortController | null = null;
  private reached: number | null = null;
  private done: number | null = null;
  private active = false;
  private audio: EncodeAudioRoute | null = null;

  constructor(
    private readonly config: EncodePipelineConfig,
    private readonly sinks: EncodeSinks,
    private readonly wait: (ms: number) => Promise<void> = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  ) {}

  /** An encode has no PG stream of a disc's kind; the setting is ignored. */
  setPgStream(_pid: number | null): void {}

  /** The audio stream (1-based, as the session's AudioTracks number them) delivered from the next start(); null for none. */
  setAudioStream(stream: number | null): void {
    this.audio = stream === null ? null : (this.config.audio?.[stream - 1] ?? null);
  }

  /** An encode has no IG stream; the setting is ignored. */
  setIgStream(_stream: number | null): void {}

  /** The Matroska file while a read runs, at its average rate over the episode. */
  get reading(): { readonly path: string; readonly recordingRate: number } | null {
    if (!this.active) return null;
    const seconds = this.config.durationUs / 1e6;
    return { path: this.config.path, recordingRate: seconds > 0 ? this.config.size / seconds : 0 };
  }

  /** The time of the last block delivered since the last start(), or null before one. */
  get readUs(): number | null {
    return this.reached;
  }

  /** After ended(): the episode's duration. */
  get doneUs(): number | null {
    return this.done;
  }

  /** Matroska has no packet counters; always zero. */
  get stats(): DemuxStats {
    return NO_STATS;
  }

  start(fromUs: number): void {
    this.stop();
    const gen = this.generation;
    const controller = new AbortController();
    this.controller = controller;
    this.reached = null;
    this.done = null;
    this.active = true;
    this.run(gen, fromUs, controller.signal).catch((err: unknown) => {
      if (gen === this.generation) {
        this.active = false;
        this.sinks.failed(err);
      }
    });
  }

  stop(): void {
    this.generation++;
    this.active = false;
    this.controller?.abort(new DOMException('the read was stopped', 'AbortError'));
    this.controller = null;
  }

  private async run(gen: number, fromUs: number, signal: AbortSignal): Promise<void> {
    const { file, videoTrack, durationUs } = this.config;
    const audio = this.audio;
    const audioFromUs = audio ? Math.max(0, fromUs - audio.preRollUs) : 0;
    const subtitles = this.config.subtitleTracks ?? [];
    for await (const block of file.blocksFrom(audio ? audioFromUs / 1000 : fromUs / 1000, signal)) {
      if (gen !== this.generation) return;
      while (this.sinks.isFull()) {
        await this.wait(5);
        if (gen !== this.generation) return;
      }
      const ptsUs = Math.round(block.timeMs * 1000);
      if (block.track === videoTrack) {
        this.sinks.video({ data: block.data, ptsUs, inRange: ptsUs < durationUs, key: block.keyframe });
        if (this.reached === null || ptsUs > this.reached) this.reached = ptsUs;
      } else if (audio && block.track === audio.track) {
        // every packet goes in (their output is placed by time); the ring drops what lies before the start
        if (ptsUs >= audioFromUs) {
          const padding = block.discardPaddingNs !== undefined && block.discardPaddingNs > 0n ? { discardPaddingUs: Number(block.discardPaddingNs) / 1000 } : {};
          this.sinks.audio({ data: block.data, ptsUs, inRange: true, key: true, codingType: CODING_OPUS, ...padding });
        }
      } else {
        const stream = subtitles.indexOf(block.track) + 1;
        if (stream > 0) this.sinks.subtitle({ stream, data: block.data, ptsUs, ...(block.durationMs !== undefined ? { durationUs: Math.round(block.durationMs * 1000) } : {}) });
      }
    }
    if (gen !== this.generation) return;
    this.active = false;
    this.done = durationUs;
    this.sinks.ended();
  }
}
