// @vitest-environment jsdom
// SPDX-License-Identifier: LGPL-3.0-or-later
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { LibraryTabs, libraryTabOf } from './LibraryTabs';
import type { NasHistory } from './nas-history';

afterEach(cleanup);

describe('the library tabs', () => {
  it('puts the encodes routes under Encodes and every other under Discs', () => {
    expect(libraryTabOf({ kind: 'encodes', q: '' })).toBe('encodes');
    expect(libraryTabOf({ kind: 'encodeShow', showId: '1' })).toBe('encodes');
    expect(libraryTabOf({ kind: 'encodePlay', encodeId: '1-1', timeS: null, resume: false })).toBe('encodes');
    expect(libraryTabOf({ kind: 'library', shelf: null, q: '' })).toBe('discs');
    expect(libraryTabOf({ kind: 'folders', path: '' })).toBe('discs');
    expect(libraryTabOf({ kind: 'title', titleId: 't' })).toBe('discs');
  });

  it('marks the open tab and moves through the history', () => {
    const history = { push: vi.fn() } as unknown as NasHistory;
    render(<LibraryTabs history={history} route={{ kind: 'title', titleId: 't' }} />);
    const [discs, encodes] = screen.getAllByTestId('library-tab');
    expect(discs!.getAttribute('aria-current')).toBe('page');
    expect(encodes!.getAttribute('aria-current')).toBeNull();
    fireEvent.click(encodes!);
    expect(history.push).toHaveBeenCalledWith({ kind: 'encodes', q: '' });
    fireEvent.click(discs!);
    expect(history.push).toHaveBeenCalledWith({ kind: 'library', shelf: null, q: '' });
  });

  it('keeps its room but shows nothing while pending', () => {
    const history = { push: vi.fn() } as unknown as NasHistory;
    render(<LibraryTabs history={history} route={null} pending />);
    const nav = screen.getByTestId('library-tabs');
    expect(nav.className).toContain('pending');
    expect(nav.getAttribute('aria-hidden')).toBe('true');
    expect(nav.hasAttribute('inert')).toBe(true);
  });
});
