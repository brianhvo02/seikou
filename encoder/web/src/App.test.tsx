// SPDX-License-Identifier: LGPL-3.0-or-later
// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { HelperApi } from './api';
import { App } from './App';

afterEach(cleanup);

function fakeApi(overrides: Partial<HelperApi> = {}): HelperApi {
  const notCalled = () => Promise.reject(new Error('not expected'));
  return {
    session: vi.fn(async () => ({ discKey: `f.${'a'.repeat(32)}`, label: 'LANTERN_HARBOR_D1', playlistId: '00000', episodeSpec: '1-3,4-5', toolsReady: true })),
    episodes: vi.fn(async () => ({
      episodes: [
        { index: 1, startUs: 0, durationUs: 1, chapters: [{ startUs: 0 }] },
        { index: 2, startUs: 1, durationUs: 1, chapters: [{ startUs: 1 }] },
      ],
      audio: [{ pid: 0x1100, codingType: 0x80, language: 'jpn' }],
      pgCount: 0,
    })),
    searchTitles: notCalled,
    episodeTitles: notCalled,
    seadex: notCalled,
    searchTosho: notCalled,
    fetchRelease: notCalled,
    upload: notCalled,
    release: notCalled,
    align: notCalled,
    subtitleUrl: () => '',
    fontUrl: () => '',
    record: vi.fn(async () => ({ record: null, missing: [] })),
    saveRecord: notCalled,
    remoteDisc: notCalled,
    ...overrides,
  };
}

describe('App', () => {
  it('records its step in the browser history without changing the address', async () => {
    window.history.replaceState(null, '', '/?t=abc');
    render(<App api={fakeApi()} />);
    await screen.findByRole('heading', { level: 1, name: 'LANTERN_HARBOR_D1' });
    expect(window.history.state).toEqual({ step: 1 });
    expect(window.location.search).toBe('?t=abc');
  });

  it("App renders the step bar with the session's disc label", async () => {
    render(<App api={fakeApi()} />);
    expect(await screen.findByRole('heading', { level: 1, name: 'LANTERN_HARBOR_D1' })).toBeTruthy();
    expect(screen.getByText((_, el) => el?.tagName === 'P' && el.textContent === '2 episodes from playlist 00000')).toBeTruthy();
    const bar = screen.getByRole('navigation', { name: 'Steps' });
    const steps = Array.from(bar.querySelectorAll('button')).map((b) => b.textContent);
    expect(steps).toEqual(['1Release', '2Episodes', '3Line up']);
    expect(bar.querySelector('[aria-current="step"]')?.textContent).toBe('1Release');
    // no release yet: the later steps are closed
    expect((screen.getByRole('button', { name: /Episodes/ }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole('button', { name: /Line up/ }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('opens and closes the details panel from any step', async () => {
    render(<App api={fakeApi()} />);
    await screen.findByRole('heading', { level: 1 });
    fireEvent.click(screen.getByRole('button', { name: 'Details' }));
    const panel = screen.getByRole('dialog', { name: 'Details' });
    expect(panel).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Close details' }));
    expect(screen.queryByRole('dialog', { name: 'Details' })).toBeNull();
  });

  it('says what went wrong when the session does not load', async () => {
    const api = fakeApi({ session: vi.fn(async () => Promise.reject(Object.assign(new Error('Missing or wrong token.'), { status: 401, code: 'unauthorized' }))) });
    render(<App api={api} />);
    expect(await screen.findByRole('alert')).toBeTruthy();
    expect(screen.getByRole('alert').textContent).toContain('Missing or wrong token.');
  });
});
