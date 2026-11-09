// @vitest-environment jsdom
// SPDX-License-Identifier: LGPL-3.0-or-later
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { ChapterMenu, EncodeSettingsMenu } from './EncodeMenus';

afterEach(cleanup);

const S = 1e6;

describe('the encode menus', () => {
  it('lists the chapters by name and time, checks the one playing, and seeks on a click', () => {
    const onSeek = vi.fn();
    const chapters = [{ index: 0, startUs: 0, name: 'Prologue' }, { index: 1, startUs: 90 * S, name: 'Opening' }, { index: 2, startUs: 180 * S }];
    render(<ChapterMenu chapters={chapters} timeUs={100 * S} onSeek={onSeek} onOpenChange={() => {}} />);
    fireEvent.click(screen.getByTestId('chapter-menu'));
    const items = screen.getAllByRole('menuitemradio');
    expect(items.map((i) => i.textContent)).toEqual(['Prologue · 0:00', 'Opening · 1:30', 'Chapter 3 · 3:00']);
    expect(items.map((i) => i.getAttribute('aria-checked'))).toEqual(['false', 'true', 'false']);
    fireEvent.click(items[2]!);
    expect(onSeek).toHaveBeenCalledWith(180 * S);
    expect(screen.queryByRole('menu')).toBeNull();
  });

  it('shows no chapter menu for an episode without chapters', () => {
    render(<ChapterMenu chapters={[]} timeUs={0} onSeek={() => {}} onOpenChange={() => {}} />);
    expect(screen.queryByTestId('chapter-menu')).toBeNull();
  });

  it('switches the Next episode countdown, and waits for the NAS to say what it is', () => {
    const onCountdown = vi.fn();
    const { rerender } = render(<EncodeSettingsMenu countdown={null} onCountdown={onCountdown} onOpenChange={() => {}} />);
    fireEvent.click(screen.getByTestId('player-settings-menu'));
    const item = screen.getByRole('menuitemcheckbox', { name: /Next episode countdown/ });
    expect((item as HTMLButtonElement).disabled).toBe(true);
    rerender(<EncodeSettingsMenu countdown={false} onCountdown={onCountdown} onOpenChange={() => {}} />);
    expect(item.getAttribute('aria-checked')).toBe('false');
    fireEvent.click(item);
    expect(onCountdown).toHaveBeenCalledWith(true);
  });
});
