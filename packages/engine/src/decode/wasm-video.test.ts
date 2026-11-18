// SPDX-License-Identifier: LGPL-3.0-or-later
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { CodingType } from '@seikou/bdmv/stream-types';
import {
  WasmPictureDecoder,
  WasmVideoCodec,
  loadVideoWasm,
  wasmVideoCodecFor,
  type DecodedPicture,
  type VideoWasm,
  type WasmVideoCodecId,
} from './wasm-video';

/** One picture as scripts/make-mpeg2-es.ts wrote it from ffprobe, in presentation order. */
interface Expected {
  readonly ptsUs: number;
  readonly interlaced: boolean;
  readonly topFieldFirst: boolean;
  readonly repeatPict: number;
  readonly pictType: string;
  readonly keyFrame: boolean;
}

/** One coded picture in decode order with the time its PES would carry. */
interface Unit {
  readonly bytes: Uint8Array;
  readonly ptsUs: number;
}

const read = (name: string): Uint8Array => new Uint8Array(readFileSync(fileURLToPath(new URL(name, import.meta.url))));
const expectedOf = (name: string): Expected[] => JSON.parse(new TextDecoder().decode(read(`fixtures/${name}.json`))) as Expected[];

let wasmPromise: Promise<VideoWasm> | null = null;
function wasm(): Promise<VideoWasm> {
  wasmPromise ??= loadVideoWasm(readFileSync(fileURLToPath(new URL('../../wasm/video/video.wasm', import.meta.url))));
  return wasmPromise;
}

/**
 * Splits an MPEG-2 elementary stream into pictures in decode order (each from its sequence or GOP header, else its
 * picture start code) and times each by its temporal_reference: its place in presentation order within the GOP.
 */
function mpeg2Units(es: Uint8Array, expected: readonly Expected[]): Unit[] {
  const starts: { at: number; tr: number; gop: boolean }[] = [];
  let headerAt = -1;
  let gop = false;
  for (let i = 0; i + 5 < es.length; i++) {
    if (es[i] !== 0 || es[i + 1] !== 0 || es[i + 2] !== 1) continue;
    const code = es[i + 3]!;
    if (code === 0xb3 || code === 0xb8) {
      if (headerAt < 0) headerAt = i;
      if (code === 0xb8) gop = true;
    } else if (code === 0x00) {
      starts.push({ at: headerAt >= 0 ? headerAt : i, tr: (es[i + 4]! << 2) | (es[i + 5]! >> 6), gop });
      headerAt = -1;
      gop = false;
    }
  }
  let base = 0;
  let inGop = 0;
  return starts.map((s, k) => {
    if (s.gop) {
      base += inGop;
      inGop = 0;
    }
    inGop++;
    const end = k + 1 < starts.length ? starts[k + 1]!.at : es.length;
    return { bytes: es.subarray(s.at, end), ptsUs: expected[base + s.tr]!.ptsUs };
  });
}

/** Splits a VC-1 Annex E stream at its frame start codes, the sequence and entry-point headers going with the frame after them. */
function vc1Units(es: Uint8Array, expected: readonly Expected[]): Unit[] {
  const starts: number[] = [];
  let headerAt = -1;
  for (let i = 0; i + 3 < es.length; i++) {
    if (es[i] !== 0 || es[i + 1] !== 0 || es[i + 2] !== 1) continue;
    const code = es[i + 3]!;
    if ((code === 0x0f || code === 0x0e) && headerAt < 0) headerAt = i;
    if (code === 0x0d) {
      starts.push(headerAt >= 0 ? headerAt : i);
      headerAt = -1;
    }
  }
  return starts.map((s, k) => ({ bytes: es.subarray(s, k + 1 < starts.length ? starts[k + 1] : es.length), ptsUs: expected[k]!.ptsUs }));
}

async function decodeUnits(codec: WasmVideoCodecId, units: readonly Unit[], setup?: (d: WasmPictureDecoder) => void): Promise<DecodedPicture[]> {
  const d = new WasmPictureDecoder(await wasm(), codec);
  setup?.(d);
  const out: DecodedPicture[] = [];
  for (const u of units) {
    d.push(u.bytes, u.ptsUs);
    out.push(...d.drain());
  }
  out.push(...d.flush());
  d.close();
  return out;
}

const STREAMS = ['mpeg2-1080p', 'mpeg2-1080i-tff', 'mpeg2-1080i-bff'] as const;

/**
 * The field order a picture should carry: an interlaced sequence states one for every frame, progressive ones too
 * (which field is first, and repeated under soft pulldown); a progressive sequence's frames carry none.
 */
function orderOf(e: Expected, interlacedSequence: boolean): 'tff' | 'bff' | null {
  return e.interlaced || interlacedSequence ? (e.topFieldFirst ? 'tff' : 'bff') : null;
}

describe('wasmVideoCodecFor', () => {
  it('maps the MPEG-1, MPEG-2 and VC-1 coding types and nothing else', () => {
    expect(wasmVideoCodecFor(CodingType.MPEG1_VIDEO)).toBe(WasmVideoCodec.MPEG1);
    expect(wasmVideoCodecFor(CodingType.MPEG2_VIDEO)).toBe(WasmVideoCodec.MPEG2);
    expect(wasmVideoCodecFor(CodingType.VC1)).toBe(WasmVideoCodec.VC1);
    expect(wasmVideoCodecFor(CodingType.AVC)).toBeNull();
    expect(wasmVideoCodecFor(CodingType.HEVC)).toBeNull();
  });
});

describe('video.wasm', () => {
  it("decodes every MPEG-2 picture with ffprobe's times and field flags", async () => {
    for (const name of STREAMS) {
      const expected = expectedOf(name);
      const pictures = await decodeUnits(WasmVideoCodec.MPEG2, mpeg2Units(read(`fixtures/${name}.m2v`), expected));
      expect(pictures.length, name).toBe(expected.length);
      pictures.forEach((p, i) => {
        const e = expected[i]!;
        expect(p.ptsUs, `${name} #${i}`).toBe(e.ptsUs);
        expect(p.flags.progressive, `${name} #${i}`).toBe(!e.interlaced);
        expect(p.flags.fieldOrder, `${name} #${i}`).toBe(orderOf(e, name !== 'mpeg2-1080p'));
        expect(p.flags.repeatFirstField, `${name} #${i}`).toBe(e.repeatPict > 0);
        expect(p.keyFrame, `${name} #${i}`).toBe(e.keyFrame);
        expect([p.width, p.height, p.displayWidth, p.displayHeight]).toEqual([1920, 1080, 1920, 1080]);
        expect(p.data.length).toBe(1920 * 1080 * 1.5);
        expect(p.durationUs).toBe(name === 'mpeg2-1080p' ? 41708 : 33367);
      });
    }
  });

  it("decodes the VC-1 sample's pictures with their field flags", async () => {
    const expected = expectedOf('vc1-interlaced');
    const es = new Uint8Array(readFileSync(fileURLToPath(new URL('../../../../fixtures/vc1-sample/interlaced.vc1', import.meta.url))));
    const pictures = await decodeUnits(WasmVideoCodec.VC1, vc1Units(es, expected));
    expect(pictures.length).toBe(expected.length);
    pictures.forEach((p, i) => {
      const e = expected[i]!;
      expect(p.ptsUs, `#${i}`).toBe(e.ptsUs);
      expect(p.flags.progressive, `#${i}`).toBe(!e.interlaced);
      expect(p.flags.fieldOrder, `#${i}`).toBe(orderOf(e, true));
      expect(p.flags.repeatFirstField, `#${i}`).toBe(e.repeatPict > 0);
      expect(p.keyFrame, `#${i}`).toBe(e.keyFrame);
      expect([p.width, p.height]).toEqual([1920, 1080]);
    });
  });

  it('soft pulldown frames carry repeatFirstField and their field order in the 3:2 pattern, with 1.5-frame durations on repeated frames', async () => {
    const name = 'mpeg2-softpulldown';
    const expected = expectedOf(name);
    // The cycle scripts/mpeg2-pulldown.ts writes, checked against ffprobe so the oracle can't drift from the stream.
    const cycle = [
      ['tff', true],
      ['bff', false],
      ['bff', true],
      ['tff', false],
    ] as const;
    expected.forEach((e, i) => {
      expect([e.interlaced, e.topFieldFirst ? 'tff' : 'bff', e.repeatPict === 1]).toEqual([false, ...cycle[i % 4]!]);
    });
    const pictures = await decodeUnits(WasmVideoCodec.MPEG2, mpeg2Units(read(`fixtures/${name}.m2v`), expected));
    expect(pictures.length).toBe(expected.length);
    const frameUs = 1_001_000 / 30;
    pictures.forEach((p, i) => {
      const [order, repeated] = cycle[i % 4]!;
      expect(p.ptsUs, `#${i}`).toBe(expected[i]!.ptsUs);
      expect(p.flags, `#${i}`).toEqual({ fieldOrder: order, progressive: true, repeatFirstField: repeated });
      expect(p.durationUs, `#${i}`).toBe(Math.round(repeated ? 1.5 * frameUs : frameUs));
      expect([p.width, p.height]).toEqual([720, 480]);
    });
  });

  it('pictures split across or packed into PES payloads keep their times', async () => {
    const name = 'mpeg2-1080i-tff';
    const expected = expectedOf(name);
    const units = mpeg2Units(read(`fixtures/${name}.m2v`), expected);
    const summary = (ps: readonly DecodedPicture[]): [number, boolean | null, string | null][] =>
      ps.map((p) => [p.ptsUs, p.flags.progressive, p.flags.fieldOrder]);
    const whole = summary(await decodeUnits(WasmVideoCodec.MPEG2, units));
    expect(whole.length).toBe(expected.length);

    // 1000-byte slices; a slice carries a time only when a picture starts in it.
    const es = read(`fixtures/${name}.m2v`);
    const startAt = new Map<number, number>();
    let offset = 0;
    for (const u of units) {
      startAt.set(offset, u.ptsUs);
      offset += u.bytes.length;
    }
    const slices: Unit[] = [];
    for (let at = 0; at < es.length; at += 1000) {
      let pts = Number.NaN;
      for (let b = at; b < Math.min(at + 1000, es.length); b++) {
        const t = startAt.get(b);
        if (t !== undefined) {
          pts = t;
          break;
        }
      }
      slices.push({ bytes: es.subarray(at, at + 1000), ptsUs: pts });
    }
    expect(summary(await decodeUnits(WasmVideoCodec.MPEG2, slices))).toEqual(whole);

    // Two pictures in one payload with the first one's time.
    const pairs: Unit[] = [];
    for (let k = 0; k < units.length; k += 2) {
      const second = units[k + 1];
      const bytes = second ? new Uint8Array([...units[k]!.bytes, ...second.bytes]) : units[k]!.bytes;
      pairs.push({ bytes, ptsUs: units[k]!.ptsUs });
    }
    // A picture with no time of its own follows the one before it by a frame; times in whole microseconds put that
    // within 1 µs of the time its own PES would have carried.
    const packed = summary(await decodeUnits(WasmVideoCodec.MPEG2, pairs));
    expect(packed.map(([, progressive, order]) => [progressive, order])).toEqual(whole.map(([, progressive, order]) => [progressive, order]));
    packed.forEach(([pts], i) => expect(Math.abs(pts - whole[i]![0]), `#${i}`).toBeLessThanOrEqual(1));
  });

  it('reset drops queued pictures and the next output starts at an I picture', async () => {
    const name = 'mpeg2-1080p';
    const expected = expectedOf(name);
    const units = mpeg2Units(read(`fixtures/${name}.m2v`), expected);
    const d = new WasmPictureDecoder(await wasm(), WasmVideoCodec.MPEG2);
    for (const u of units.slice(0, 8)) d.push(u.bytes, u.ptsUs);
    d.reset();
    expect(d.drain()).toEqual([]);
    // Resume mid-GOP: the first unit is a P picture, so nothing comes out before the next GOP's I picture.
    const resumeAt = 4;
    const out: DecodedPicture[] = [];
    for (const u of units.slice(resumeAt)) {
      d.push(u.bytes, u.ptsUs);
      out.push(...d.drain());
    }
    out.push(...d.flush());
    d.close();
    const firstI = expected.findIndex((e, i) => i > 0 && e.pictType === 'I');
    expect(out[0]!.keyFrame).toBe(true);
    expect(out[0]!.ptsUs).toBe(expected[firstI]!.ptsUs);
    expect(out.every((p) => p.ptsUs >= expected[firstI]!.ptsUs)).toBe(true);
  });

  it('skipping non-reference pictures drops B pictures only', async () => {
    const name = 'mpeg2-1080p';
    const expected = expectedOf(name);
    const pictures = await decodeUnits(WasmVideoCodec.MPEG2, mpeg2Units(read(`fixtures/${name}.m2v`), expected), (d) =>
      d.setSkipNonReference(true),
    );
    const references = expected.filter((e) => e.pictType !== 'B').map((e) => e.ptsUs);
    expect(pictures.map((p) => p.ptsUs)).toEqual(references);
  });

  it("I420 planes match ffmpeg's decode", async () => {
    const name = 'mpeg2-1080p';
    const expected = expectedOf(name);
    const [first] = await decodeUnits(WasmVideoCodec.MPEG2, mpeg2Units(read(`fixtures/${name}.m2v`), expected).slice(0, 4));
    const y = first!.data.subarray(0, first!.width * first!.height);
    const want = new TextDecoder().decode(read(`fixtures/${name}.first-y.sha256`)).trim();
    expect(createHash('sha256').update(y).digest('hex')).toBe(want);
  });
});
