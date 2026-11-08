import { spawnSync } from 'node:child_process';
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { episodeAudio, type AudioWindow } from '@seikou/fansubs/disc-audio';
import { SPEECH_BURSTS } from '../../../tests/helpers/speech-bursts';
import { folderDiscSource, type LevelDiscSource } from '../levels/level-discs';
import { ALIGN_FFMPEG, ffmpegAudioDecoder } from './ffmpeg-decoder';

const priorities = vi.hoisted(() => [] as [number, number][]);
vi.mock('node:os', async (importOriginal) => {
  const os = await importOriginal<typeof import('node:os')>();
  return { ...os, setPriority: (pid: number, nice: number) => { priorities.push([pid, nice]); } };
});

const hasAc3 = spawnSync('ffmpeg', ['-hide_banner', '-decoders'], { encoding: 'utf8' }).stdout?.includes(' ac3 ') ?? false;
/** CI installs ffmpeg: there, a missing AC-3 decoder fails these tests instead of skipping them. */
const runFfmpegTests = hasAc3 || Boolean(process.env.CI);

const ffmpeg = ffmpegAudioDecoder('ffmpeg');
const disc = folderDiscSource(join(import.meta.dirname, '../../../fixtures/synthetic/disc-speech'), { id: 'speech', name: 'Speech' });

/** The share of the window's 10 ms frames that are loud (RMS above -35 dBFS) exactly where a burst is, give or take 20 ms. */
function agreement(w: AudioWindow): { frames: number; share: number } {
  const frame = 160;
  let agree = 0;
  const frames = Math.floor(w.pcm.length / frame);
  for (let i = 0; i < frames; i++) {
    let sum = 0;
    for (let j = 0; j < frame; j++) sum += (w.pcm[i * frame + j] / 32768) ** 2;
    const loud = 20 * Math.log10(Math.sqrt(sum / frame) + 1e-9) > -35;
    const from = w.startMs + i * 10;
    const inBurst = SPEECH_BURSTS.some((b) => from >= b.fromMs - 20 && from + 10 <= b.toMs + 20);
    const nearEdge = SPEECH_BURSTS.some((b) => Math.abs(from - b.fromMs) < 20 || Math.abs(from + 10 - b.toMs) < 20);
    if (loud === inBurst || nearEdge) agree++;
  }
  return { frames, share: agree / frames };
}

/** The shift of the window's start (a multiple of 5 ms, within 100 ms) at which its loud frames agree best with the bursts. */
function bestShiftMs(w: AudioWindow): number {
  let best = 0;
  let bestAgree = -1;
  for (let shift = -100; shift <= 100; shift += 5) {
    let agree = 0;
    for (let i = 0; i < Math.floor(w.pcm.length / 160); i++) {
      let sum = 0;
      for (let j = 0; j < 160; j++) sum += (w.pcm[i * 160 + j] / 32768) ** 2;
      const loud = 10 * Math.log10(sum / 160 + 1e-12) > -35;
      const from = w.startMs + shift + i * 10;
      if (loud === SPEECH_BURSTS.some((b) => from >= b.fromMs && from + 10 <= b.toMs)) agree++;
    }
    if (agree > bestAgree) {
      bestAgree = agree;
      best = shift;
    }
  }
  return best;
}

describe.skipIf(!runFfmpegTests)('episodeAudio', () => {
  it('waits for one of the two alignment slots, and runs ffmpeg at nice 10', async () => {
    const releases: (() => void)[] = [];
    const held = [0, 1].map(() => ALIGN_FFMPEG.run(() => new Promise<void>((r) => { releases.push(r); })));
    priorities.length = 0;
    const work = episodeAudio(disc, '00000', [{ fromMs: 20_000, toMs: 25_000 }], ffmpeg);
    await new Promise((r) => setTimeout(r, 100));
    expect(ALIGN_FFMPEG.queued).toBe(1);
    expect(priorities).toEqual([]);
    releases[0]!();
    const [w] = await work;
    expect(w.pcm.length).toBe(5_000 * 16);
    expect(priorities).toEqual([[expect.any(Number), 10]]);
    releases[1]!();
    await Promise.all(held);
  });

  it("a window's loud samples sit on the bursts", async () => {
    const [w] = await episodeAudio(disc, '00000', [{ fromMs: 20_000, toMs: 50_000 }], ffmpeg);
    expect(w.startMs).toBe(20_000);
    expect(w.pcm.length).toBe(30_000 * 16);
    const { frames, share } = agreement(w);
    expect(frames).toBe(3000);
    expect(share).toBeGreaterThanOrEqual(0.95);
  });

  it('a window across the clip boundary', async () => {
    const [w] = await episodeAudio(disc, '00000', [{ fromMs: 85_000, toMs: 100_000 }], ffmpeg);
    expect(w.pcm.length).toBe(15_000 * 16);
    expect(agreement(w).share).toBeGreaterThanOrEqual(0.95);
  });

  it('places samples within 10 ms of their playlist time, in both clips', async () => {
    for (const window of [{ fromMs: 20_000, toMs: 50_000 }, { fromMs: 90_000, toMs: 140_000 }]) {
      const [w] = await episodeAudio(disc, '00000', [window], ffmpeg);
      expect(Math.abs(bestShiftMs(w))).toBeLessThanOrEqual(10);
    }
  });

  it('the whole episode', async () => {
    const [w] = await episodeAudio(disc, '00000', 'whole', ffmpeg);
    expect(w.startMs).toBe(0);
    expect(w.pcm.length).toBe(150_000 * 16);
    expect(agreement(w).share).toBeGreaterThanOrEqual(0.95);
  });
});

/** The disc with the packets of one PID dropped from a byte range of the first clip: a stretch of audio the clip lost. */
function withoutAudio(from: number, to: number): LevelDiscSource {
  return {
    ...disc,
    manifest: () => disc.manifest(),
    readFile: (path) => disc.readFile(path),
    readRange: (path, offset, length) => disc.readRange(path, offset, length),
    async clip(path) {
      const clip = await disc.clip(path);
      if (!clip || !path.endsWith('00001.m2ts')) return clip;
      return {
        ...clip,
        read: (a, b) =>
          Readable.from((async function* () {
            const chunks: Buffer[] = [];
            for await (const chunk of clip.read(a, b) as AsyncIterable<Buffer>) chunks.push(chunk);
            const bytes = Buffer.concat(chunks);
            const kept: Buffer[] = [];
            for (let o = 0; o < bytes.length; o += 192) {
              const pid = ((bytes[o + 5] & 0x1f) << 8) | bytes[o + 6];
              const spn = a / 192 + o / 192;
              if (!(pid === 0x1100 && spn >= from && spn < to)) kept.push(bytes.subarray(o, o + 192));
            }
            yield Buffer.concat(kept);
          })()),
      };
    },
  };
}

describe.skipIf(!runFfmpegTests)('episodeAudio failures', () => {
  const scratch = mkdtempSync(join(tmpdir(), 'disc-audio-test-'));
  afterAll(() => rmSync(scratch, { recursive: true, force: true }));
  const script = (name: string, body: string): string => {
    const path = join(scratch, name);
    writeFileSync(path, `#!/bin/sh\n${body}\n`);
    chmodSync(path, 0o755);
    return path;
  };
  const window = [{ fromMs: 20_000, toMs: 50_000 }];

  it('rejects, without hanging, when ffmpeg exits before reading its input', async () => {
    await expect(episodeAudio(disc, '00000', window, ffmpegAudioDecoder(script('exit1.sh', 'exit 1')))).rejects.toThrow(/ffmpeg exited 1/);
  });

  it('rejects when ffmpeg cannot be started', async () => {
    await expect(episodeAudio(disc, '00000', window, ffmpegAudioDecoder(join(scratch, 'no-such-ffmpeg')))).rejects.toThrow();
  });

  it('rejects when the audio stream is not on the clip', async () => {
    const source: LevelDiscSource = { ...disc, readFile: async (path) => {
      const bytes = await disc.readFile(path);
      if (!bytes || !path.endsWith('.mpls')) return bytes;
      const copy = new Uint8Array(bytes);
      // The one stream entry for PID 0x1100 names a PID the clip doesn't carry.
      for (let i = 0; i + 1 < copy.length; i++) if (copy[i] === 0x11 && copy[i + 1] === 0x00) copy[i + 1] = 0x77;
      return copy;
    } };
    await expect(episodeAudio(source, '00000', window, ffmpeg)).rejects.toThrow(/ffmpeg exited|no audio PES/);
  });

  it('kills ffmpeg and rejects when aborted mid-window', async () => {
    const pidFile = join(scratch, 'pid');
    const slow = script('slow.sh', `echo $$ > ${pidFile}\nsleep 30`);
    const controller = new AbortController();
    const run = episodeAudio(disc, '00000', window, ffmpegAudioDecoder(slow), controller.signal);
    // Waits for the stand-in to be running, not for a fixed time: under a full test run it can take longer to start.
    const pidOf = (): number => Number(spawnSync('cat', [pidFile], { encoding: 'utf8' }).stdout);
    await expect.poll(pidOf, { timeout: 10_000 }).toBeGreaterThan(0);
    const pid = pidOf();
    controller.abort();
    await expect(run).rejects.toThrow();
    const alive = (): boolean => {
      try {
        process.kill(pid, 0);
        return true;
      } catch {
        return false;
      }
    };
    await expect.poll(alive, { timeout: 5_000 }).toBe(false);
  });

  it('refuses a window whose audio lost frames, instead of shifting what follows', async () => {
    // About 0.2 s of audio packets are gone from the middle of the window.
    const lossy = withoutAudio(5000, 5030);
    await expect(episodeAudio(lossy, '00000', [{ fromMs: 20_000, toMs: 60_000 }], ffmpeg)).rejects.toThrow(/damaged or lost/);
    // The same window of the whole disc decodes.
    await expect(episodeAudio(disc, '00000', [{ fromMs: 20_000, toMs: 60_000 }], ffmpeg)).resolves.toHaveLength(1);
  });

  it('decodes the AC-3 core of a TrueHD stream, placed by its PTS', async () => {
    const truehd = folderDiscSource(join(import.meta.dirname, '../../../fixtures/synthetic/disc3'), { id: 'd3', name: 'Audio' });
    const [w] = await episodeAudio(truehd, '00000', [{ fromMs: 2_000, toMs: 8_000 }], ffmpeg, undefined, { audioIndex: 2 });
    expect(w.startMs).toBe(2_000);
    expect(w.pcm.length).toBe(6_000 * 16);
    let peak = 0;
    for (const v of w.pcm) peak = Math.max(peak, Math.abs(v));
    expect(peak).toBeGreaterThan(3000);
    const head = w.pcm.subarray(0, 160);
    expect(head.some((v) => Math.abs(v) > 100)).toBe(true); // sound from the first 10 ms: no leading silence from a late sync
  });
});
