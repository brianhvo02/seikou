import { describe, expect, it, vi } from 'vitest';
import { browserIsTypeSupported, detectAv1, detectVideoCaps, loadVideoCaps, noAv1Flag, type VideoCapsEnv } from './video-caps';

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
