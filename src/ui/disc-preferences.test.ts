// SPDX-License-Identifier: LGPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import { AUTO_DISC_PREFERENCES } from '@seikou/nas/nas-api';
import { autoLabels, languageMatches, PREFERENCE_LANGUAGES, regionForCountry, resolveDiscPreferences } from './disc-preferences';

describe('disc preferences', () => {
  it('Auto leaves audio and subtitles to the disc, and takes menus, country and region from the browser', () => {
    expect(resolveDiscPreferences(AUTO_DISC_PREFERENCES, 'en-US')).toEqual({ menuLanguage: 'eng', country: 'us', region: 1 });
  });

  it('a pinned value wins over Auto for that preference only', () => {
    const p = { audioLanguage: 'jpn', subtitleLanguage: 'eng', menuLanguage: 'auto', country: 'jp', region: 'auto' } as const;
    expect(resolveDiscPreferences(p, 'fr-FR')).toEqual({ audioLanguage: 'jpn', pgLanguage: 'eng', menuLanguage: 'fre', country: 'jp', region: 1 });
  });

  it('a browser locale without a region gives no country and region B', () => {
    expect(resolveDiscPreferences(AUTO_DISC_PREFERENCES, 'de')).toEqual({ menuLanguage: 'ger', region: 2 });
    expect(resolveDiscPreferences(AUTO_DISC_PREFERENCES, undefined)).toEqual({ region: 2 });
  });

  it('a pinned region wins over the country', () => {
    expect(resolveDiscPreferences({ ...AUTO_DISC_PREFERENCES, country: 'us', region: 'C' }, 'en-US')).toMatchObject({ country: 'us', region: 4 });
  });

  it('maps countries to Blu-ray regions', () => {
    const cases: Array<[string | undefined, number]> = [['us', 1], ['br', 1], ['jp', 1], ['sg', 1], ['kr', 1], ['gb', 2], ['au', 2], ['za', 2], ['fr', 2], ['cn', 4], ['ru', 4], ['in', 4], [undefined, 2], ['zz', 2]];
    for (const [c, r] of cases) expect([c, regionForCountry(c)]).toEqual([c, r]);
  });

  it('matches a pin against ISO 639-2/B, /T and BCP 47 tags', () => {
    for (const tag of ['fre', 'fra', 'fr', 'fr-CA', 'FRA']) expect([tag, languageMatches(tag, 'fre')]).toEqual([tag, true]);
    for (const tag of ['eng', 'en', null, undefined, '']) expect([tag, languageMatches(tag, 'fre')]).toEqual([tag, false]);
    expect(languageMatches('ja', 'jpn')).toBe(true);
    expect(languageMatches('deu', 'ger')).toBe(true);
    expect(languageMatches('zh-Hant', 'chi')).toBe(true);
  });

  it('names what Auto stands for', () => {
    expect(autoLabels('en-US', 'en')).toEqual({ audio: "disc's choice", subtitle: "disc's choice", menu: 'English', country: 'United States', region: 'A' });
    expect(autoLabels(undefined, 'en')).toEqual({ audio: "disc's choice", subtitle: "disc's choice", menu: 'none', country: 'none', region: 'B' });
  });

  it('offers the 64 ISO 639-2/B languages', () => {
    expect(PREFERENCE_LANGUAGES).toHaveLength(64);
    expect(PREFERENCE_LANGUAGES).toContain('jpn');
    expect(PREFERENCE_LANGUAGES).toContain('fre');
  });
});
