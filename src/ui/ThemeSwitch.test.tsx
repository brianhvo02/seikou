// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { ThemeController, type ThemeDeps } from './theme';
import { ThemeSwitch } from './ThemeSwitch';

afterEach(cleanup);

function controller(): ThemeController {
  const media = Object.assign(new EventTarget(), { matches: false, media: '', onchange: null }) as unknown as MediaQueryList;
  const map = new Map<string, string>();
  const storage = { getItem: (k: string) => map.get(k) ?? null, setItem: (k: string, v: string) => void map.set(k, v) } as unknown as Storage;
  return new ThemeController({ storage: () => storage, matchMedia: () => media, target: new EventTarget() as unknown as ThemeDeps['target'], doc: document });
}

describe('ThemeSwitch', () => {
  it('is a radio group named Theme with Auto checked on a new device', () => {
    render(<ThemeSwitch theme={controller()} />);
    const group = screen.getByRole('group', { name: 'Theme' });
    expect(group.getAttribute('data-testid')).toBe('theme-switch');
    const radios = screen.getAllByRole('radio');
    expect(radios.map((r) => r.getAttribute('aria-label') ?? r.closest('label')?.textContent)).toEqual(['Auto', 'Light', 'Dark']);
    expect(radios.every((r) => r.getAttribute('name') === 'theme')).toBe(true);
    expect((screen.getByTestId('theme-auto') as HTMLInputElement).checked).toBe(true);
  });

  it('chooses a theme', () => {
    const theme = controller();
    render(<ThemeSwitch theme={theme} />);
    fireEvent.click(screen.getByTestId('theme-light'));
    expect(theme.getSnapshot().choice).toBe('light');
    expect((screen.getByTestId('theme-light') as HTMLInputElement).checked).toBe(true);
    expect(document.documentElement.dataset.theme).toBe('light');
  });

  it('follows a change made elsewhere', () => {
    const theme = controller();
    render(<ThemeSwitch theme={theme} />);
    act(() => theme.setChoice('dark'));
    expect((screen.getByTestId('theme-dark') as HTMLInputElement).checked).toBe(true);
  });
});
