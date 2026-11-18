import { describe, expect, it, vi } from 'vitest';
import type { VideoDecoderSpeed } from '@seikou/engine/protocol';
import { browserIsTypeSupported, detectAv1, detectVideoCaps, loadVideoCaps, measureWasmVideo, noAv1Flag, wasmVideoPlayable, type VideoCapsEnv, type WasmSpeedEnv } from './video-caps';

function env(over: Partial<VideoCapsEnv> = {}): VideoCapsEnv {
  return {
    isConfigSupported: async () => ({ supported: true }),
    matchMedia: () => ({ matches: false }),
    screen: { width: 1920, height: 1080 },
    memoryProfile: 'desktop',
    ...over,
  };
}

describe('detectVideoCaps', () => {
  it('detects HEVC and Main10 separately', async () => {
    const seen: string[] = [];
    const caps = await detectVideoCaps(env({
      isConfigSupported: async (c) => {
        seen.push(`${c.codec}@${c.codedWidth}x${c.codedHeight}`);
        return { supported: c.codec === 'hvc1.1.6.L120.90' };
      },
    }));
    expect(caps.hevc).toBe(true);
    expect(caps.hevc10).toBe(false);
    expect(seen).toContain('hvc1.1.6.L120.90@1920x1080');
    expect(seen).toContain('hvc1.2.4.L120.90@1920x1080');
  });

  it('no VideoDecoder means no HEVC', async () => {
    const caps = await detectVideoCaps(env({ isConfigSupported: undefined }));
    expect(caps.hevc).toBe(false);
    expect(caps.hevc10).toBe(false);
  });

  it('a rejected probe means unsupported', async () => {
    const caps = await detectVideoCaps(env({ isConfigSupported: async () => { throw new Error('nope'); } }));
    expect(caps.hevc).toBe(false);
    expect(caps.hevc10).toBe(false);
  });

  it('HDR display from dynamic-range: high', async () => {
    const asked: string[] = [];
    const caps = await detectVideoCaps(env({ matchMedia: (q) => { asked.push(q); return { matches: q === '(dynamic-range: high)' }; } }));
    expect(caps.hdrDisplay).toBe(true);
    expect(asked).toContain('(dynamic-range: high)');
    expect((await detectVideoCaps(env())).hdrDisplay).toBe(false);
  });

  it('phone when constrained or when the shorter screen side is under 600', async () => {
    expect((await detectVideoCaps(env())).phone).toBe(false);
    expect((await detectVideoCaps(env({ screen: { width: 2560, height: 1600 } }))).phone).toBe(false);
    expect((await detectVideoCaps(env({ screen: { width: 390, height: 844 } }))).phone).toBe(true);
    for (const [width, height, phone] of [[1280, 800, false], [1440, 900, false], [600, 960, false], [599, 900, true]] as const) {
      expect((await detectVideoCaps(env({ screen: { width, height } }))).phone, `${width}x${height}`).toBe(phone);
    }
    expect((await detectVideoCaps(env({ memoryProfile: 'constrained', screen: { width: 2732, height: 2048 } }))).phone).toBe(true);
  });
});

describe('loadVideoCaps', () => {
  const thrower = (): never => {
    throw new Error('no screen here');
  };
  it('detects from the environment', async () => {
    expect(await loadVideoCaps(() => env({ memoryProfile: 'constrained' }), () => 'desktop')).toMatchObject({ hevc: true, phone: true });
  });
  it('when the environment cannot be read, falls back to no HEVC and the memory profile for phone', async () => {
    expect(await loadVideoCaps(thrower, () => 'constrained')).toEqual({ hevc: false, hevc10: false, hdrDisplay: false, phone: true });
    expect(await loadVideoCaps(thrower, () => 'desktop')).toEqual({ hevc: false, hevc10: false, hdrDisplay: false, phone: false });
  });
  it('when the probe rejects, falls back the same way', async () => {
    const broken = env({ matchMedia: thrower });
    expect(await loadVideoCaps(() => broken, () => 'constrained')).toMatchObject({ phone: true, hevc: false });
  });
  it('a computer when even the memory profile cannot be told', async () => {
    expect(await loadVideoCaps(thrower, thrower)).toEqual({ hevc: false, hevc10: false, hdrDisplay: false, phone: false });
  });
});

describe('detectAv1', () => {
  it("probes the encode's own codec string when it has one, else 8-bit Main at 1080p", async () => {
    const seen: string[] = [];
    const probe = env({
      isConfigSupported: async (c) => {
        seen.push(`${c.codec}@${c.codedWidth}x${c.codedHeight}`);
        return { supported: c.codec === 'av01.0.08M.08' };
      },
    });
    expect(await detectAv1(probe)).toBe(true);
    expect(await detectAv1(probe, 'V_AV1')).toBe(true); // a Matroska codec id is no codec string
    expect(await detectAv1(probe, 'av01.0.09M.10')).toBe(false);
    expect(seen).toEqual(['av01.0.08M.08@1920x1080', 'av01.0.08M.08@1920x1080', 'av01.0.09M.10@1920x1080']);
  });

  it('is false without a decoder, or when the probe throws', async () => {
    expect(await detectAv1(env({ isConfigSupported: undefined }))).toBe(false);
    expect(await detectAv1(env({ isConfigSupported: async () => { throw new Error('no'); } }))).toBe(false);
  });
});

describe('noAv1Flag', () => {
  it('is set by ?noav1 alone or among other flags, and not otherwise', () => {
    expect(noAv1Flag('?noav1=1')).toBe(true);
    expect(noAv1Flag('?telemetry=1&noav1=1')).toBe(true);
    expect(noAv1Flag('?telemetry=1')).toBe(false);
    expect(noAv1Flag('')).toBe(false);
  });
});

describe('detectVideoCaps through the browser video player', () => {
  const no = async () => ({ supported: false });
  it('counts HEVC as playable when WebCodecs says no and the media source says yes', async () => {
    const asked: string[] = [];
    const caps = await detectVideoCaps(env({
      isConfigSupported: no,
      isTypeSupported: (t) => { asked.push(t); return true; },
    }));
    expect(caps.hevc).toBe(true);
    expect(caps.hevc10).toBe(true);
    expect(asked).toContain('video/mp4; codecs="hvc1.1.6.L120.90"');
    expect(asked).toContain('video/mp4; codecs="hvc1.2.4.L120.90"');
  });
  it('keeps the two profiles apart', async () => {
    const caps = await detectVideoCaps(env({
      isConfigSupported: no,
      isTypeSupported: (t) => t.includes('hvc1.1.6'),
    }));
    expect(caps.hevc).toBe(true);
    expect(caps.hevc10).toBe(false);
  });
  it('is false when both say no', async () => {
    const caps = await detectVideoCaps(env({ isConfigSupported: no, isTypeSupported: () => false }));
    expect(caps.hevc).toBe(false);
    expect(caps.hevc10).toBe(false);
  });
  it('uses WebCodecs alone without a media source', async () => {
    const caps = await detectVideoCaps(env({ isConfigSupported: async () => ({ supported: true }), isTypeSupported: undefined }));
    expect(caps.hevc).toBe(true);
    expect((await detectVideoCaps(env({ isConfigSupported: no, isTypeSupported: undefined }))).hevc).toBe(false);
  });
  it('treats a throwing media source as no', async () => {
    const caps = await detectVideoCaps(env({ isConfigSupported: no, isTypeSupported: () => { throw new Error('x'); } }));
    expect(caps.hevc).toBe(false);
  });
});

describe('browserIsTypeSupported', () => {
  const source = (answer: boolean, asked: string[]) => ({ isTypeSupported: (t: string) => (asked.push(t), answer) });

  it("asks ManagedMediaSource where there is one, else MediaSource", () => {
    const asked: string[] = [];
    vi.stubGlobal('ManagedMediaSource', source(true, asked));
    vi.stubGlobal('MediaSource', source(false, []));
    try {
      expect(browserIsTypeSupported()?.('video/mp4; codecs="hvc1.2.4.L153.B0"')).toBe(true);
      expect(asked).toEqual(['video/mp4; codecs="hvc1.2.4.L153.B0"']);
      vi.stubGlobal('ManagedMediaSource', undefined);
      expect(browserIsTypeSupported()?.('video/mp4; codecs="avc1.640028"')).toBe(false);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('is undefined without a media source, or with one that has no isTypeSupported', () => {
    vi.stubGlobal('ManagedMediaSource', undefined);
    vi.stubGlobal('MediaSource', undefined);
    try {
      expect(browserIsTypeSupported()).toBeUndefined();
      vi.stubGlobal('MediaSource', {});
      expect(browserIsTypeSupported()).toBeUndefined();
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

describe('wasmVideoPlayable', () => {
  it('wasmVideoPlayable passes a codec at its threshold and fails it just below', () => {
    expect(wasmVideoPlayable({ mpeg2Fps: 45.0, vc1Fps: 60.0 })).toEqual({ mpeg2: 'fast', vc1: 'fast' });
    expect(wasmVideoPlayable({ mpeg2Fps: 44.9, vc1Fps: 59.9 })).toEqual({ mpeg2: 'slow', vc1: 'slow' });
    expect(wasmVideoPlayable({ mpeg2Fps: 300, vc1Fps: 90 })).toEqual({ mpeg2: 'fast', vc1: 'fast' });
  });

  it('VC-1 needs 2x its frame rate and MPEG-2 1.5x', () => {
    expect(wasmVideoPlayable({ mpeg2Fps: 1.5 * (30000 / 1001), vc1Fps: 2 * (30000 / 1001) })).toEqual({ mpeg2: 'fast', vc1: 'fast' });
    // 50 pictures a second is enough for MPEG-2 and not for VC-1, whose clip is lighter than a disc's
    expect(wasmVideoPlayable({ mpeg2Fps: 50, vc1Fps: 50 })).toEqual({ mpeg2: 'fast', vc1: 'slow' });
  });

  it('a missing measurement is unknown, not slow', () => {
    expect(wasmVideoPlayable(null)).toEqual({ mpeg2: 'unknown', vc1: 'unknown' });
  });
});

describe('measureWasmVideo', () => {
  const NOW = Date.UTC(2026, 10, 17);
  const DAY = 86_400_000;
  const speed = (mpeg2Fps: number, vc1Fps: number, moduleUrl = '/a.wasm', clips = '/m.m2v|/v.vc1'): VideoDecoderSpeed => ({ mpeg2Fps, vc1Fps, moduleUrl, clips });
  const mk = (over: Partial<WasmSpeedEnv> & Pick<WasmSpeedEnv, 'probe'>, storage: { getItem(k: string): string | null; setItem(k: string, v: string): void } | null = memoryStorage()): WasmSpeedEnv => ({
    moduleUrl: '/a.wasm',
    clips: '/m.m2v|/v.vc1',
    storage: () => storage,
    now: () => NOW,
    hidden: () => false,
    ...over,
  });
  const stored = (storage: { getItem(k: string): string | null }) => JSON.parse(storage.getItem('bluray-web:wasm-video-speed') ?? 'null');

  it('the playability API distinguishes fast, slow and unknown', async () => {
    expect(await measureWasmVideo(mk({ probe: async () => speed(80, 80) }))).toEqual({ mpeg2: 'fast', vc1: 'fast' });
    expect(await measureWasmVideo(mk({ probe: async () => speed(80, 20) }))).toEqual({ mpeg2: 'fast', vc1: 'slow' });
    expect(await measureWasmVideo(mk({ probe: async () => speed(10, 20) }))).toEqual({ mpeg2: 'slow', vc1: 'slow' });
    expect(await measureWasmVideo(mk({ probe: async () => null }))).toEqual({ mpeg2: 'unknown', vc1: 'unknown' });
  });

  it('a probe on a hidden page or during playback answers unknown and stores nothing', async () => {
    const storage = memoryStorage();
    const probe = vi.fn(async () => speed(80, 80));
    expect(await measureWasmVideo(mk({ probe, hidden: () => true }, storage))).toEqual({ mpeg2: 'unknown', vc1: 'unknown' });
    expect(probe).not.toHaveBeenCalled();
    expect(stored(storage)).toBeNull();
    // the engine answers null while a disc plays: unknown, and nothing is stored
    expect(await measureWasmVideo(mk({ probe: async () => null }, storage))).toEqual({ mpeg2: 'unknown', vc1: 'unknown' });
    expect(stored(storage)).toBeNull();
  });

  it('a failed probe stores nothing', async () => {
    const storage = memoryStorage();
    expect(await measureWasmVideo(mk({ probe: async () => { throw new Error('worker gone'); } }, storage))).toEqual({ mpeg2: 'unknown', vc1: 'unknown' });
    expect(await measureWasmVideo(mk({ probe: async () => null }, storage))).toEqual({ mpeg2: 'unknown', vc1: 'unknown' });
    expect(stored(storage)).toBeNull();
  });

  it('the cached speed is used for the same module and clips, and measured again for a new module', async () => {
    const storage = memoryStorage();
    const probe = vi.fn(async () => speed(80, 70));
    expect(await measureWasmVideo(mk({ probe }, storage))).toEqual({ mpeg2: 'fast', vc1: 'fast' });
    expect(stored(storage)).toEqual({ moduleUrl: '/a.wasm', clips: '/m.m2v|/v.vc1', mpeg2Fps: 80, vc1Fps: 70, measuredAt: NOW });
    expect(await measureWasmVideo(mk({ probe }, storage))).toEqual({ mpeg2: 'fast', vc1: 'fast' });
    expect(probe).toHaveBeenCalledTimes(1);
    probe.mockResolvedValueOnce(speed(20, 100, '/b.wasm'));
    expect(await measureWasmVideo(mk({ probe, moduleUrl: '/b.wasm' }, storage))).toEqual({ mpeg2: 'slow', vc1: 'fast' });
    expect(probe).toHaveBeenCalledTimes(2);
    expect(stored(storage).moduleUrl).toBe('/b.wasm');
  });

  it('a new bench clip URL measures again', async () => {
    const storage = memoryStorage();
    const probe = vi.fn(async () => speed(80, 70));
    await measureWasmVideo(mk({ probe }, storage));
    await measureWasmVideo(mk({ probe, clips: '/m2.m2v|/v.vc1' }, storage));
    expect(probe).toHaveBeenCalledTimes(2);
    expect(stored(storage).clips).toBe('/m2.m2v|/v.vc1');
  });

  it('a stored result older than 30 days is measured again', async () => {
    const storage = memoryStorage();
    const probe = vi.fn(async () => speed(80, 70));
    await measureWasmVideo(mk({ probe }, storage));
    await measureWasmVideo(mk({ probe, now: () => NOW + 29 * DAY }, storage));
    expect(probe).toHaveBeenCalledTimes(1);
    await measureWasmVideo(mk({ probe, now: () => NOW + 31 * DAY }, storage));
    expect(probe).toHaveBeenCalledTimes(2);
    expect(stored(storage).measuredAt).toBe(NOW + 31 * DAY);
  });

  it('works without a usable localStorage, and ignores a damaged stored value', async () => {
    const probe = vi.fn(async () => speed(80, 80));
    const broken = (): never => { throw new Error('SecurityError'); };
    expect(await measureWasmVideo(mk({ probe, storage: broken }))).toEqual({ mpeg2: 'fast', vc1: 'fast' });
    const storage = memoryStorage();
    storage.setItem('bluray-web:wasm-video-speed', '{"moduleUrl":"/a.wasm","clips":"/m.m2v|/v.vc1","mpeg2Fps":"fast","measuredAt":0}');
    expect(await measureWasmVideo(mk({ probe }, storage))).toEqual({ mpeg2: 'fast', vc1: 'fast' });
    expect(probe).toHaveBeenCalledTimes(2);
    const throwingStore = { getItem: broken, setItem: broken };
    expect(await measureWasmVideo(mk({ probe }, throwingStore))).toEqual({ mpeg2: 'fast', vc1: 'fast' });
  });
});

function memoryStorage(): { getItem(k: string): string | null; setItem(k: string, v: string): void } {
  const map = new Map<string, string>();
  return { getItem: (k) => map.get(k) ?? null, setItem: (k, v) => void map.set(k, v) };
}
