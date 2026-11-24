// SPDX-License-Identifier: LGPL-3.0-or-later
import { describe, expect, it, vi } from 'vitest';
import { enterPresentation, exitPresentation, FULLSCREEN_MENU_MESSAGE, overlayNotice, hasVideoFullscreen, pipApi, pollUntil, present, presentBlocked, presentMessage, presentedAs, type PresentDeps, type PresentableVideo } from './video-presentation';

describe('pipApi and hasVideoFullscreen', () => {
  it('prefers the standard API, falls back to WebKit presentation mode, and is null in Firefox', () => {
    expect(pipApi({ document: { pictureInPictureEnabled: true }, HTMLVideoElement: { prototype: { webkitSetPresentationMode() {} } } })).toBe('standard');
    expect(pipApi({ document: {}, HTMLVideoElement: { prototype: { webkitSetPresentationMode() {} } } })).toBe('webkit');
    expect(pipApi({ document: { pictureInPictureEnabled: false }, HTMLVideoElement: { prototype: {} } })).toBeNull();
    expect(pipApi({})).toBeNull();
  });
  it('sees WebKit video fullscreen on the video prototype', () => {
    expect(hasVideoFullscreen({ HTMLVideoElement: { prototype: { webkitEnterFullscreen() {} } } })).toBe(true);
    expect(hasVideoFullscreen({ HTMLVideoElement: { prototype: {} } })).toBe(false);
  });
});

describe('presentedAs, enterPresentation and exitPresentation', () => {
  it('reads the standard element, then WebKit presentation mode and fullscreen', () => {
    const video: PresentableVideo = { readyState: 4 };
    expect(presentedAs(video, { pictureInPictureElement: video })).toBe('pip');
    expect(presentedAs({ readyState: 4, webkitPresentationMode: 'picture-in-picture' }, {})).toBe('pip');
    expect(presentedAs({ readyState: 4, webkitDisplayingFullscreen: true }, {})).toBe('fullscreen');
    expect(presentedAs({ readyState: 4, webkitPresentationMode: 'inline' }, { pictureInPictureElement: null })).toBeNull();
  });
  it('enters with the standard API, WebKit mode or WebKit fullscreen, and says when there is none', async () => {
    const request = vi.fn(async () => undefined);
    await enterPresentation('pip', { readyState: 4, requestPictureInPicture: request }, 'standard');
    expect(request).toHaveBeenCalled();
    const setMode = vi.fn();
    await enterPresentation('pip', { readyState: 4, webkitSetPresentationMode: setMode }, 'webkit');
    expect(setMode).toHaveBeenCalledWith('picture-in-picture');
    const full = vi.fn();
    await enterPresentation('fullscreen', { readyState: 4, webkitEnterFullscreen: full }, null);
    expect(full).toHaveBeenCalled();
    await expect(enterPresentation('pip', { readyState: 4 }, null)).rejects.toThrow(/no Picture in Picture/);
    await expect(enterPresentation('fullscreen', { readyState: 4 }, 'standard')).rejects.toThrow(/no video fullscreen/);
  });
  it('exits what is showing, and nothing otherwise', () => {
    const exitPip = vi.fn(async () => undefined);
    const video: PresentableVideo = { readyState: 4 };
    exitPresentation(video, { pictureInPictureElement: video, exitPictureInPicture: exitPip });
    expect(exitPip).toHaveBeenCalled();
    const exitFull = vi.fn();
    exitPresentation({ readyState: 4, webkitDisplayingFullscreen: true, webkitExitFullscreen: exitFull }, {});
    expect(exitFull).toHaveBeenCalled();
    const setMode = vi.fn();
    exitPresentation({ readyState: 4, webkitPresentationMode: 'picture-in-picture', webkitSetPresentationMode: setMode }, {});
    expect(setMode).toHaveBeenCalledWith('inline');
    const untouched = vi.fn();
    exitPresentation({ readyState: 4, webkitPresentationMode: 'inline', webkitSetPresentationMode: untouched, webkitExitFullscreen: untouched }, {});
    expect(untouched).not.toHaveBeenCalled();
  });
});

describe('present', () => {
  const deps = (o: Partial<PresentDeps>): PresentDeps => ({
    elementReady: () => false,
    preferElement: async () => ({ outcome: 'reopening' }),
    waitForElement: async () => true,
    enter: async () => undefined,
    ...o,
  });

  it('on the element path enters at once, asking the engine nothing', async () => {
    const preferElement = vi.fn();
    expect(await present(deps({ elementReady: () => true, preferElement }))).toEqual({ kind: 'entered' });
    expect(preferElement).not.toHaveBeenCalled();
  });
  it('on the element path, a refusal is a failure with the browser’s words', async () => {
    const r = await present(deps({ elementReady: () => true, enter: async () => { throw new Error('NotAllowedError: no'); } }));
    expect(r).toEqual({ kind: 'failed', message: 'NotAllowedError: no' });
  });
  it('on the canvas moves the playlist, waits for the element and enters while the tap still counts', async () => {
    expect(await present(deps({}))).toEqual({ kind: 'entered' });
  });
  it('asks for one more tap when the browser refuses after the move', async () => {
    const r = await present(deps({ enter: async () => { throw new Error('NotAllowedError: The request is not triggered by a user activation.'); } }));
    expect(r).toEqual({ kind: 'again', message: 'NotAllowedError: The request is not triggered by a user activation.' });
    expect(presentMessage('pip', r)).toBe('Picture in Picture is ready: tap Picture in Picture again.');
  });
  it('passes on why the engine kept the canvas, and a move that never showed a picture', async () => {
    const codec = await present(deps({ preferElement: async () => ({ outcome: 'unavailable', reason: 'codec' }) }));
    expect(codec).toEqual({ kind: 'unavailable', reason: 'codec' });
    expect(presentMessage('fullscreen', codec)).toMatch(/^Fullscreen isn't available for this video: it needs H.264 or HEVC/);
    expect(await present(deps({ waitForElement: async () => false }))).toEqual({ kind: 'unavailable', reason: 'no-picture' });
    expect(presentMessage('pip', { kind: 'entered' })).toBeNull();
  });
});

describe('pollUntil', () => {
  it('resolves true once the check holds and false at the timeout', async () => {
    vi.useFakeTimers();
    try {
      let ok = false;
      const yes = pollUntil(() => ok, 1000);
      await vi.advanceTimersByTimeAsync(120);
      ok = true;
      await vi.advanceTimersByTimeAsync(60);
      await expect(yes).resolves.toBe(true);
      const no = pollUntil(() => false, 300);
      await vi.advanceTimersByTimeAsync(400);
      await expect(no).resolves.toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('presentBlocked', () => {
  it('holds the video fullscreen while an HDMV or BD-J menu is up, never Picture in Picture', () => {
    expect(presentBlocked('fullscreen', { menuActive: true, bdjMenuVisible: false })).toBe(FULLSCREEN_MENU_MESSAGE);
    expect(presentBlocked('fullscreen', { menuActive: false, bdjMenuVisible: true })).toBe(FULLSCREEN_MENU_MESSAGE);
    expect(presentBlocked('fullscreen', { menuActive: false, bdjMenuVisible: false })).toBeNull();
    expect(presentBlocked('pip', { menuActive: true, bdjMenuVisible: true })).toBeNull();
  });
});

describe('overlayNotice', () => {
  const base = { menuActive: false, bdjMenuVisible: false, subtitles: null };
  it('names what stays on the page, menus first', () => {
    expect(overlayNotice('pip', base)).toBeNull();
    expect(overlayNotice('pip', { ...base, subtitles: { selected: 'off' } })).toBeNull();
    expect(overlayNotice('pip', { ...base, menuActive: true, subtitles: { selected: 'text' } })).toBe('Disc menus don’t show in Picture in Picture; they stay on the page.');
    expect(overlayNotice('fullscreen', { ...base, subtitles: { selected: 'text' } })).toBe('Subtitles show as plain text in video fullscreen, without their styling or signs.');
    expect(overlayNotice('pip', { ...base, subtitles: { selected: { pg: 0 } } })).toMatch(/^The disc’s own subtitles don’t show in Picture in Picture/);
  });
});
