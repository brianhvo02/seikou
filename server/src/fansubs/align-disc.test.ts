import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { align, alignWhole, alignWindows, sliceWindow } from '@seikou/fansubs/align';
import { dialogueIntervals } from '@seikou/fansubs/dialogue';
import { episodeAudio } from '@seikou/fansubs/disc-audio';
import { script, unrelatedSpans } from '../../../tests/helpers/fansub-script';
import { SPEECH_BURSTS } from '../../../tests/helpers/speech-bursts';
import { folderDiscSource } from '../levels/level-discs';
import { ffmpegAudioDecoder } from './ffmpeg-decoder';

const hasAc3 = spawnSync('ffmpeg', ['-hide_banner', '-decoders'], { encoding: 'utf8' }).stdout?.includes(' ac3 ') ?? false;
/** CI installs ffmpeg: there, a missing AC-3 decoder fails these tests instead of skipping them. */
const runFfmpegTests = hasAc3 || Boolean(process.env.CI);

const disc = folderDiscSource(join(import.meta.dirname, '../../../fixtures/synthetic/disc-speech'), { id: 'speech', name: 'Speech' });
const DURATION_MS = 150_000;
const ffmpeg = ffmpegAudioDecoder('ffmpeg');

describe.skipIf(!runFfmpegTests)('align (ffmpeg, on the speech disc)', () => {
  it('finds a known offset', async () => {
    const result = await align(disc, '00000', DURATION_MS, script(SPEECH_BURSTS, () => 1230), ffmpeg);
    expect(result.kind).toBe('offset');
    if (result.kind !== 'offset') return;
    expect(Math.abs(result.offsetMs + 1230)).toBeLessThanOrEqual(20);
    expect(result.confidence).toBeGreaterThanOrEqual(0.55);
  });

  it('finds zero', async () => {
    const result = await align(disc, '00000', DURATION_MS, script(SPEECH_BURSTS), ffmpeg);
    expect(result.kind).toBe('offset');
    if (result.kind !== 'offset') return;
    expect(Math.abs(result.offsetMs)).toBeLessThanOrEqual(20);
  });

  const splitAss = script(SPEECH_BURSTS, (fromMs) => (fromMs >= 70_000 ? 2000 : 0));
  const expectSplit = (result: Awaited<ReturnType<typeof align>>): void => {
    expect(result.kind).toBe('split');
    if (result.kind !== 'split') return;
    expect(result.parts).toHaveLength(2);
    expect(result.parts[0].fromMs).toBe(0);
    expect(Math.abs(result.parts[0].offsetMs)).toBeLessThanOrEqual(20);
    expect(Math.abs(result.parts[1].offsetMs + 2000)).toBeLessThanOrEqual(20);
    expect(Math.abs(result.parts[1].fromMs - 72_000)).toBeLessThanOrEqual(5000);
  };

  it('finds a split (alignWhole on the whole episode)', async () => {
    const [whole] = await episodeAudio(disc, '00000', 'whole', ffmpeg);
    const dialogue = dialogueIntervals(splitAss);
    const { perWindow, agree } = alignWindows({ windows: sliceWindow(whole, 30_000), dialogue });
    expect(agree).toBe(false);
    expectSplit(alignWhole({ windows: [whole], dialogue }, perWindow));
  });

  it('finds a split (align, sampled windows that disagree, then the whole episode)', async () => {
    const windows = [0, 30_000, 60_000, 90_000, 120_000].map((fromMs) => ({ fromMs, toMs: fromMs + 30_000 }));
    expectSplit(await align(disc, '00000', DURATION_MS, splitAss, ffmpeg, undefined, { windows }));
  });

  it('finds a split (align, an episode short enough to be one window)', async () => {
    expectSplit(await align(disc, '00000', DURATION_MS, splitAss, ffmpeg));
  });

  // A fansubber's timing: lines start 300 ms before their speech and run 30 % past it. The lines then hold their speech
  // over a run of offsets (from minus the shortest tail to plus the lead-in), and the middle of that run is taken: here
  // (300 - 0.3 × 880) / 2 = 18 ms from the truth. The bound held is ±50 ms.
  const leadIn = (shiftMs: number): { fromMs: number; toMs: number }[] =>
    SPEECH_BURSTS.map((b) => ({ fromMs: b.fromMs - 300 + shiftMs, toMs: b.toMs + Math.round((0.3 * (b.toMs - b.fromMs)) / 10) * 10 + shiftMs }));

  it("finds a known offset through a fansubber's lead-in and lead-out", async () => {
    const result = await align(disc, '00000', DURATION_MS, script(leadIn(1230)), ffmpeg);
    expect(result.kind).toBe('offset');
    if (result.kind === 'offset') expect(Math.abs(result.offsetMs + 1230)).toBeLessThanOrEqual(50);
  });

  it("finds a known offset through a fansubber's lead-in and lead-out (sampled windows)", async () => {
    const windows = [0, 30_000, 60_000, 90_000, 120_000].map((fromMs) => ({ fromMs, toMs: fromMs + 30_000 }));
    const result = await align(disc, '00000', DURATION_MS, script(leadIn(1230)), ffmpeg, undefined, { windows });
    expect(result.kind).toBe('offset');
    if (result.kind === 'offset') expect(Math.abs(result.offsetMs + 1230)).toBeLessThanOrEqual(50);
  });

  it("places every sampled window near the truth through a fansubber's lead-in and lead-out", async () => {
    // Long lines covering most of the episode: a score of precision alone fits a window's lines into its speech tens of
    // seconds away. The speech the lines would miss must count against such an offset.
    const [whole] = await episodeAudio(disc, '00000', 'whole', ffmpeg);
    const dialogue = dialogueIntervals(script(leadIn(0)));
    const { perWindow, agree } = alignWindows({ windows: sliceWindow(whole, 30_000), dialogue });
    expect(agree).toBe(true);
    for (const w of perWindow) {
      expect(w.score).toBeGreaterThanOrEqual(0.4);
      expect(Math.abs(w.offsetMs), `window at ${w.startMs}`).toBeLessThanOrEqual(300);
    }
  });

  it('refuses a gradual drift', async () => {
    // The track drifts by 1 s over the episode: neighbouring windows are 200 ms apart, the ends 800 ms.
    const drift = script(SPEECH_BURSTS, (fromMs) => Math.round(fromMs / 1500) * 10);
    const windows = [0, 30_000, 60_000, 90_000, 120_000].map((fromMs) => ({ fromMs, toMs: fromMs + 30_000 }));
    expect(await align(disc, '00000', DURATION_MS, drift, ffmpeg, undefined, { windows })).toEqual({ kind: 'none', reason: 'low-confidence' });
  });

  it('refuses when windows disagree and no split is taken', async () => {
    const windows = [0, 30_000, 60_000, 90_000, 120_000].map((fromMs) => ({ fromMs, toMs: fromMs + 30_000 }));
    // The last four lines are 1 s late: the last window disagrees, but too few lines follow the cut to split on.
    const tail = script(SPEECH_BURSTS, (fromMs) => (fromMs >= 123_000 ? 1000 : 0));
    expect(await align(disc, '00000', DURATION_MS, tail, ffmpeg, undefined, { windows })).toEqual({ kind: 'none', reason: 'low-confidence' });
  });

  it('refuses signs only', async () => {
    const signs = SPEECH_BURSTS.slice(0, 5);
    expect(await align(disc, '00000', DURATION_MS, script(signs, () => 0, 'Signs'), ffmpeg)).toEqual({ kind: 'none', reason: 'no-speech' });
  });

  it('refuses noise', async () => {
    expect(await align(disc, '00000', DURATION_MS, script(unrelatedSpans()), ffmpeg)).toEqual({ kind: 'none', reason: 'low-confidence' });
  });

  it('refuses when fewer than three windows decode', async () => {
    const windows = [0, 30_000, 60_000, 90_000, 120_000].map((fromMs) => ({ fromMs, toMs: fromMs + 30_000 }));
    // Clip 00001 holds [0, 90 s): every window but the last two is gone.
    const broken = { ...disc, clip: async (path: string) => (path.endsWith('00001.m2ts') ? null : disc.clip(path)) };
    const ass = script(SPEECH_BURSTS, () => 1230);
    const logged: string[] = [];
    const log = (message: string): void => void logged.push(message);
    expect(await align(broken, '00000', DURATION_MS, ass, ffmpeg, undefined, { windows, log })).toEqual({ kind: 'none', reason: 'low-confidence' });
    expect(logged).toHaveLength(3);
    expect(logged[0]).toMatch(/skipped 0-30000 ms: .*no clip 00001/);
    // A short episode's one window must decode.
    logged.length = 0;
    expect(await align(broken, '00000', DURATION_MS, ass, ffmpeg, undefined, { log })).toEqual({ kind: 'none', reason: 'low-confidence' });
    expect(logged).toEqual([expect.stringMatching(/skipped the whole episode/)]);
  });

  it('rejects when ffmpeg cannot be started, instead of skipping every window', async () => {
    const logged: string[] = [];
    const run = align(disc, '00000', DURATION_MS, script(SPEECH_BURSTS), ffmpegAudioDecoder(join(import.meta.dirname, 'no-such-ffmpeg')), undefined, { log: (m) => void logged.push(m) });
    await expect(run).rejects.toMatchObject({ code: 'ENOENT' });
    expect(logged).toEqual([]);
  });

  it('rejects when aborted', async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(align(disc, '00000', DURATION_MS, script(SPEECH_BURSTS), ffmpeg, controller.signal)).rejects.toThrow();
  });
});
