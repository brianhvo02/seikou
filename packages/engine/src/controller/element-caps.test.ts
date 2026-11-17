// SPDX-License-Identifier: LGPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import { elementCheck, type ElementCapsEnv } from './element-caps';

/** The `playable` half of elementCheck's answer. */
const elementPlayable = async (...args: Parameters<typeof elementCheck>): Promise<boolean> => (await elementCheck(...args)).playable;

function env(opts: { supported?: boolean; info?: 'missing' | 'throws' | boolean } = {}) {
  const types: string[] = [];
  const configs: unknown[] = [];
  const e: ElementCapsEnv = {
    isTypeSupported: (t) => (types.push(t), opts.supported ?? true),
    ...(opts.info === 'missing'
      ? {}
      : {
          decodingInfo: async (c) => {
            configs.push(c);
            if (opts.info === 'throws') throw new TypeError('bad config');
            return { supported: opts.info === undefined ? true : opts.info === true };
          },
        }),
  };
  return { e, types, configs };
}

describe('elementCheck: playable', () => {
  it('asks only isTypeSupported for SDR', async () => {
    const t = env({ supported: false });
    expect(await elementPlayable(t.e, 'avc1.640028', null)).toBe(false);
    expect(t.types).toEqual(['video/mp4; codecs="avc1.640028"']);
    expect(t.configs).toEqual([]);
  });

  it('asks decodingInfo for HDR PQ with mastering metadata', async () => {
    const t = env();
    expect(await elementPlayable(t.e, 'hvc1.2.4.L153.B0', { transfer: 'pq', mastering: true }, { width: 3840, height: 2160 })).toBe(true);
    expect(t.configs).toEqual([
      {
        type: 'media-source',
        video: {
          contentType: 'video/mp4; codecs="hvc1.2.4.L153.B0"',
          width: 3840,
          height: 2160,
          bitrate: expect.any(Number),
          framerate: expect.any(Number),
          transferFunction: 'pq',
          colorGamut: 'rec2020',
          hdrMetadataType: 'smpteSt2086',
        },
      },
    ]);
  });

  it("asks about the stream's frame rate when it is given", async () => {
    const t = env();
    await elementPlayable(t.e, 'hvc1.2.4.L153.B0', { transfer: 'pq', mastering: false }, { width: 1920, height: 1080, frameRate: 50 });
    expect((t.configs[0] as { video: Record<string, unknown> }).video).toMatchObject({ width: 1920, height: 1080, framerate: 50 });
  });

  it('leaves hdrMetadataType out without mastering metadata, and asks for hlg', async () => {
    const t = env();
    await elementPlayable(t.e, 'hvc1.2.4.L153.B0', { transfer: 'hlg', mastering: false });
    const video = (t.configs[0] as { video: Record<string, unknown> }).video;
    expect(video.transferFunction).toBe('hlg');
    expect('hdrMetadataType' in video).toBe(false);
  });

  it('is false when decodingInfo says unsupported', async () => {
    expect(await elementPlayable(env({ info: false }).e, 'hvc1.2.4.L153.B0', { transfer: 'pq', mastering: false })).toBe(false);
  });

  it('is false for HDR without isTypeSupported, without asking decodingInfo', async () => {
    const t = env({ supported: false });
    expect(await elementPlayable(t.e, 'hvc1.2.4.L153.B0', { transfer: 'pq', mastering: false })).toBe(false);
    expect(t.configs).toEqual([]);
  });

  it('lets isTypeSupported decide when decodingInfo throws or is missing', async () => {
    expect(await elementPlayable(env({ info: 'throws' }).e, 'hvc1.2.4.L153.B0', { transfer: 'pq', mastering: false })).toBe(true);
    expect(await elementPlayable(env({ info: 'missing' }).e, 'hvc1.2.4.L153.B0', { transfer: 'pq', mastering: false })).toBe(true);
  });
});

describe('elementCheck', () => {
  const pq = { transfer: 'pq', mastering: false } as const;

  it('reports each answer the browser gave: isTypeSupported, then decodingInfo for HDR', async () => {
    expect(await elementCheck(env({ info: false }).e, 'hvc1.2.4.L153.B0', pq)).toEqual({ playable: false, check: { mse: true, decodingInfo: false } });
    expect(await elementCheck(env({ info: true }).e, 'hvc1.2.4.L153.B0', pq)).toEqual({ playable: true, check: { mse: true, decodingInfo: true } });
  });

  it('says decodingInfo was not asked for SDR or after an isTypeSupported refusal', async () => {
    expect(await elementCheck(env().e, 'avc1.640028', null)).toEqual({ playable: true, check: { mse: true, decodingInfo: null } });
    expect(await elementCheck(env({ supported: false }).e, 'hvc1.2.4.L153.B0', pq)).toEqual({ playable: false, check: { mse: false, decodingInfo: null } });
  });

  it('says when decodingInfo threw or is missing', async () => {
    expect(await elementCheck(env({ info: 'throws' }).e, 'hvc1.2.4.L153.B0', pq)).toEqual({ playable: true, check: { mse: true, decodingInfo: 'threw' } });
    expect(await elementCheck(env({ info: 'missing' }).e, 'hvc1.2.4.L153.B0', pq)).toEqual({ playable: true, check: { mse: true, decodingInfo: 'missing' } });
  });
});
