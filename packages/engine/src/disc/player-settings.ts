// Ported from libbluray src/libbluray/bluray.c (bd_set_player_setting_str) and src/util/strutl.c (str_to_uint32).
// SPDX-License-Identifier: LGPL-2.1-or-later
import { PSR, type RegisterFile } from '../hdmv/registers';

/** The string player settings of bd_set_player_setting_str: ISO 639-2 languages and an ISO 3166 country code. */
export interface PlayerSettings {
  readonly audioLanguage?: string;
  readonly pgLanguage?: string;
  readonly menuLanguage?: string;
  readonly country?: string;
}

/** str_to_uint32: the first `n` bytes big-endian, padded with zero bytes past the end; all ones for an empty string. */
export function strToUint32(s: string, n: number): number {
  if (s === '') return n >= 4 ? 0xffffffff : 2 ** (8 * n) - 1;
  let v = 0;
  for (let i = 0; i < Math.min(n, 4); i++) v = ((v << 8) | (i < s.length ? s.charCodeAt(i) & 0xff : 0)) >>> 0;
  return v;
}

/** bd_set_player_setting_str for the languages (3 bytes) and the country (2 bytes): a setting write of the PSR. */
export function applyPlayerSettings(regs: RegisterFile, settings: PlayerSettings): void {
  if (settings.audioLanguage !== undefined) regs.psrSettingWrite(PSR.AUDIO_LANG, strToUint32(settings.audioLanguage, 3));
  if (settings.pgLanguage !== undefined) regs.psrSettingWrite(PSR.PG_AND_SUB_LANG, strToUint32(settings.pgLanguage, 3));
  if (settings.menuLanguage !== undefined) regs.psrSettingWrite(PSR.MENU_LANG, strToUint32(settings.menuLanguage, 3));
  if (settings.country !== undefined) regs.psrSettingWrite(PSR.COUNTRY, strToUint32(settings.country, 2));
}

/**
 * ISO 639-1 to ISO 639-2. Blu-ray discs label their streams with the bibliographic (/B) codes ("fre", "ger", "chi"),
 * so where /B and /T differ this table uses /B.
 */
const ISO_639_2: Readonly<Record<string, string>> = {
  ar: 'ara', bg: 'bul', bn: 'ben', ca: 'cat', cs: 'cze', cy: 'wel', da: 'dan', de: 'ger', el: 'gre', en: 'eng',
  es: 'spa', et: 'est', eu: 'baq', fa: 'per', fi: 'fin', fr: 'fre', ga: 'gle', gl: 'glg', he: 'heb', hi: 'hin',
  hr: 'hrv', hu: 'hun', hy: 'arm', id: 'ind', is: 'ice', it: 'ita', ja: 'jpn', ka: 'geo', kk: 'kaz', km: 'khm',
  ko: 'kor', lt: 'lit', lv: 'lav', mk: 'mac', ml: 'mal', mr: 'mar', ms: 'may', mt: 'mlt', my: 'bur', nb: 'nob',
  nl: 'dut', nn: 'nno', no: 'nor', pa: 'pan', pl: 'pol', pt: 'por', ro: 'rum', ru: 'rus', sk: 'slo', sl: 'slv',
  sq: 'alb', sr: 'srp', sv: 'swe', sw: 'swa', ta: 'tam', te: 'tel', th: 'tha', tl: 'tgl', tr: 'tur', uk: 'ukr',
  ur: 'urd', vi: 'vie', zh: 'chi', zu: 'zul',
};

/**
 * The settings a player application would pass for a BCP 47 locale (the browser's `navigator.language`): its
 * language as ISO 639-2/B for audio, subtitles and menus, and its region as the country in lowercase, as libbluray's
 * examples do. Anything unknown stays unset, so the register keeps libbluray's default.
 */
export function playerSettingsForLocale(tag: string | undefined): PlayerSettings {
  let locale: Intl.Locale;
  try {
    locale = new Intl.Locale(tag ?? '');
  } catch {
    return {};
  }
  const language = ISO_639_2[locale.language];
  const region = locale.region !== undefined && /^[A-Z]{2}$/.test(locale.region) ? locale.region.toLowerCase() : undefined;
  return {
    ...(language ? { audioLanguage: language, pgLanguage: language, menuLanguage: language } : {}),
    ...(region ? { country: region } : {}),
  };
}
