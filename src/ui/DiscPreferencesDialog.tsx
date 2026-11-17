// SPDX-License-Identifier: LGPL-3.0-or-later
import { useCallback, useEffect, useMemo, useRef, useSyncExternalStore, type ReactElement } from 'react';
import type { DiscPreferences, RegionPref } from '@seikou/nas/nas-api';
import { autoLabels, countryName, languageName, PREFERENCE_LANGUAGES } from './disc-preferences';
import type { DiscPreferencesStore } from './disc-preferences-store';

/** What the dialog reads and writes: the person's disc preferences store. */
export type DiscPreferencesSource = Pick<DiscPreferencesStore, 'current' | 'state' | 'subscribe' | 'set'>;

interface DiscPreferencesDialogProps {
  readonly source: DiscPreferencesSource;
  /** `encode` shows only audio and subtitles (an MKV has no menu language, country or region). */
  readonly kind: 'disc' | 'encode';
  /** The browser's locale, for what Auto stands for and the names shown. */
  readonly locale: string | undefined;
  onClose(): void;
}

/** Every ISO 3166-1 alpha-2 code the browser can name, lower case, by name. */
function countryCodes(displayLocale: string): readonly string[] {
  const out: string[] = [];
  for (let a = 97; a <= 122; a++) {
    for (let b = 97; b <= 122; b++) {
      const code = String.fromCharCode(a, b);
      const name = countryName(code, displayLocale);
      if (name !== code.toUpperCase()) out.push(code);
    }
  }
  return out.sort((x, y) => countryName(x, displayLocale).localeCompare(countryName(y, displayLocale), displayLocale));
}

/**
 * Disc preferences: the person's preferred audio, subtitle and menu languages, country and region, each Auto or
 * pinned, saved as they change. A change applies from the next disc (or episode) opened.
 */
export function DiscPreferencesDialog({ source, kind, locale, onClose }: DiscPreferencesDialogProps): ReactElement {
  const subscribe = useCallback((fn: () => void) => source.subscribe(fn), [source]);
  const prefs = useSyncExternalStore(subscribe, () => source.current());
  const state = useSyncExternalStore(subscribe, () => source.state());
  const display = locale || 'en';
  const auto = autoLabels(locale, display);
  const languages = useMemo(
    () => [...PREFERENCE_LANGUAGES].sort((x, y) => languageName(x, display).localeCompare(languageName(y, display), display)),
    [display],
  );
  const countries = useMemo(() => countryCodes(display), [display]);
  const firstRef = useRef<HTMLSelectElement>(null);

  useEffect(() => {
    firstRef.current?.focus();
    const escape = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', escape);
    return () => window.removeEventListener('keydown', escape);
  }, [onClose]);

  const change = (key: keyof DiscPreferences, value: string): void => void source.set({ ...prefs, [key]: value } as DiscPreferences);
  const language = (key: 'audioLanguage' | 'subtitleLanguage' | 'menuLanguage', label: string, autoLabel: string, testId: string, ref?: typeof firstRef): ReactElement => (
    <label className="pref-row">
      <span>{label}</span>
      <select ref={ref} data-testid={testId} value={prefs[key]} onChange={(e) => change(key, e.target.value)}>
        <option value="auto">{`Auto (${autoLabel})`}</option>
        {languages.map((code) => (
          <option key={code} value={code}>
            {languageName(code, display)}
          </option>
        ))}
      </select>
    </label>
  );

  return (
    <div className="picker-backdrop disc-prefs-backdrop">
      <div className="picker disc-prefs" role="dialog" aria-modal="true" aria-labelledby="disc-prefs-title" data-testid="disc-preferences">
        <h2 id="disc-prefs-title">Disc preferences</h2>
        {language('audioLanguage', 'Audio language', auto.audio, 'pref-audio', firstRef)}
        {language('subtitleLanguage', 'Subtitle language', auto.subtitle, 'pref-subtitle')}
        {kind === 'disc' && (
          <>
            {language('menuLanguage', 'Menu language', auto.menu, 'pref-menu')}
            <label className="pref-row">
              <span>Country</span>
              <select data-testid="pref-country" value={prefs.country} onChange={(e) => change('country', e.target.value)}>
                <option value="auto">{`Auto (${auto.country})`}</option>
                {countries.map((code) => (
                  <option key={code} value={code}>
                    {countryName(code, display)}
                  </option>
                ))}
              </select>
            </label>
            <label className="pref-row">
              <span>Region</span>
              <select data-testid="pref-region" value={prefs.region} onChange={(e) => change('region', e.target.value as RegionPref)}>
                <option value="auto">{`Auto (${auto.region})`}</option>
                <option value="A">A: the Americas, Japan, Korea, Southeast Asia</option>
                <option value="B">B: Europe, Africa, the Middle East, Oceania</option>
                <option value="C">C: China, Russia, Central and South Asia</option>
              </select>
            </label>
          </>
        )}
        <p className="hint">{kind === 'disc' ? 'Applies from the next disc you open.' : 'Applies from the next episode you open.'}</p>
        {state === 'device-only' && <p className="hint">Saved on this device until the NAS is updated.</p>}
        <div className="picker-actions">
          <span />
          <button type="button" className="primary" data-testid="pref-done" onClick={onClose}>
            Done
          </button>
        </div>
      </div>
    </div>
  );
}
