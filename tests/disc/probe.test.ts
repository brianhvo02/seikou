// SPDX-License-Identifier: LGPL-3.0-or-later
import { expect, it } from 'vitest';
import { loadPlaylist } from '../../src/disc/playlist';
import { ProbeError, probeClip } from '../../src/disc/probe';

it('finds first timestamps and stream parameters of clip 00001', async () => {
  const p = await loadPlaylist('fixtures/disc1', '00000');
  const probe = await probeClip(p.items[0]);
  expect(probe.clipId).toBe('00001');
  expect(probe.video).toEqual({ pid: 4113, firstPts90: 900000, fpsNum: 24000, fpsDen: 1001, width: 1920, height: 1080, interlaced: false, codingType: 27 });
  expect(probe.audio).toEqual([{ pid: 4352, firstPts90: 900000, sampleRate: 48000, channels: 2, codingType: 128 }]);
});

it('throws ProbeError naming the clip and PID when a PID has no CLPI entry or never appears', async () => {
  const p = await loadPlaylist('fixtures/disc1', '00000');
  const item = p.items[0];
  await expect(probeClip({ ...item, audioPids: [4352, 4999] })).rejects.toThrow(ProbeError);
  await expect(probeClip({ ...item, audioPids: [4352, 4999] })).rejects.toThrow(/00001.*4999/);
});
