// SPDX-License-Identifier: LGPL-3.0-or-later
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { loadNodeAudioWasm } from '../../../../tests/helpers/audio-wasm';
import type { ChannelLayout } from '../audio/channel-map';
import { AudioFramer, type FramerKind } from './audio-frames';
import { AudioFrameError, WasmCodec, WasmFrameDecoder, type WasmCodecId } from './wasm-audio';

const AUDIO = fileURLToPath(new URL('../../../../fixtures/synthetic/audio/', import.meta.url));
/**
 * FFmpeg's FATE samples of DTS-HD Master Audio, which nothing free can encode. Fetch them (they stay out of the repo):
 * `rsync -a rsync://fate-suite.ffmpeg.org/fate-suite/dts/master_audio_7.1_24bit.dts fixtures/local/fate/`, and from
 * `dts/dcadec-suite/` the `xll_*.dtshd` files, unwrapped with `ffmpeg -i X.dtshd -c copy -f dts X.dts`.
 */
const FATE = fileURLToPath(new URL('../../../../fixtures/local/fate/', import.meta.url));
const REFERENCE = JSON.parse(readFileSync(AUDIO + 'truehd.json', 'utf8')) as Record<string, { rate: number; native: string; stereo: string; surround: string }>;

interface Decoded {
  readonly rate: number;
  readonly channels: ChannelLayout;
  /** Interleaved samples as signed 32-bit integers, as ffmpeg's s32le output holds them. */
  readonly s32: Int32Array;
  readonly frames: number;
  readonly failed: number;
  readonly ms: number;
}

async function decodeStream(bytes: Uint8Array, kind: FramerKind, codec: WasmCodecId, outChannels: number): Promise<Decoded> {
  const framer = new AudioFramer(kind);
  const decoder = new WasmFrameDecoder(await loadNodeAudioWasm(), codec, outChannels);
  const parts: Float32Array[] = [];
  let channels: ChannelLayout = [];
  let rate = 0;
  let failed = 0;
  const t0 = performance.now();
  for (let at = 0; at < bytes.length; at += 6144) {
    for (const f of [...framer.push(bytes.subarray(at, at + 6144), 0), ...(at + 6144 >= bytes.length ? framer.flush() : [])]) {
      try {
        const out = decoder.decode(f.data);
        if (out.samples.length === 0) continue;
        channels = out.channels;
        rate = out.sampleRate;
        parts.push(out.samples);
      } catch (err) {
        if (!(err instanceof AudioFrameError)) throw err;
        failed++;
      }
    }
  }
  const ms = performance.now() - t0;
  decoder.close();
  const total = parts.reduce((n, p) => n + p.length, 0);
  const s32 = new Int32Array(total);
  let o = 0;
  for (const p of parts) for (let i = 0; i < p.length; i++) s32[o++] = Math.max(-2147483648, Math.min(2147483647, Math.round(p[i] * 2147483648)));
  return { rate, channels, s32, frames: total / Math.max(1, channels.length), failed, ms };
}

const md5 = (s32: Int32Array): string => createHash('md5').update(new Uint8Array(s32.buffer, s32.byteOffset, s32.byteLength)).digest('hex');

/** Frequency of one channel from positive-going zero crossings over the middle half. */
function frequency(d: Decoded, channel: number): number {
  const n = d.channels.length;
  const from = Math.floor(d.frames * 0.25);
  const to = Math.floor(d.frames * 0.75);
  let crossings = 0;
  for (let i = from + 1; i < to; i++) if (d.s32[(i - 1) * n + channel] < 0 && d.s32[i * n + channel] >= 0) crossings++;
  return (crossings * d.rate) / (to - from);
}

describe('TrueHD, decoded whole', () => {
  it.each(Object.keys(REFERENCE))('decodes %s bit-exact with ffmpeg, in its own layout and in its stereo and 5.1 presentations', async (file) => {
    const bytes = new Uint8Array(readFileSync(AUDIO + file));
    const ref = REFERENCE[file];
    const native = await decodeStream(bytes, 'truehd', WasmCodec.TRUEHD, 8);
    expect(native.failed).toBe(0);
    expect(native.rate).toBe(ref.rate);
    expect(md5(native.s32)).toBe(ref.native);
    expect(md5((await decodeStream(bytes, 'truehd', WasmCodec.TRUEHD, 2)).s32)).toBe(ref.stereo);
    expect(md5((await decodeStream(bytes, 'truehd', WasmCodec.TRUEHD, 6)).s32)).toBe(ref.surround);
  });

  it('names 5.1 in FFmpeg order, and each channel carries its own tone', async () => {
    const d = await decodeStream(new Uint8Array(readFileSync(AUDIO + 'truehd-51.thd')), 'truehd', WasmCodec.TRUEHD, 8);
    expect(d.channels).toEqual(['FL', 'FR', 'FC', 'LFE', 'SL', 'SR']);
    for (let c = 0; c < 6; c++) {
      const hz = frequency(d, c);
      expect(hz).toBeGreaterThan(220 * (c + 1) * 0.97);
      expect(hz).toBeLessThan(220 * (c + 1) * 1.03);
    }
  });
});

const ffmpeg = ((): boolean => {
  try {
    execFileSync('ffmpeg', ['-version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
})();

/** ffmpeg's own decode of a file, as s32le MD5 (with an optional `-downmix`). */
function ffmpegMd5(path: string, downmix?: string): string {
  const pcm = execFileSync('ffmpeg', ['-v', 'error', ...(downmix ? ['-downmix', downmix] : []), '-i', path, '-f', 's32le', '-'], { maxBuffer: 1 << 30 });
  return createHash('md5').update(pcm).digest('hex');
}

const FATE_FILES = ['master_audio_7.1_24bit.dts', 'xll_51_24_48_768.dts', 'xll_71_24_96_768.dts', 'xll_51_16_192_768_0.dts'].filter((f) => existsSync(FATE + f));

describe.skipIf(!ffmpeg || FATE_FILES.length === 0)('DTS-HD Master Audio, decoded whole (FATE samples in fixtures/local/fate)', () => {
  it.each(FATE_FILES)('decodes %s bit-exact with ffmpeg', async (file) => {
    const bytes = new Uint8Array(readFileSync(FATE + file));
    const d = await decodeStream(bytes, 'dtshd', WasmCodec.DTS_FULL, 8);
    expect(d.failed).toBe(0);
    expect(md5(d.s32)).toBe(ffmpegMd5(FATE + file));
    const seconds = d.frames / d.rate;
    // The cost of a lossless decode on this machine, for the night report.
    console.log(`${file}: ${d.channels.join(' ')} at ${d.rate} Hz, ${seconds.toFixed(2)} s decoded in ${d.ms.toFixed(0)} ms (${((d.ms / 1000 / seconds) * 100).toFixed(2)}% of real time)`);
  });

  it.skipIf(!FATE_FILES.includes('xll_71_24_96_768.dts'))('names DTS-HD 7.1 channels and decodes 96 kHz', async () => {
    const d = await decodeStream(new Uint8Array(readFileSync(FATE + 'xll_71_24_96_768.dts')), 'dtshd', WasmCodec.DTS_FULL, 8);
    expect(d.rate).toBe(96_000);
    expect(d.channels).toHaveLength(8);
    expect(d.channels).toContain('LFE');
    expect(d.channels).not.toContain('UNKNOWN');
  });

  it.each(FATE_FILES)('decodes %s to ffmpeg\'s stereo downmix', async (file) => {
    const d = await decodeStream(new Uint8Array(readFileSync(FATE + file)), 'dtshd', WasmCodec.DTS_FULL, 2);
    expect(md5(d.s32)).toBe(ffmpegMd5(FATE + file, 'stereo'));
  });
});
