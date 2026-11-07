// SPDX-License-Identifier: LGPL-3.0-or-later
import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { Readable } from 'node:stream';
import type { PlaylistAudioReader } from '@seikou/fansubs/align';
import type { AudioWindow } from '@seikou/fansubs/disc-audio';
import { ChainError, type ToolPaths } from '../pipeline/chain';
import { buildSpeechAudioScript } from '../pipeline/vpy';
import type { EpisodePlan } from '../plan/episodes';
import { Downsampler16k } from './downsample';
import { readWav } from './wav';

// Alignment listens to an episode many times (a coarse pass over the whole of it, then finer passes
// over a few windows), so the episode's audio is decoded once, through the same VapourSynth script
// the encode uses, and kept in memory as 16 kHz mono: about 1.9 MB a minute.

const STDERR_TAIL_BYTES = 4096;
/** 16 kHz samples per millisecond. */
const SAMPLES_PER_MS = 16;

function concat(parts: Int16Array[]): Int16Array {
  const out = new Int16Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

/**
 * Throws when the decode is shorter than the episode by more than one video frame: a WAV whose
 * declared size was cut short (a 32-bit size wraps above 4 GiB) would otherwise pass for a short
 * episode and misplace every subtitle near its end. The episode's length is the planned audio
 * sample count, which is what the script outputs; `durationNs` counts whole video frames and can
 * differ from it by part of a frame. A longer decode is left alone.
 */
function checkLength(plan: EpisodePlan, actual16k: number): void {
  const sourceSamples = plan.segments.reduce((n, s) => n + (s.audioSamples[1] - s.audioSamples[0]), 0);
  const expected16k = Math.ceil((sourceSamples * 16_000) / plan.audio.sampleRate);
  const frame16k = Math.ceil((16_000 * plan.video.fpsDen) / plan.video.fpsNum);
  if (expected16k - actual16k > frame16k) {
    throw new Error(
      `Episode ${plan.index} audio decoded to ${actual16k} samples at 16 kHz, expected ${expected16k} (the episode's length); ` +
        'the WAV from vspipe ended early',
    );
  }
}

/** Runs `vspipe -c wav <script> -` and downsamples its stdout as it arrives. */
function runVspipe(vspipe: string, script: string, signal: AbortSignal | undefined): Promise<Int16Array> {
  return new Promise<Int16Array>((resolvePcm, reject) => {
    const proc = spawn(vspipe, ['-c', 'wav', script, '-'], { stdio: ['ignore', 'pipe', 'pipe'] });
    let tail = Buffer.alloc(0);
    (proc.stderr as Readable).on('data', (d: Buffer) => {
      const all = Buffer.concat([tail, d]);
      tail = all.length > STDERR_TAIL_BYTES ? all.subarray(all.length - STDERR_TAIL_BYTES) : all;
    });

    let killedByUs = false;
    const stop = (): void => {
      if (proc.exitCode === null && proc.signalCode === null) {
        killedByUs = true;
        proc.kill('SIGTERM');
      }
    };
    const onAbort = (): void => stop();
    signal?.addEventListener('abort', onAbort, { once: true });

    const failed: { spawn?: Error } = {};
    proc.on('error', (e: Error) => {
      failed.spawn = e;
    });
    // 'close' comes after the process has exited and its stdio has ended, so the stderr tail is complete.
    const closed = new Promise<{ code: number | null; sig: NodeJS.Signals | null }>((res) => {
      proc.on('close', (code, sig) => res({ code, sig }));
    });

    const read = async (): Promise<Int16Array> => {
      const wav = await readWav(proc.stdout as Readable);
      const down = new Downsampler16k(wav.format.sampleRate);
      const parts: Int16Array[] = [];
      for await (const planar of wav.frames) parts.push(down.push(planar));
      parts.push(down.flush());
      // The reader stops at the declared data size, but vspipe may write past it (a trailing chunk, or
      // a size that overflowed 32 bits); unread output would fill the pipe and block vspipe for good.
      // The finished reader's async iterator leaves a 'readable' listener behind, which makes resume()
      // a no-op, so drop it first. Destroying the stream instead would fail vspipe with a broken pipe.
      const out = proc.stdout as Readable;
      out.removeAllListeners('readable');
      out.resume();
      return concat(parts);
    };

    void read().then(
      (pcm) => ({ pcm, readError: null as unknown }),
      (readError: unknown) => {
        // vspipe may still be writing; nobody reads its stdout any more, so stop it.
        stop();
        return { pcm: null, readError };
      },
    ).then(async ({ pcm, readError }) => {
      const { code, sig } = await closed;
      signal?.removeEventListener('abort', onAbort);
      if (signal?.aborted === true) return reject(signal.reason);
      if (failed.spawn !== undefined) return reject(new ChainError('vspipe', null, null, `${failed.spawn.message}\n${tail.toString('utf8')}`));
      // A failure of vspipe itself explains a broken or short stream better than the reader's error does.
      if (!(killedByUs && sig !== null) && code !== 0) return reject(new ChainError('vspipe', code, sig, tail.toString('utf8')));
      if (pcm === null) return reject(readError);
      resolvePcm(pcm);
    });
  });
}

/**
 * Decodes an episode's audio (the stream and the cuts the encode uses, from `buildSpeechAudioScript`)
 * to 16 kHz mono 16-bit PCM by running `vspipe -c wav <script> -` and downsampling its output with
 * `Downsampler16k`; sample 0 is the episode's first video frame. The script goes in a temporary
 * folder that is removed afterwards; BestSource's index files go under `cacheDir` (created if
 * missing) and are reused. Rejects with a `ChainError` carrying vspipe's last stderr output when it
 * exits with an error or cannot start, with `RangeError` when the source rate is not a multiple of
 * 16 kHz, with an `Error` naming both lengths when the decode is shorter than the planned audio by
 * more than one video frame, and with the signal's reason (vspipe stopped) when `signal` aborts.
 */
export async function decodeEpisodeAudio16k(
  plan: EpisodePlan,
  tools: Pick<ToolPaths, 'vspipe'>,
  cacheDir: string,
  signal?: AbortSignal,
): Promise<Int16Array> {
  signal?.throwIfAborted();
  const cache = resolve(cacheDir);
  await mkdir(cache, { recursive: true });
  const dir = await mkdtemp(join(tmpdir(), 'seikou-speech-'));
  try {
    const script = join(dir, 'speech.vpy');
    await writeFile(script, buildSpeechAudioScript(plan, { cacheDir: cache }));
    const pcm = await runVspipe(tools.vspipe, script, signal);
    checkLength(plan, pcm.length);
    return pcm;
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/**
 * A `PlaylistAudioReader` over an episode decoded by `decodeEpisodeAudio16k`, with the episode's
 * own time as playlist time. `'whole'` returns the PCM itself from 0 ms (not a copy: do not modify
 * it). Spans return one window from the first span's start to the last span's end, holding the
 * episode's samples inside each span and zeros between spans and past the episode's end. Rejects
 * with the signal's reason when `signal` has aborted.
 */
export function episodeReader(pcm16k: Int16Array): PlaylistAudioReader {
  return async (spans, signal): Promise<AudioWindow> => {
    signal?.throwIfAborted();
    if (spans === 'whole') return { startMs: 0, pcm: pcm16k };
    if (spans.length === 0) return { startMs: 0, pcm: new Int16Array(0) };
    const startMs = spans[0].fromMs;
    const start16k = Math.round(startMs * SAMPLES_PER_MS);
    const pcm = new Int16Array(Math.max(0, Math.round(spans[spans.length - 1].toMs * SAMPLES_PER_MS) - start16k));
    for (const span of spans) {
      const from16k = Math.max(0, start16k, Math.round(span.fromMs * SAMPLES_PER_MS));
      const to16k = Math.min(pcm16k.length, start16k + pcm.length, Math.round(span.toMs * SAMPLES_PER_MS));
      if (to16k > from16k) pcm.set(pcm16k.subarray(from16k, to16k), from16k - start16k);
    }
    return { startMs, pcm };
  };
}
