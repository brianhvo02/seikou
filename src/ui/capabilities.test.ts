import { describe, expect, it } from 'vitest';
import { checkCapabilities, showStorageHint } from './capabilities';

const base = { VideoDecoder: class {}, AudioWorkletNode: class {}, OffscreenCanvas: class {}, SharedArrayBuffer, crossOriginIsolated: true, Atomics, WebAssembly, Worker: class {} };

describe('checkCapabilities', () => {
  it('passes a fully capable Chromium-like environment', () => {
    const g = {
      ...base,
      showDirectoryPicker: () => undefined,
      document: { fullscreenEnabled: true, pictureInPictureEnabled: true },
      HTMLInputElement: class {},
      FileSystemHandle: class {
        queryPermission(): void {}
      },
      navigator: { audioSession: {}, wakeLock: {}, mediaSession: {} },
    };
    expect(checkCapabilities(g)).toEqual({
      core: { ok: true, missing: [] },
      bdj: { ok: true, missing: [] },
      canPickDirectory: true,
      canPickFolderInput: false,
      canRememberDiscs: true,
      fullscreen: 'standard',
      pip: 'standard',
      videoFullscreen: false,
      audioSession: true,
      wakeLock: true,
      mediaSession: true,
    });
  });

  it('names each missing capability', () => {
    const report = checkCapabilities({ OffscreenCanvas: class {}, crossOriginIsolated: false });
    expect(report.core.ok).toBe(false);
    expect(report.core.missing).toEqual(['WebCodecs video decoding', 'AudioWorklet', 'cross-origin isolation (SharedArrayBuffer)']);
    expect(report.canPickDirectory).toBe(false);
    expect(report.fullscreen).toBeNull();
  });

  it('reports a Firefox-Android-like global without VideoDecoder', () => {
    const { VideoDecoder: _v, ...g } = base;
    void _v;
    const report = checkCapabilities(g);
    expect(report.core.ok).toBe(false);
    expect(report.core.missing).toContain('WebCodecs video decoding');
  });

  it('reports a Safari-like global', () => {
    const g = {
      ...base,
      document: { webkitFullscreenEnabled: true },
      HTMLInputElement: { prototype: { webkitdirectory: false } },
      navigator: { mediaSession: {} },
    };
    const report = checkCapabilities(g);
    expect(report.core.ok).toBe(true);
    expect(report.canPickDirectory).toBe(false);
    expect(report.canPickFolderInput).toBe(true);
    expect(report.canRememberDiscs).toBe(false);
    expect(report.fullscreen).toBe('webkit');
    expect(report.mediaSession).toBe(true);
    expect(report.wakeLock).toBe(false);
  });

  it('names what BD-J menus need that the page lacks', () => {
    const { WebAssembly: _w, ...noWasm } = base;
    void _w;
    expect(checkCapabilities(noWasm).bdj).toEqual({ ok: false, missing: ['WebAssembly'] });
    expect(checkCapabilities({ ...base, crossOriginIsolated: false }).bdj.missing).toEqual(['cross-origin isolation (SharedArrayBuffer)']);
  });

  it('reports WebKit Picture in Picture and video fullscreen on a Safari-like global without the standard API', () => {
    const report = checkCapabilities({ ...base, document: {}, HTMLVideoElement: { prototype: { webkitSetPresentationMode() {}, webkitEnterFullscreen() {} } } });
    expect(report.pip).toBe('webkit');
    expect(report.videoFullscreen).toBe(true);
  });

  it('reports no fullscreen when the document disables it (an iPhone without element fullscreen)', () => {
    const report = checkCapabilities({ ...base, document: { fullscreenEnabled: false, webkitFullscreenEnabled: false } });
    expect(report.fullscreen).toBeNull();
  });
});

describe('showStorageHint', () => {
  const win = (standalone: boolean | 'throws') => ({
    matchMedia: (q: string) => {
      if (standalone === 'throws') throw new Error('no matchMedia');
      return { matches: q === '(display-mode: standalone)' && standalone };
    },
  });

  it('is hidden where discs can be remembered (Chromium)', () => {
    expect(showStorageHint(true, win(false))).toBe(false);
  });

  it('shows in a browser tab that cannot remember discs', () => {
    expect(showStorageHint(false, win(false))).toBe(true);
  });

  it('is hidden when running as an installed app', () => {
    expect(showStorageHint(false, win(true))).toBe(false);
  });

  it('shows when matchMedia throws', () => {
    expect(showStorageHint(false, win('throws'))).toBe(true);
  });
});
