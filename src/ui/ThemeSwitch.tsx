import { useSyncExternalStore, type ReactElement } from 'react';
import type { ThemeChoice, ThemeController } from './theme';

/** Each choice with its icon for a narrow screen: a half disc, a sun, a moon. */
const OPTIONS: readonly { readonly value: ThemeChoice; readonly label: string; readonly icon: ReactElement }[] = [
  { value: 'auto', label: 'Auto', icon: <path d="M8 2a6 6 0 1 0 0 12A6 6 0 0 0 8 2Zm0 1.5v9a4.5 4.5 0 0 1 0-9Z" /> },
  {
    value: 'light',
    label: 'Light',
    icon: (
      <>
        <circle cx="8" cy="8" r="3" />
        <path d="M8 .75v2M8 13.25v2M.75 8h2M13.25 8h2M2.9 2.9l1.4 1.4M11.7 11.7l1.4 1.4M2.9 13.1l1.4-1.4M11.7 4.3l1.4-1.4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
      </>
    ),
  },
  { value: 'dark', label: 'Dark', icon: <path d="M13.5 10.2A6 6 0 0 1 5.8 2.5a6 6 0 1 0 7.7 7.7Z" /> },
];

/** Auto (the device's setting), Light or Dark, for this device (spec 2026-10-27 §3). */
export function ThemeSwitch({ theme }: { readonly theme: ThemeController }): ReactElement {
  const { choice } = useSyncExternalStore(theme.subscribe, theme.getSnapshot);
  return (
    <fieldset className="theme-switch" data-testid="theme-switch">
      <legend className="visually-hidden">Theme</legend>
      {OPTIONS.map((o) => (
        <label key={o.value} className="theme-option" title={o.label}>
          <input type="radio" name="theme" value={o.value} aria-label={o.label} data-testid={`theme-${o.value}`} checked={choice === o.value} onChange={() => theme.setChoice(o.value)} />
          <span className="theme-word" aria-hidden="true">
            {o.label}
          </span>
          <svg className="theme-icon" viewBox="0 0 16 16" width="16" height="16" fill="currentColor" aria-hidden="true">
            {o.icon}
          </svg>
        </label>
      ))}
    </fieldset>
  );
}
