import { describe, expect, it, vi } from 'vitest';
import { FULLSCREEN_HINT_KEY, evaluateFullscreenHint, fullscreenKind, safeLocalStorage, isFullscreenHintDismissed, markFullscreenHintDismissed, shouldShowFullscreenHint, toggleFullscreen } from './fullscreen';

function fakes(doc: Record<string, unknown>): { doc: Document; el: HTMLElement; elementMock: Record<string, ReturnType<typeof vi.fn>> } {
  const elementMock = { requestFullscreen: vi.fn(), webkitRequestFullscreen: vi.fn() };
  const d = { exitFullscreen: vi.fn(), webkitExitFullscreen: vi.fn(), ...doc };
  return { doc: d as unknown as Document, el: elementMock as unknown as HTMLElement, elementMock };
}

describe('toggleFullscreen', () => {
  it('standard: requests fullscreen on the element', () => {
    const { doc, el, elementMock } = fakes({ fullscreenElement: null });
    toggleFullscreen(doc, el, 'standard');
    expect(elementMock.requestFullscreen).toHaveBeenCalled();
  });
  it('standard: exits when fullscreen is active', () => {
    const { doc, el, elementMock } = fakes({ fullscreenElement: {} });
    toggleFullscreen(doc, el, 'standard');
    expect((doc as unknown as { exitFullscreen: unknown }).exitFullscreen).toHaveBeenCalled();
    expect(elementMock.requestFullscreen).not.toHaveBeenCalled();
  });
  it('webkit: requests with the prefixed API', () => {
    const { doc, el, elementMock } = fakes({ webkitFullscreenElement: null });
    toggleFullscreen(doc, el, 'webkit');
    expect(elementMock.webkitRequestFullscreen).toHaveBeenCalled();
    expect(elementMock.requestFullscreen).not.toHaveBeenCalled();
  });
  it('webkit: exits with the prefixed API when webkitFullscreenElement is set', () => {
    const { doc, el, elementMock } = fakes({ webkitFullscreenElement: {} });
    toggleFullscreen(doc, el, 'webkit');
    expect((doc as unknown as { webkitExitFullscreen: unknown }).webkitExitFullscreen).toHaveBeenCalled();
    expect(elementMock.webkitRequestFullscreen).not.toHaveBeenCalled();
  });
});

describe('fullscreenKind', () => {
  it("takes the document's API first, the video's own where there is none, and none without either", () => {
    expect(fullscreenKind({ fullscreen: 'standard', videoFullscreen: true })).toBe('standard');
    expect(fullscreenKind({ fullscreen: 'webkit', videoFullscreen: false })).toBe('webkit');
    expect(fullscreenKind({ fullscreen: null, videoFullscreen: true })).toBe('video');
    expect(fullscreenKind({ fullscreen: null, videoFullscreen: false })).toBeNull();
  });
  it('?fullscreen=video forces the video’s own only where it exists', () => {
    expect(fullscreenKind({ fullscreen: 'standard', videoFullscreen: true }, 'video')).toBe('video');
    expect(fullscreenKind({ fullscreen: 'standard', videoFullscreen: false }, 'video')).toBe('standard');
    expect(fullscreenKind({ fullscreen: 'standard', videoFullscreen: true }, 'other')).toBe('standard');
  });
});

describe('shouldShowFullscreenHint', () => {
  const base = { fullscreen: null, coarsePointer: true, standalone: false, dismissed: false } as const;
  it('shows on a coarse-pointer browser tab without fullscreen', () => {
    expect(shouldShowFullscreenHint(base)).toBe(true);
  });
  it.each([
    { fullscreen: 'standard' as const },
    { fullscreen: 'webkit' as const },
    { fullscreen: 'video' as const },
    { coarsePointer: false },
    { standalone: true },
    { dismissed: true },
  ])('hides for %j', (override) => {
    expect(shouldShowFullscreenHint({ ...base, ...override })).toBe(false);
  });
});

describe('hint dismissal storage', () => {
  it('round-trips through storage', () => {
    const data = new Map<string, string>();
    const storage = { getItem: (k: string) => data.get(k) ?? null, setItem: (k: string, v: string) => void data.set(k, v) };
    expect(isFullscreenHintDismissed(storage)).toBe(false);
    markFullscreenHintDismissed(storage);
    expect(data.has(FULLSCREEN_HINT_KEY)).toBe(true);
    expect(isFullscreenHintDismissed(storage)).toBe(true);
  });
  it('survives storage that throws', () => {
    const storage = { getItem: () => { throw new Error('denied'); }, setItem: () => { throw new Error('denied'); } };
    expect(isFullscreenHintDismissed(storage)).toBe(false);
    expect(() => markFullscreenHintDismissed(storage)).not.toThrow();
  });
});

describe('safeLocalStorage and evaluateFullscreenHint', () => {
  const media = (coarse: boolean, standalone: boolean) => (q: string) => ({ matches: q.includes('coarse') ? coarse : standalone });
  const okStorage = { getItem: () => null, setItem: () => {} };
  const throwingGetter = (): { readonly localStorage: never; matchMedia: ReturnType<typeof media> } =>
    ({ get localStorage(): never { throw new Error('SecurityError'); }, matchMedia: media(true, false) });

  it('returns null when the localStorage getter throws', () => {
    expect(safeLocalStorage(throwingGetter())).toBeNull();
  });
  it('shows the hint when storage is unusable (counts as not dismissed)', () => {
    expect(evaluateFullscreenHint(null, throwingGetter())).toBe(true);
  });
  it('shows when storage reads throw', () => {
    const win = { matchMedia: media(true, false), localStorage: { getItem: () => { throw new Error('x'); }, setItem: () => {} } };
    expect(evaluateFullscreenHint(null, win)).toBe(true);
  });
  it('does not show when matchMedia throws', () => {
    const win = { matchMedia: () => { throw new Error('x'); }, localStorage: okStorage };
    expect(evaluateFullscreenHint(null, win)).toBe(false);
  });
  it('does not show when matchMedia is missing', () => {
    expect(evaluateFullscreenHint(null, { localStorage: okStorage } as never)).toBe(false);
  });
  it('shows on a coarse-pointer tab with working storage', () => {
    expect(evaluateFullscreenHint(null, { matchMedia: media(true, false), localStorage: okStorage })).toBe(true);
  });
});
