// SPDX-License-Identifier: LGPL-3.0-or-later
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
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
    const ours = (): string[] => fs.readdirSync(os.tmpdir()).filter((n) => n.startsWith('seikou-speech-'));
    const before = ours().length;
    await expect(decodeEpisodeAudio16k(broken, tools, os.tmpdir())).rejects.toThrow(/vspipe failed \(exit code \d+\): \S/);
    expect(ours().length).toBe(before);
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
