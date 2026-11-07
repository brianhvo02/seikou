import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { CodingType } from '@seikou/bdmv/stream-types';
import { folderDiscSource } from '../levels/level-discs';
import { ffmpegAudioDecoder } from './ffmpeg-decoder';

const hasAc3 = spawnSync('ffmpeg', ['-hide_banner', '-decoders'], { encoding: 'utf8' }).stdout?.includes(' ac3 ') ?? false;
/** CI installs ffmpeg: there, a missing AC-3 decoder fails these tests instead of skipping them. */
const runFfmpegTests = hasAc3 || Boolean(process.env.CI);

const disc = folderDiscSource(join(import.meta.dirname, '../../../fixtures/synthetic/disc-speech'), { id: 'speech', name: 'Speech' });

describe.skipIf(!runFfmpegTests)('ffmpegAudioDecoder', () => {
  it('decodes the fixture clip to 16 kHz mono with the first PTS', async () => {
    const clip = await disc.clip('BDMV/STREAM/00001.m2ts');
    const decode = ffmpegAudioDecoder('ffmpeg');
    // The first 192 * 2000 bytes: whole source packets from the head of the clip.
    const { firstPts, pcm } = await decode({ read: clip!.read(0, 192 * 2000), pid: 0x1100, coding: CodingType.AC3 });
    expect(firstPts).toBeGreaterThan(0);
    expect(pcm.length).toBeGreaterThan(16_000); // over a second at 16 kHz mono
    let peak = 0;
    for (const v of pcm) peak = Math.max(peak, Math.abs(v));
    expect(peak).toBeGreaterThan(0);
  });

  it('rejects when the range holds no audio of the PID', async () => {
    const clip = await disc.clip('BDMV/STREAM/00001.m2ts');
    await expect(ffmpegAudioDecoder('ffmpeg')({ read: clip!.read(0, 192 * 2000), pid: 0x1777, coding: CodingType.AC3 })).rejects.toThrow(/ffmpeg exited|no audio PES/);
  });
});
