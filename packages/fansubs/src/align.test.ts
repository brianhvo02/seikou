import { Readable } from 'node:stream';
import { CodingType } from '@seikou/bdmv/stream-types';
import { describe, expect, it } from 'vitest';
import { buildSyntheticDisc, syntheticClip } from '../../../tests/helpers/synthetic-disc';
import { script } from '../../../tests/helpers/fansub-script';
import { SPEECH_BURSTS } from '../../../tests/helpers/speech-bursts';
import { align, alignAudio, alignWhole, alignWindows, decide } from './align';
import type { PlaylistAudioReader } from './align';
import type { AudioDecoder } from './audio-decoder';
import { demuxAudioPid, type AudioWindow } from './disc-audio';
import type { FansubDiscSource } from './disc-source';

/** A window of quiet noise with loud noise at `bursts` (window-relative ms). */
function noiseWindow(startMs: number, seconds: number, bursts: readonly { fromMs: number; toMs: number }[]): AudioWindow {
  const pcm = new Int16Array(seconds * 16000);
  let seed = startMs + 1;
  const rnd = (): number => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 2 ** 32 - 0.5; };
  for (let i = 0; i < pcm.length; i++) pcm[i] = Math.round(rnd() * 20);
  for (const b of bursts) {
    for (let i = Math.max(0, (b.fromMs - startMs) * 16); i < Math.min(pcm.length, (b.toMs - startMs) * 16); i++) pcm[i] = Math.round(rnd() * 12000);
  }
  return { startMs, pcm };
}

const moved = (ms: number) => SPEECH_BURSTS.map((b) => ({ fromMs: b.fromMs + ms, toMs: b.toMs + ms }));

describe('alignWindows', () => {
  it('agrees when two windows find the same offset', () => {
    // The disc's speech is 500 ms later than the dialogue: offset +500.
    const windows = [noiseWindow(10_000, 30, moved(500)), noiseWindow(80_000, 30, moved(500))];
    const { perWindow, agree } = alignWindows({ windows, dialogue: SPEECH_BURSTS });
    expect(agree).toBe(true);
    for (const w of perWindow) {
      expect(Math.abs(w.offsetMs - 500)).toBeLessThanOrEqual(20);
      expect(w.score).toBeGreaterThan(0.9);
    }
  });

  it('disagrees when one window is at +500 ms and another at -1500 ms', () => {
    const windows = [noiseWindow(10_000, 30, moved(500)), noiseWindow(80_000, 30, moved(-1500))];
    const { perWindow, agree } = alignWindows({ windows, dialogue: SPEECH_BURSTS });
    expect(agree).toBe(false);
    expect(Math.abs(perWindow[0].offsetMs - 500)).toBeLessThanOrEqual(20);
    expect(Math.abs(perWindow[1].offsetMs + 1500)).toBeLessThanOrEqual(20);
  });
});

describe('alignWhole', () => {
  it('refuses when windows disagree and the split gains less than 0.08', () => {
    // 100 bursts; lines start 300 ms early and run 30 % past, and from the 50th on they are 700 ms later. The lines'
    // slack lets one offset fit both halves nearly as well as a split at the 50th line (which is taken by the search but
    // gains about 0.003), while three windows disagree by 700 ms.
    let seed = 11;
    const rnd = (): number => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 2 ** 32; };
    const bursts: { fromMs: number; toMs: number }[] = [];
    let at = 1000;
    while (bursts.length < 100) {
      const len = 1000 + Math.round(rnd() * 150) * 10;
      bursts.push({ fromMs: at, toMs: at + len });
      at += len + 1200 + Math.round(rnd() * 300) * 10;
    }
    const whole = noiseWindow(0, Math.ceil(at / 1000) + 1, bursts);
    const dialogue = bursts.map((b, i) => {
      const late = i >= 50 ? 700 : 0;
      return { fromMs: b.fromMs - 300 + late, toMs: b.toMs + Math.round((0.3 * (b.toMs - b.fromMs)) / 10) * 10 + late };
    });
    const middle = bursts[50]!.fromMs;
    const perWindow = [
      { startMs: middle - 60_000, offsetMs: 0, score: 0.9 },
      { startMs: middle + 1_000, offsetMs: -700, score: 0.9 },
      { startMs: middle + 61_000, offsetMs: -700, score: 0.9 },
    ];
    expect(alignWhole({ windows: [whole], dialogue }, perWindow)).toEqual({ kind: 'none', reason: 'low-confidence' });
    // The same track with windows that agree is one confident offset.
    const agreeing = perWindow.map((w) => ({ ...w, offsetMs: -300 }));
    expect(alignWhole({ windows: [whole], dialogue }, agreeing).kind).toBe('offset');
  });
});

describe('decide', () => {
  it('is confident only with a high score and a clear margin', () => {
    expect(decide(0.8, 0.3)).toBe('confident');
    expect(decide(0.55, 0.1)).toBe('confident');
    expect(decide(0.54, 0.3)).toBe('low');
    expect(decide(0.9, 0.09)).toBe('low');
  });
});

const DURATION_MS = 150_000;
const AUDIO_PID = 0x1100;
const CLIP_START_PTS = 900_000;

/** The speech disc, in memory: one 150 s clip (its audio packets are placeholders) in one playlist. */
const files = buildSyntheticDisc({
  clips: [syntheticClip('00001', 150, { audio: CodingType.AC3, startPts: CLIP_START_PTS })],
  playlists: [{ id: '00000', clipIds: ['00001'] }],
});
const disc: FansubDiscSource = {
  readFile: async (path) => files.get(path) ?? null,
  clip: async (path) => {
    const bytes = files.get(path);
    return bytes ? { read: (from, to) => Readable.from([Buffer.from(bytes.subarray(from, to))]) } : null;
  },
};

/** A decoder that never runs a codec: it reads the range's audio PES times and hands back the speech disc's noise bursts for that stretch. */
const burstsDecoder: AudioDecoder = async ({ read, pid }) => {
  const pesPts: number[] = [];
  const firstPts = await demuxAudioPid(read, pid, false, async () => true, pesPts);
  if (firstPts === null) throw new Error('no audio PES in the byte range');
  const step = pesPts.length > 1 ? pesPts[pesPts.length - 1]! - pesPts[pesPts.length - 2]! : 0;
  const samples = Math.round(((pesPts[pesPts.length - 1]! + step - firstPts) / 90) * 16);
  const startMs = (firstPts - CLIP_START_PTS) / 90;
  const pcm = new Int16Array(samples);
  for (let i = 0; i < samples; i++) {
    const noise = (Math.imul(i + Math.round(startMs * 16), 1664525) + 1013904223) >>> 0;
    const ms = startMs + i / 16;
    const loud = SPEECH_BURSTS.some((b) => ms >= b.fromMs && ms < b.toMs);
    pcm[i] = Math.round((noise / 2 ** 32 - 0.5) * (loud ? 24_000 : 40));
  }
  return { firstPts, pcm };
};

describe('align through an injected decoder', () => {
  it('matches the fixture alignment: finds a known offset', async () => {
    const result = await align(disc, '00000', DURATION_MS, script(SPEECH_BURSTS, () => 1230), burstsDecoder);
    expect(result.kind).toBe('offset');
    if (result.kind !== 'offset') return;
    expect(Math.abs(result.offsetMs + 1230)).toBeLessThanOrEqual(20);
    expect(result.confidence).toBeGreaterThanOrEqual(0.55);
  });

  it('matches the fixture alignment: finds zero', async () => {
    const result = await align(disc, '00000', DURATION_MS, script(SPEECH_BURSTS), burstsDecoder);
    expect(result.kind).toBe('offset');
    if (result.kind !== 'offset') return;
    expect(Math.abs(result.offsetMs)).toBeLessThanOrEqual(20);
  });

  it('hands the decoder the audio PID and coding of the play item', async () => {
    const seen: Array<{ pid: number; coding: number }> = [];
    const spy: AudioDecoder = (input) => {
      seen.push({ pid: input.pid, coding: input.coding });
      return burstsDecoder(input);
    };
    await align(disc, '00000', DURATION_MS, script(SPEECH_BURSTS), spy);
    expect(seen.length).toBeGreaterThan(0);
    expect(seen.every((s) => s.pid === AUDIO_PID && s.coding === CodingType.AC3)).toBe(true);
  });

  it('rejects when the decoder cannot be started, instead of skipping every window', async () => {
    const logged: string[] = [];
    const broken: AudioDecoder = async () => { throw Object.assign(new Error('spawn ffmpeg ENOENT'), { code: 'ENOENT', syscall: 'spawn ffmpeg' }); };
    await expect(align(disc, '00000', DURATION_MS, script(SPEECH_BURSTS), broken, undefined, { log: (m) => void logged.push(m) })).rejects.toMatchObject({ code: 'ENOENT', syscall: 'spawn ffmpeg' });
    expect(logged).toEqual([]);
  });

  it('rejects when aborted', async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(align(disc, '00000', DURATION_MS, script(SPEECH_BURSTS), burstsDecoder, controller.signal)).rejects.toThrow();
  });
});

describe('alignAudio', () => {
  const HOST_MS = 120_000;
  const full = noiseWindow(0, HOST_MS / 1000, SPEECH_BURSTS);
  /** A host's reader over one synthetic recording: the first span's start to the last span's end. */
  const reader: PlaylistAudioReader = async (spans) => {
    if (spans === 'whole') return full;
    const fromMs = spans[0]!.fromMs;
    const toMs = spans[spans.length - 1]!.toMs;
    return { startMs: fromMs, pcm: full.pcm.slice(fromMs * 16, Math.min(full.pcm.length, toMs * 16)) };
  };

  it('finds the offset from a host reader', async () => {
    const result = await alignAudio(reader, HOST_MS, script(SPEECH_BURSTS, () => -1200));
    expect(result).toMatchObject({ kind: 'offset' });
    if (result.kind !== 'offset') return;
    expect(Math.abs(result.offsetMs - 1200)).toBeLessThanOrEqual(20);
  });

  it("passes a reader's spawn error on", async () => {
    const broken: PlaylistAudioReader = async () => { throw Object.assign(new Error('spawn vspipe ENOENT'), { code: 'ENOENT', syscall: 'spawn vspipe' }); };
    await expect(alignAudio(broken, HOST_MS, script(SPEECH_BURSTS))).rejects.toMatchObject({ syscall: 'spawn vspipe' });
  });
});
