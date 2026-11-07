import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { CodingType } from '@seikou/bdmv/stream-types';
import { createReadStream } from 'node:fs';
import { demuxAudioPid, episodeAudio } from '@seikou/fansubs/disc-audio';
import { folderDiscSource } from '../levels/level-discs';
import { ALIGN_FFMPEG, ffmpegAudioDecoder } from './ffmpeg-decoder';

const hasAc3 = spawnSync('ffmpeg', ['-hide_banner', '-decoders'], { encoding: 'utf8' }).stdout?.includes(' ac3 ') ?? false;
/** CI installs ffmpeg: there, a missing AC-3 decoder fails these tests instead of skipping them. */
const runFfmpegTests = hasAc3 || Boolean(process.env.CI);

const disc = folderDiscSource(join(import.meta.dirname, '../../../fixtures/synthetic/disc-speech'), { id: 'speech', name: 'Speech' });

describe('ffmpegAudioDecoder queueing', () => {
  it('opens nothing while queued: a source that fails to open rejects that one call, with no uncaught error', async () => {
    const releases: (() => void)[] = [];
    const held = [0, 1].map(() => ALIGN_FFMPEG.run(() => new Promise<void>((r) => { releases.push(r); })));
    const broken = { ...disc, clip: async (path: string) => {
      const clip = await disc.clip(path);
      return clip && { ...clip, read: () => createReadStream(join(import.meta.dirname, 'no-such-clip.m2ts')) };
    } };
    const run = episodeAudio(broken, '00000', [{ fromMs: 20_000, toMs: 25_000 }], ffmpegAudioDecoder('ffmpeg'));
    const outcome = run.then(() => null, (err: unknown) => err);
    await new Promise((r) => setTimeout(r, 200)); // an unhandled 'error' from a stream opened too early would fail the run here
    expect(ALIGN_FFMPEG.queued).toBe(1);
    releases.forEach((release) => release());
    await Promise.all(held);
    expect(await outcome).toMatchObject({ code: 'ENOENT' });
  });
});

describe.skipIf(!runFfmpegTests)('ffmpegAudioDecoder', () => {
  it('decodes the fixture clip to 16 kHz mono with the first PTS', async () => {
    const clip = await disc.clip('BDMV/STREAM/00001.m2ts');
    const decode = ffmpegAudioDecoder('ffmpeg');
    // The first 192 * 2000 bytes: whole source packets from the head of the clip.
    const { firstPts, pcm } = await decode({ read: clip!.read(0, 192 * 2000), pid: 0x1100, coding: CodingType.AC3 });
    expect(firstPts).toBeGreaterThan(0);
    // The PCM is as long as the PES packets it came from: 16 kHz mono, not another rate or two channels.
    const pesPts: number[] = [];
    await demuxAudioPid(clip!.read(0, 192 * 2000), 0x1100, false, async () => true, pesPts);
    const step = pesPts[pesPts.length - 1]! - pesPts[pesPts.length - 2]!;
    const spanMs = (pesPts[pesPts.length - 1]! + step - pesPts[0]!) / 90;
    expect(pcm.length).toBeGreaterThan(16_000);
    expect(Math.abs(pcm.length - spanMs * 16)).toBeLessThanOrEqual((step / 90) * 16 * 2);
    let peak = 0;
    for (const v of pcm) peak = Math.max(peak, Math.abs(v));
    expect(peak).toBeGreaterThan(0);
  });

  it('rejects when the range holds no audio of the PID', async () => {
    const clip = await disc.clip('BDMV/STREAM/00001.m2ts');
    await expect(ffmpegAudioDecoder('ffmpeg')({ read: clip!.read(0, 192 * 2000), pid: 0x1777, coding: CodingType.AC3 })).rejects.toThrow(/ffmpeg exited|no audio PES/);
  });
});
