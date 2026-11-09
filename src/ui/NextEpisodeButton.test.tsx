// @vitest-environment jsdom
// SPDX-License-Identifier: LGPL-3.0-or-later
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { NextEpisodeButton } from './NextEpisodeButton';

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

const advance = (ms: number): void => {
  act(() => {
    vi.advanceTimersByTime(ms);
  });
};

describe('NextEpisodeButton', () => {
  it('the countdown drains and calls onNext after 10 s', () => {
    const onNext = vi.fn();
    render(<NextEpisodeButton countdown seconds={10} onNext={onNext} onCancel={vi.fn()} reducedMotion={false} />);
    const button = screen.getByTestId('next-episode');
    expect(button.textContent).toContain('Next episode');
    const fill = screen.getByTestId('next-episode-fill');
    expect(fill.style.transform).toBe('scaleX(1)');
    advance(5000);
    expect(fill.style.transform).toBe('scaleX(0.5)');
    expect(onNext).not.toHaveBeenCalled();
    advance(5000);
    expect(onNext).toHaveBeenCalledTimes(1);
    advance(10_000);
    expect(onNext).toHaveBeenCalledTimes(1);
  });

  it('pauses while playback is paused', () => {
    const onNext = vi.fn();
    const { rerender } = render(<NextEpisodeButton countdown seconds={10} onNext={onNext} onCancel={vi.fn()} reducedMotion={false} />);
    advance(4000);
    rerender(<NextEpisodeButton countdown seconds={10} paused onNext={onNext} onCancel={vi.fn()} reducedMotion={false} />);
    advance(30_000);
    expect(onNext).not.toHaveBeenCalled();
    rerender(<NextEpisodeButton countdown seconds={10} onNext={onNext} onCancel={vi.fn()} reducedMotion={false} />);
    advance(5900);
    expect(onNext).not.toHaveBeenCalled();
    advance(200);
    expect(onNext).toHaveBeenCalledTimes(1);
  });

  it('cancel stops the countdown and keeps the button', () => {
    const onNext = vi.fn();
    const onCancel = vi.fn();
    render(<NextEpisodeButton countdown seconds={10} onNext={onNext} onCancel={onCancel} reducedMotion={false} />);
    advance(3000);
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(onCancel).toHaveBeenCalledTimes(1);
    advance(20_000);
    expect(onNext).not.toHaveBeenCalled();
    expect(screen.queryByRole('button', { name: 'Cancel' })).toBeNull();
    expect(screen.queryByTestId('next-episode-fill')).toBeNull();
    fireEvent.click(screen.getByTestId('next-episode'));
    expect(onNext).toHaveBeenCalledTimes(1);
  });

  it('without the setting the button shows and nothing advances', () => {
    const onNext = vi.fn();
    render(<NextEpisodeButton countdown={false} seconds={10} onNext={onNext} onCancel={vi.fn()} reducedMotion={false} />);
    expect(screen.getByTestId('next-episode').textContent).toBe('Next episode');
    expect(screen.queryByRole('button', { name: 'Cancel' })).toBeNull();
    expect(screen.queryByTestId('next-episode-fill')).toBeNull();
    advance(60_000);
    expect(onNext).not.toHaveBeenCalled();
    fireEvent.click(screen.getByTestId('next-episode'));
    expect(onNext).toHaveBeenCalledTimes(1);
  });

  it('with reduced motion counts the seconds in words instead of draining', () => {
    const onNext = vi.fn();
    render(<NextEpisodeButton countdown seconds={10} onNext={onNext} onCancel={vi.fn()} reducedMotion />);
    expect(screen.queryByTestId('next-episode-fill')).toBeNull();
    expect(screen.getByTestId('next-episode').textContent).toBe('Next episode in 10');
    advance(3000);
    expect(screen.getByTestId('next-episode').textContent).toBe('Next episode in 7');
    advance(7000);
    expect(onNext).toHaveBeenCalledTimes(1);
  });
});
