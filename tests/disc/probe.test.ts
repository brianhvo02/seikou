// SPDX-License-Identifier: LGPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import { loadPlaylist } from '../../src/disc/playlist';
import { ProbeError, probeClip } from '../../src/disc/probe';

const expectedVideo = { pid: 4113, firstPts90: 900000, fpsNum: 24000, fpsDen: 1001, width: 1920, height: 1080, interlaced: false, codingType: 27 };
const expectedAudio = [{ pid: 4352, firstPts90: 900000, sampleRate: 48000, channels: 2, codingType: 128 }];

describe('probeClip', () => {
  it('finds first timestamps and stream parameters of clip 00001', async () => {
    const p = await loadPlaylist('fixtures/disc1', '00000');
    const probe = await probeClip(p.items[0]);
    expect(probe.clipId).toBe('00001');
    expect(probe.video).toEqual(expectedVideo);
    expect(probe.audio).toEqual(expectedAudio);
  });

  it.each([1, 2, 4, 7])('gives the same result when PES packets span chunks of %i packets', async (chunkPackets) => {
    const p = await loadPlaylist('fixtures/disc1', '00000');
    const probe = await probeClip(p.items[0], chunkPackets);
    expect(probe.video).toEqual(expectedVideo);
    expect(probe.audio).toEqual(expectedAudio);
  });

  it('throws ProbeError naming the clip and PID when the PID has no CLPI entry', async () => {
    const p = await loadPlaylist('fixtures/disc1', '00000');
    const result = probeClip({ ...p.items[0], audioPids: [4352, 4999] });
    await expect(result).rejects.toThrow(ProbeError);
    await expect(result).rejects.toThrow(/00001.*4999/);
  });

  it('throws ProbeError naming the clip and PID when the m2ts never produces a PES for it', async () => {
    const p = await loadPlaylist('fixtures/disc1', '00000');
    const item = p.items[0];
    const first = item.clpi.programs[0];
    const extra = { ...first.streams.find((s) => s.pid === 4352)!, pid: 4999 };
    const clpi = { ...item.clpi, programs: [{ ...first, streams: [...first.streams, extra] }, ...item.clpi.programs.slice(1)] };
    const result = probeClip({ ...item, clpi, audioPids: [4352, 4999] });
    await expect(result).rejects.toThrow(ProbeError);
    await expect(result).rejects.toThrow(/00001.*4999/);
  });
});
