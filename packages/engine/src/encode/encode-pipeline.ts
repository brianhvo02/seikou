// SPDX-License-Identifier: LGPL-3.0-or-later
import type { DemuxStats } from '@seikou/bdmv/demux/m2ts-reader';
import type { MatroskaFile } from '@seikou/matroska';
import type { PipelineSinks, SessionPipeline } from '../playback/pipeline';

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
}

const NO_STATS: DemuxStats = { corruptPackets: 0, continuityErrors: 0 };

/**
 * Reads an encoded episode's Matroska blocks in file order from a start time and feeds them to the sinks the M2TS
 * pipeline feeds: video blocks as units with the block's key-frame flag. Reading pauses while the sinks are full, and a
 * new start() or a stop() cancels the read in flight (its AbortSignal reaches the byte source).
 */
export class EncodePipeline implements SessionPipeline {
  private generation = 0;
  private controller: AbortController | null = null;
  private reached: number | null = null;
  private done: number | null = null;
  private active = false;

  constructor(
    private readonly config: EncodePipelineConfig,
    private readonly sinks: PipelineSinks,
    private readonly wait: (ms: number) => Promise<void> = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  ) {}

  /** An encode has no PG stream of a disc's kind; the setting is ignored. */
  setPgStream(_pid: number | null): void {}

  /** An encode's audio is not read yet; the setting is ignored. */
  setAudioStream(_stream: number | null): void {}

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
    for await (const block of file.blocksFrom(fromUs / 1000, signal)) {
      if (gen !== this.generation) return;
      while (this.sinks.isFull()) {
        await this.wait(5);
        if (gen !== this.generation) return;
      }
      const ptsUs = Math.round(block.timeMs * 1000);
      if (block.track === videoTrack) {
        this.sinks.video({ data: block.data, ptsUs, inRange: ptsUs < durationUs, key: block.keyframe });
        if (this.reached === null || ptsUs > this.reached) this.reached = ptsUs;
      }
    }
    if (gen !== this.generation) return;
    this.active = false;
    this.done = durationUs;
    this.sinks.ended();
  }
}
