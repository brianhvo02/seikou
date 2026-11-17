// @vitest-environment jsdom
// SPDX-License-Identifier: LGPL-3.0-or-later
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { AUTO_DISC_PREFERENCES, type DiscPreferences } from '@seikou/nas/nas-api';
import { DiscPreferencesDialog, type DiscPreferencesSource } from './DiscPreferencesDialog';

afterEach(cleanup);

/** A store whose methods need their `this`, as the real one's do. */
function source(state: ReturnType<DiscPreferencesSource['state']> = 'synced', prefs: DiscPreferences = AUTO_DISC_PREFERENCES) {
  class Source {
    readonly prefs = prefs;
    readonly stateNow = state;
    readonly set = vi.fn(async () => undefined);
    current(): DiscPreferences {
      return this.prefs;
    }
    state(): ReturnType<DiscPreferencesSource['state']> {
      return this.stateNow;
    }
    subscribe(): () => void {
      return () => this.prefs;
    }
  }
  return new Source();
}

describe('DiscPreferencesDialog', () => {
  it('offers five preferences for a disc, each starting with what Auto stands for', () => {
    render(<DiscPreferencesDialog source={source()} kind="disc" locale="en-US" onClose={() => undefined} />);
    for (const id of ['pref-audio', 'pref-subtitle', 'pref-menu', 'pref-country', 'pref-region']) expect(screen.getByTestId(id)).toBeTruthy();
    const audio = screen.getByTestId('pref-audio') as HTMLSelectElement;
    expect(audio.options[0]!.textContent).toBe("Auto (disc's choice)");
    expect((screen.getByTestId('pref-menu') as HTMLSelectElement).options[0]!.textContent).toBe('Auto (English)');
    expect((screen.getByTestId('pref-region') as HTMLSelectElement).options[0]!.textContent).toBe('Auto (A)');
    expect(screen.getByText('Applies from the next disc you open.')).toBeTruthy();
  });

  it('offers only audio and subtitles for an encode', () => {
    render(<DiscPreferencesDialog source={source()} kind="encode" locale="en-US" onClose={() => undefined} />);
    expect(screen.queryByTestId('pref-menu')).toBeNull();
    expect(screen.queryByTestId('pref-region')).toBeNull();
    expect(screen.getByText('Applies from the next episode you open.')).toBeTruthy();
  });

  it('saves a pick', () => {
    const s = source();
    render(<DiscPreferencesDialog source={s} kind="disc" locale="en-US" onClose={() => undefined} />);
    fireEvent.change(screen.getByTestId('pref-audio'), { target: { value: 'jpn' } });
    expect(s.set).toHaveBeenCalledWith({ ...AUTO_DISC_PREFERENCES, audioLanguage: 'jpn' });
    fireEvent.change(screen.getByTestId('pref-region'), { target: { value: 'C' } });
    expect(s.set).toHaveBeenLastCalledWith({ ...AUTO_DISC_PREFERENCES, region: 'C' });
  });

  it('says when the NAS is too old to keep them', () => {
    render(<DiscPreferencesDialog source={source('device-only')} kind="disc" locale="en-US" onClose={() => undefined} />);
    expect(screen.getByText('Saved on this device until the NAS is updated.')).toBeTruthy();
  });

  it('closes on Done and on Escape', () => {
    const onClose = vi.fn();
    render(<DiscPreferencesDialog source={source()} kind="disc" locale="en-US" onClose={onClose} />);
    fireEvent.click(screen.getByTestId('pref-done'));
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(onClose).toHaveBeenCalledTimes(2);
  });
});
