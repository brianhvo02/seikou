// SPDX-License-Identifier: LGPL-3.0-or-later
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SPEECH_BURSTS } from '../../../tests/helpers/speech-bursts';
import { decodeEpisodeAudio16k, episodeReader } from '../../src/audio/episode-audio';
import { loadPlaylist } from '../../src/disc/playlist';
import { probeClip, type ClipProbe } from '../../src/disc/probe';
import { parseEpisodeSpec, planEpisodes, type EpisodePlan } from '../../src/plan/episodes';
import { haveTools, toolPaths } from '../helpers/tools';
import { fx } from '../paths';

async function speechPlan(spec: string): Promise<EpisodePlan> {
  const playlist = await loadPlaylist(fx('fixtures/disc-speech'), '00000');
  const probes = new Map<string, ClipProbe>();
  for (const item of playlist.items) if (!probes.has(item.clipId)) probes.set(item.clipId, await probeClip(item));
  return planEpisodes(playlist, probes, parseEpisodeSpec(spec, playlist.chapters.length), playlist.items[0].audioPids[0])[0];
}

function meanAbs(pcm: Int16Array, from: number, to: number): number {
  let sum = 0;
  for (let i = from; i < to; i++) sum += Math.abs(pcm[i]);
  return sum / Math.max(1, to - from);
}

const average = (xs: number[]): number => xs.reduce((s, x) => s + x, 0) / xs.length;

describe('episodeReader', () => {
  const ramp = Int16Array.from({ length: 16000 * 5 }, (_, i) => i % 30000);

  it('slices a span out of the decoded episode', async () => {
    const w = await episodeReader(ramp)([{ fromMs: 1000, toMs: 2000 }]);
    expect(w.startMs).toBe(1000);
    expect(w.pcm).toHaveLength(16000);
    expect(Array.from(w.pcm)).toEqual(Array.from(ramp.subarray(16000, 32000)));
  });

  it('returns one window over several spans, zero between them and past the end', async () => {
    const w = await episodeReader(ramp)([
      { fromMs: 1000, toMs: 1500 },
      { fromMs: 2000, toMs: 2500 },
      { fromMs: 4900, toMs: 5100 },
    ]);
    expect(w.startMs).toBe(1000);
    expect(w.pcm).toHaveLength(4100 * 16);
    expect(Array.from(w.pcm.subarray(0, 8000))).toEqual(Array.from(ramp.subarray(16000, 24000)));
    expect(w.pcm.subarray(8000, 16000).every((v) => v === 0)).toBe(true);
    expect(Array.from(w.pcm.subarray(16000, 24000))).toEqual(Array.from(ramp.subarray(32000, 40000)));
    expect(Array.from(w.pcm.subarray(3900 * 16, 4000 * 16))).toEqual(Array.from(ramp.subarray(4900 * 16, 5000 * 16)));
    expect(w.pcm.subarray(4000 * 16).every((v) => v === 0)).toBe(true);
  });

  it("returns the whole episode from 0 for 'whole'", async () => {
    const w = await episodeReader(ramp)('whole');
    expect(w.startMs).toBe(0);
    expect(w.pcm).toBe(ramp);
  });

  it('rejects when the signal is already aborted', async () => {
    const ac = new AbortController();
    ac.abort(new Error('stop'));
    await expect(episodeReader(ramp)('whole', ac.signal)).rejects.toThrow('stop');
  });
});

/** A 16 kHz mono 16-bit WAV whose header declares `declaredFrames` (null: streamed) and which holds `frames` frames, then `extraBytes` more. */
function wavFile(dir: string, frames: number, declaredFrames: number | null, extraBytes = 0): string {
  const head = Buffer.alloc(44);
  head.write('RIFF', 0, 'latin1');
  head.writeUInt32LE(0xffffffff, 4);
  head.write('WAVEfmt ', 8, 'latin1');
  head.writeUInt32LE(16, 16);
  head.writeUInt16LE(1, 20);
  head.writeUInt16LE(1, 22);
  head.writeUInt32LE(16000, 24);
  head.writeUInt32LE(32000, 28);
  head.writeUInt16LE(2, 32);
  head.writeUInt16LE(16, 34);
  head.write('data', 36, 'latin1');
  head.writeUInt32LE(declaredFrames === null ? 0xffffffff : declaredFrames * 2, 40);
  const file = path.join(dir, 'fake.wav');
  fs.writeFileSync(file, Buffer.concat([head, Buffer.alloc(frames * 2), Buffer.alloc(extraBytes)]));
  return file;
}

describe('decodeEpisodeAudio16k with a stand-in vspipe', () => {
  const fakeVspipe = { vspipe: fx('tests/fake-bin/vspipe-wav') };
  let dir = '';
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'episode-audio-fake-'));
  });
  afterEach(() => {
    delete process.env.FAKE_WAV;
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('settles when vspipe writes past the declared data size (it is drained, not left blocked on a full pipe)', async () => {
    const plan = await speechPlan('1-3');
    process.env.FAKE_WAV = wavFile(dir, 90 * 16000, 90 * 16000, 4 << 20);
    const pcm = await decodeEpisodeAudio16k(plan, fakeVspipe, dir);
    expect(pcm).toHaveLength(90 * 16000);
  }, 15_000);

  it('throws naming both lengths when the decode is shorter than the episode', async () => {
    const plan = await speechPlan('1-3');
    process.env.FAKE_WAV = wavFile(dir, 80 * 16000, null);
    await expect(decodeEpisodeAudio16k(plan, fakeVspipe, dir)).rejects.toThrow(/1280000.*1440000|1440000.*1280000/);
  });

  it('accepts a decode short by less than one video frame', async () => {
    const plan = await speechPlan('1-3');
    // One frame at 24 fps is 666.7 samples at 16 kHz.
    process.env.FAKE_WAV = wavFile(dir, 90 * 16000 - 600, null);
    expect(await decodeEpisodeAudio16k(plan, fakeVspipe, dir)).toHaveLength(90 * 16000 - 600);
  });
});

describe('decodeEpisodeAudio16k without vspipe', () => {
  it('rejects with a ChainError when vspipe cannot start', async () => {
    const plan = await speechPlan('1-3');
    const cache = fs.mkdtempSync(path.join(os.tmpdir(), 'episode-audio-cache-'));
    try {
      await expect(decodeEpisodeAudio16k(plan, { vspipe: path.join(cache, 'no-such-vspipe') }, cache)).rejects.toMatchObject({
        name: 'ChainError',
        tool: 'vspipe',
        stderrTail: expect.stringContaining('ENOENT'),
      });
    } finally {
      fs.rmSync(cache, { recursive: true, force: true });
    }
  });
});

describe.skipIf(!haveTools)('decodeEpisodeAudio16k with vspipe and BestSource', () => {
  it('decodes chapters 1-3 of the speech disc to 90 s of 16 kHz mono with the bursts where they belong', async () => {
    const plan = await speechPlan('1-3');
    const tools = toolPaths();
    if (tools === null) throw new Error('tools vanished');
    const cache = fs.mkdtempSync(path.join(os.tmpdir(), 'episode-audio-cache-'));
    try {
      const pcm = await decodeEpisodeAudio16k(plan, tools, cache);
      expect(Math.abs(pcm.length - 90 * 16000)).toBeLessThanOrEqual(1);
      const inside: number[] = [];
      const gaps: number[] = [];
      let prevEnd = 0;
      for (const b of SPEECH_BURSTS.filter((s) => s.toMs <= 90_000)) {
        inside.push(meanAbs(pcm, b.fromMs * 16, b.toMs * 16));
        // Leave 50 ms each side of a burst out of the gaps, for the codec's and the filter's spread.
        if (b.fromMs - prevEnd > 200) gaps.push(meanAbs(pcm, (prevEnd + 50) * 16, (b.fromMs - 50) * 16));
        prevEnd = b.toMs;
      }
      expect(average(inside)).toBeGreaterThan(100);
      expect(average(inside)).toBeGreaterThan(10 * average(gaps));
    } finally {
      fs.rmSync(cache, { recursive: true, force: true });
    }
  });

  it("throws with vspipe's stderr when it fails, and removes its script folder", async () => {
    const plan = await speechPlan('1-3');
    const tools = toolPaths();
    if (tools === null) throw new Error('tools vanished');
    const broken: EpisodePlan = {
      ...plan,
      segments: plan.segments.map((s) => ({ ...s, item: { ...s.item, m2tsPath: '/nonexistent/00001.m2ts' } })),
    };
    // A private temporary folder: other test files decode in parallel and make their own script folders.
    const savedTmp = process.env.TMPDIR;
    const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'episode-audio-tmp-')));
    process.env.TMPDIR = tmp;
    try {
      const ours = (): string[] => fs.readdirSync(tmp).filter((n) => n.startsWith('seikou-speech-'));
      await expect(decodeEpisodeAudio16k(broken, tools, path.join(tmp, 'cache'))).rejects.toThrow(/vspipe failed \(exit code \d+\): \S/);
      expect(ours()).toEqual([]);
    } finally {
      if (savedTmp === undefined) delete process.env.TMPDIR;
      else process.env.TMPDIR = savedTmp;
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('stops vspipe and rejects with the reason when aborted', async () => {
    const plan = await speechPlan('1-3');
    const tools = toolPaths();
    if (tools === null) throw new Error('tools vanished');
    const cache = fs.mkdtempSync(path.join(os.tmpdir(), 'episode-audio-cache-'));
    try {
      const ac = new AbortController();
      const run = decodeEpisodeAudio16k(plan, tools, cache, ac.signal);
      setTimeout(() => ac.abort(new Error('user stopped')), 20);
      await expect(run).rejects.toThrow('user stopped');
    } finally {
      fs.rmSync(cache, { recursive: true, force: true });
    }
  });
});
