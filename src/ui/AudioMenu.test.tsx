// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { AudioMenu, type LevelAudio } from './AudioMenu';

afterEach(cleanup);

const levelAudio = (onPick: (n: number) => void): LevelAudio => ({
  tracks: [
    { number: 1, language: 'jpn', label: 'Japanese' },
    { number: 2, language: 'eng', label: 'English' },
  ],
  current: 1,
  onPick,
});

describe('AudioMenu at a re-encoded level', () => {
  it('lists the original tracks and switches the level audio', () => {
    const onPick = vi.fn();
    render(<AudioMenu tracks={[]} selected={null} levelAudio={levelAudio(onPick)} onSelect={() => undefined} onOpenChange={() => undefined} />);
    fireEvent.click(screen.getByTestId('audio-menu'));
    fireEvent.click(screen.getAllByRole('menuitemradio')[1]!);
    expect(onPick).toHaveBeenCalledWith(2);
  });

  it("is disabled with the disc's reason when its UO mask forbids an audio change", () => {
    const onPick = vi.fn();
    render(<AudioMenu tracks={[]} selected={null} disabledReason="The disc doesn't allow this here" levelAudio={levelAudio(onPick)} onSelect={() => undefined} onOpenChange={() => undefined} />);
    const button = screen.getByTestId('audio-menu') as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    expect(button.title).toBe("The disc doesn't allow this here");
    fireEvent.click(button);
    expect(screen.queryAllByRole('menuitemradio')).toHaveLength(0);
    expect(onPick).not.toHaveBeenCalled();
  });
});
