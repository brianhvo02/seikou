import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { CodingType } from '@seikou/bdmv/stream-types';
import { AudioFramer } from './audio-frames';
import { loadNodeAudioWasm } from '../../../../tests/helpers/audio-wasm';
import { AudioFrameError, WasmCodec, loadAudioWasm, WasmFrameDecoder, type AudioWasm } from './wasm-audio';

describe('audio.wasm', () => {
  it('loads and opens and closes both decoders', async () => {
    const wasm = await loadNodeAudioWasm();
    for (const codec of [WasmCodec.AC3, WasmCodec.DTS]) {
      const d = new WasmFrameDecoder(wasm, codec);
      d.reset();
      d.close();
    }
  });

  it('falls back to a buffered compile when the response has the wrong Content-Type', async () => {
    const bytes = readFileSync(fileURLToPath(new URL('../../wasm/audio/audio.wasm', import.meta.url)));
    const wrong = new Response(bytes, { headers: { 'Content-Type': 'application/octet-stream' } });
    const wasm = await loadAudioWasm(Promise.resolve(wrong));
    const d = new WasmFrameDecoder(wasm, WasmCodec.AC3);
    d.close();
    const right = new Response(bytes, { headers: { 'Content-Type': 'application/wasm' } });
    await expect(loadAudioWasm(Promise.resolve(right))).resolves.toBeDefined();
  });

  it('reports a frame that is not audio as an AudioFrameError', async () => {
    const d = new WasmFrameDecoder(await loadNodeAudioWasm(), WasmCodec.AC3);
    expect(() => d.decode(new Uint8Array(256).fill(0x55))).toThrow(AudioFrameError);
    d.close();
  });
});

describe('WasmFrameDecoder allocation failures', () => {
  function fake(mallocs: number[]): { wasm: AudioWasm; calls: string[] } {
    const calls: string[] = [];
    const wasm = {
      memory: new WebAssembly.Memory({ initial: 1 }),
      audio_open: () => 1,
      audio_decode: () => {
        calls.push('decode');
        return 0;
      },
      audio_sample_rate: () => 48000,
      audio_reset: () => undefined,
      audio_close: () => {
        calls.push('close');
      },
      malloc: () => mallocs.shift() ?? 0,
      free: () => undefined,
    } as AudioWasm;
    return { wasm, calls };
  }

  it('closes the decoder when the output buffer cannot be allocated', () => {
    const { wasm, calls } = fake([0]);
    expect(() => new WasmFrameDecoder(wasm, WasmCodec.AC3)).toThrow(/out of memory/);
    expect(calls).toEqual(['close']);
  });

  it('keeps throwing after a failed input allocation instead of decoding from pointer 0', () => {
    const { wasm, calls } = fake([16, 0]);
    const d = new WasmFrameDecoder(wasm, WasmCodec.AC3);
    expect(() => d.decode(new Uint8Array(100))).toThrow(/out of memory/);
    expect(() => d.decode(new Uint8Array(10))).toThrow(/out of memory/);
    expect(calls).not.toContain('decode');
  });
});

const AUDIO = fileURLToPath(new URL('../../../../fixtures/synthetic/audio/', import.meta.url));

/** Decodes a whole elementary stream pushed as 4 KB "PES" pieces; returns the left channel and the frame PTS list. */
async function decodeFile(name: string, kind: 'ac3' | 'eac3' | 'dts'): Promise<{ left: Float32Array; right: Float32Array; pts: number[]; failed: number }> {
  const bytes = readFileSync(AUDIO + name);
  const framer = new AudioFramer(kind);
  const decoder = new WasmFrameDecoder(await loadNodeAudioWasm(), kind === 'dts' ? WasmCodec.DTS : WasmCodec.AC3);
  const left: number[] = [];
  const right: number[] = [];
  const pts: number[] = [];
  let failed = 0;
  for (let at = 0; at < bytes.length; at += 4096) {
    for (const frame of framer.push(bytes.subarray(at, at + 4096), 0)) {
      pts.push(frame.ptsUs);
      try {
        const { sampleRate, stereo } = decoder.decode(frame.data);
        expect(sampleRate).toBe(48_000);
        for (let i = 0; i < stereo.length; i += 2) {
          left.push(stereo[i]);
          right.push(stereo[i + 1]);
        }
      } catch (err) {
        if (!(err instanceof AudioFrameError)) throw err;
        failed++;
      }
    }
  }
  decoder.close();
  return { left: Float32Array.from(left), right: Float32Array.from(right), pts, failed };
}

/** Frequency from positive-going zero crossings, and RMS, over the middle of the signal (skips codec priming). */
function measure(left: ArrayLike<number>): { hz: number; rms: number } {
  const from = Math.floor(left.length * 0.2);
  const to = Math.floor(left.length * 0.8);
  let crossings = 0;
  let sum = 0;
  for (let i = from + 1; i < to; i++) {
    if (left[i - 1] < 0 && left[i] >= 0) crossings++;
    sum += left[i] * left[i];
  }
  return { hz: (crossings * 48_000) / (to - from), rms: Math.sqrt(sum / (to - from)) };
}

describe('audio.wasm decoding', () => {
  // Expected rms is the measured level of the stereo fold-down: the source is 0.25 peak (rms 0.177) and the
  // shim's 5.1 fold-down normalisation lowers a front-only tone to about 0.48x.
  it.each([
    ['tone-ac3-stereo.ac3', 'ac3', CodingType.AC3, 0.177],
    ['tone-ac3-51.ac3', 'ac3', CodingType.AC3, 0.084],
    ['tone-eac3-51.eac3', 'eac3', CodingType.EAC3, 0.084],
    ['tone-dts-51.dts', 'dts', CodingType.DTS, 0.073],
  ] as const)('decodes %s to a 440 Hz stereo tone at the right level', async (name, kind, _codingType, expectedRms) => {
    const { left, right, failed } = await decodeFile(name, kind);
    expect(failed).toBe(0);
    expect(left.length).toBeGreaterThan(40_000); // about 1 s; the last E-AC-3 group stays open
    expect(right.length).toBe(left.length);
    const l = measure(left);
    const r = measure(right);
    for (const m of [l, r]) {
      expect(m.hz).toBeGreaterThan(430);
      expect(m.hz).toBeLessThan(450);
      expect(m.rms).toBeGreaterThan(expectedRms * 0.85);
      expect(m.rms).toBeLessThan(expectedRms * 1.15);
    }
    // Both channels carry the same tone, so a one-sided fold-down is caught.
    expect(Math.abs(r.rms - l.rms)).toBeLessThan(l.rms * 0.05);
  });

  it('times AC-3 frames 32 ms apart', async () => {
    const { pts } = await decodeFile('tone-ac3-stereo.ac3', 'ac3');
    expect(pts.slice(0, 3)).toEqual([0, 32_000, 64_000]);
  });

  it('keeps decoding past a corrupted frame body', async () => {
    const bytes = new Uint8Array(readFileSync(AUDIO + 'tone-ac3-stereo.ac3'));
    const framer = new AudioFramer('ac3');
    const frames = framer.push(bytes, 0);
    expect(frames.length).toBeGreaterThan(5);
    frames[5].data.fill(0xff, 8); // keep the sync and size, ruin CRC and payload
    const decoder = new WasmFrameDecoder(await loadNodeAudioWasm(), WasmCodec.AC3);
    let ok = 0;
    const tail: number[] = [];
    for (const [index, f] of frames.entries()) {
      // FFmpeg conceals this corruption (the frame still decodes) rather than rejecting it. Requiring every
      // frame to decode means a change to rejecting it shows up here instead of passing silently: the
      // AudioFrameError would propagate and fail the test.
      const { stereo } = decoder.decode(f.data);
      ok++;
      expect(stereo.length).toBe(1536 * 2);
      if (index > 5) for (let i = 0; i < stereo.length; i += 2) tail.push(stereo[i]);
    }
    decoder.close();
    expect(ok).toBe(frames.length);
    // The frames after the damaged one are still the tone.
    const { hz, rms } = measure(tail);
    expect(hz).toBeGreaterThan(430);
    expect(hz).toBeLessThan(450);
    expect(rms).toBeGreaterThan(0.177 * 0.85);
    expect(rms).toBeLessThan(0.177 * 1.15);
  });
});
