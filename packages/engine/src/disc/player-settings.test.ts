import { describe, expect, it } from 'vitest';
import { RegisterFile } from '../hdmv/registers';
import { applyPlayerSettings, playerSettingsForLocale, strToUint32 } from './player-settings';

describe('player settings (bd_set_player_setting_str)', () => {
  it('packs strings as str_to_uint32 does', () => {
    expect(strToUint32('eng', 3)).toBe(0x656e67);
    expect(strToUint32('us', 2)).toBe(0x7573);
    expect(strToUint32('e', 3)).toBe(0x650000); // past the end: zero bytes
    expect(strToUint32('', 3)).toBe(0xffffff);
    expect(strToUint32('', 2)).toBe(0xffff);
  });

  it('writes the language and country PSRs as settings', () => {
    const regs = new RegisterFile();
    applyPlayerSettings(regs, { audioLanguage: 'jpn', pgLanguage: 'eng', menuLanguage: 'fra', country: 'jp' });
    expect([16, 17, 18, 19].map((i) => regs.psrRead(i))).toEqual([0x6a706e, 0x656e67, 0x667261, 0x6a70]);
  });

  it('leaves a setting it is not given alone', () => {
    const regs = new RegisterFile();
    const before = regs.psrRead(16);
    applyPlayerSettings(regs, { country: 'us' });
    expect(regs.psrRead(16)).toBe(before);
  });

  it('derives the settings from a browser locale: ISO 639-2/B languages, a lowercase ISO 3166 country', () => {
    expect(playerSettingsForLocale('en-US')).toEqual({ audioLanguage: 'eng', pgLanguage: 'eng', menuLanguage: 'eng', country: 'us' });
    expect(playerSettingsForLocale('fr-CA')).toEqual({ audioLanguage: 'fre', pgLanguage: 'fre', menuLanguage: 'fre', country: 'ca' });
    expect(playerSettingsForLocale('de')).toEqual({ audioLanguage: 'ger', pgLanguage: 'ger', menuLanguage: 'ger' });
    expect(playerSettingsForLocale('ja-JP')).toEqual({ audioLanguage: 'jpn', pgLanguage: 'jpn', menuLanguage: 'jpn', country: 'jp' });
    expect(playerSettingsForLocale('zh-Hant-TW')).toMatchObject({ audioLanguage: 'chi', country: 'tw' });
    expect(playerSettingsForLocale('es-419')).toEqual({ audioLanguage: 'spa', pgLanguage: 'spa', menuLanguage: 'spa' }); // a numeric region is no country
  });

  it('leaves what it cannot tell unset (libbluray defaults)', () => {
    expect(playerSettingsForLocale(undefined)).toEqual({});
    expect(playerSettingsForLocale('')).toEqual({});
    expect(playerSettingsForLocale('not a locale!')).toEqual({});
    expect(playerSettingsForLocale('tlh-US')).toEqual({ country: 'us' }); // a language without a known ISO 639-2 code
  });
});
