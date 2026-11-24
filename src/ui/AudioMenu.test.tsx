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

describe('AudioMenu decoding mark', () => {
  const tracks = [
    { index: 1, codec: 'Dolby TrueHD', language: 'eng', channels: 'multichannel' as const, playable: true },
    { index: 2, codec: 'Dolby Digital (AC-3)', language: 'eng', channels: 'multichannel' as const, playable: true },
  ];
  const open = (decoding: { part: 'full' | 'core' | 'plain'; description: string } | null): void => {
    render(<AudioMenu tracks={tracks} selected={1} decoding={decoding} onSelect={() => undefined} onOpenChange={() => undefined} />);
    fireEvent.click(screen.getByTestId('audio-menu'));
  };

  it('marks the playing TrueHD track lossless, with the description as its tooltip', () => {
    open({ part: 'full', description: 'Dolby TrueHD, lossless, 7.1' });
    const mark = screen.getByTestId('audio-decoding');
    expect(mark.textContent).toBe('lossless');
    expect(mark.title).toBe('Dolby TrueHD, lossless, 7.1');
    expect(screen.getByTestId('audio-track-1').contains(mark)).toBe(true);
  });

  it('marks a core, and nothing for a plain stream or DTS-HD High Resolution', () => {
    open({ part: 'core', description: 'Dolby TrueHD, Dolby Digital core, 5.1' });
    expect(screen.getByTestId('audio-decoding').textContent).toBe('core');
    cleanup();
    open({ part: 'plain', description: 'Dolby Digital (AC-3), 5.1' });
    expect(screen.queryByTestId('audio-decoding')).toBeNull();
    cleanup();
    open({ part: 'full', description: 'DTS-HD High Resolution, 7.1' });
    expect(screen.queryByTestId('audio-decoding')).toBeNull();
  });
});
