// SPDX-License-Identifier: LGPL-3.0-or-later
/**
 * The person's disc preferences turned into the player settings a disc starts with (`setDiscPreferences`), Auto
 * resolved here: audio and subtitles left to the disc, menu language and country from the browser's locale, the
 * region from the country. Also the language list the settings offer and the matcher an encode's tracks are picked by.
 */
import type { DiscPreferences } from '@seikou/nas/nas-api';
import type { PlayerSettings } from '@seikou/engine';
import { ISO_639_1_TO_2B, playerSettingsForLocale } from '@seikou/engine/disc/player-settings';

/** The languages the settings offer: the ISO 639-2/B codes the player knows for a browser language. */
export const PREFERENCE_LANGUAGES: readonly string[] = [...new Set(Object.values(ISO_639_1_TO_2B))];

/** ISO 639-2/T codes that differ from their /B code, to /B. */
const T_TO_B: Readonly<Record<string, string>> = {
  fra: 'fre', deu: 'ger', zho: 'chi', ces: 'cze', nld: 'dut', ell: 'gre', isl: 'ice', fas: 'per', ron: 'rum', slk: 'slo',
  cym: 'wel', sqi: 'alb', hye: 'arm', eus: 'baq', mya: 'bur', kat: 'geo', mkd: 'mac', msa: 'may',
};

/** Region A: the Americas, Japan, Korea, Taiwan, Hong Kong and Southeast Asia. */
const REGION_A = new Set([
  'ag', 'ai', 'ar', 'aw', 'bb', 'bl', 'bm', 'bo', 'bq', 'br', 'bs', 'bz', 'ca', 'cl', 'co', 'cr', 'cu', 'cw', 'dm', 'do',
  'ec', 'fk', 'gd', 'gf', 'gl', 'gp', 'gt', 'gy', 'hn', 'ht', 'jm', 'kn', 'ky', 'lc', 'mf', 'mq', 'ms', 'mx', 'ni', 'pa',
  'pe', 'pm', 'pr', 'py', 'sr', 'sv', 'sx', 'tc', 'tt', 'um', 'us', 'uy', 'vc', 've', 'vg', 'vi',
  'jp', 'kr', 'kp', 'tw', 'hk',
  'bn', 'kh', 'id', 'la', 'my', 'mm', 'ph', 'sg', 'th', 'tl', 'vn',
]);

/** Region C: China, Russia, Central and South Asia, and Mongolia. */
const REGION_C = new Set(['cn', 'ru', 'by', 'kz', 'kg', 'tj', 'tm', 'uz', 'mn', 'af', 'bd', 'bt', 'in', 'mv', 'np', 'pk', 'lk']);

const REGION_CODE = { A: 1, B: 2, C: 4 } as const;
const REGION_LETTER = { 1: 'A', 2: 'B', 4: 'C' } as const;

/** The Blu-ray region of a country (ISO 3166-1 alpha-2, any case): 1 (A), 2 (B) or 4 (C); B when unknown. */
export function regionForCountry(country: string | undefined): 1 | 2 | 4 {
  const c = country?.toLowerCase();
  if (c && REGION_A.has(c)) return 1;
  if (c && REGION_C.has(c)) return 4;
  return 2;
}

/**
 * The player settings for the preferences in a browser locale (`navigator.language`): pinned values as they are,
 * Auto audio and subtitles left out (the disc decides), Auto menu language and country from the locale, an Auto region
 * from the country.
 */
export function resolveDiscPreferences(p: DiscPreferences, locale: string | undefined): PlayerSettings {
  const fromLocale = playerSettingsForLocale(locale);
  const menuLanguage = p.menuLanguage === 'auto' ? fromLocale.menuLanguage : p.menuLanguage;
  const country = p.country === 'auto' ? fromLocale.country : p.country;
  return {
    ...(p.audioLanguage !== 'auto' ? { audioLanguage: p.audioLanguage } : {}),
    ...(p.subtitleLanguage !== 'auto' ? { pgLanguage: p.subtitleLanguage } : {}),
    ...(menuLanguage !== undefined ? { menuLanguage } : {}),
    ...(country !== undefined ? { country } : {}),
    region: p.region === 'auto' ? regionForCountry(country) : REGION_CODE[p.region],
  };
}

/** What each Auto stands for now, as the settings show it ("Auto (English)"). */
export interface AutoLabels {
  /** Audio's Auto: always the disc's choice. */
  readonly audio: string;
  /** Subtitles' Auto: always the disc's choice. */
  readonly subtitle: string;
  /** The browser's language by name, or `none`. */
  readonly menu: string;
  /** The browser's country by name, or `none`. */
  readonly country: string;
  /** The region Auto gives. */
  readonly region: 'A' | 'B' | 'C';
}

const namers = new Map<string, Intl.DisplayNames | null>();

/** Names a language code or a country code in `displayLocale`, the code itself when the browser can't. */
function displayName(type: 'language' | 'region', code: string, displayLocale: string): string {
  const key = `${type}:${displayLocale}`;
  let namer = namers.get(key);
  if (namer === undefined) {
    try {
      namer = new Intl.DisplayNames([displayLocale], { type, fallback: 'code' });
    } catch {
      namer = null;
    }
    namers.set(key, namer);
  }
  try {
    return namer?.of(code) ?? code;
  } catch {
    return code;
  }
}

/** A language's name for an ISO 639-2/B code, in `displayLocale`. */
export function languageName(code: string, displayLocale: string): string {
  const one = Object.entries(ISO_639_1_TO_2B).find(([, b]) => b === code)?.[0];
  return displayName('language', one ?? code, displayLocale);
}

/** A country's name for its lower-case ISO 3166-1 code, in `displayLocale`. */
export function countryName(code: string, displayLocale: string): string {
  return displayName('region', code.toUpperCase(), displayLocale);
}

/** What Auto resolves to for each preference in a browser locale, named in `displayLocale`. */
export function autoLabels(locale: string | undefined, displayLocale: string): AutoLabels {
  const s = playerSettingsForLocale(locale);
  return {
    audio: "disc's choice",
    subtitle: "disc's choice",
    menu: s.menuLanguage ? languageName(s.menuLanguage, displayLocale) : 'none',
    country: s.country ? countryName(s.country, displayLocale) : 'none',
    region: REGION_LETTER[regionForCountry(s.country)],
  };
}

/** Whether a track's language tag (ISO 639-2/B or /T, or BCP 47 such as `fr-CA`) is the pinned ISO 639-2/B `pin`. */
export function languageMatches(tag: string | null | undefined, pin: string): boolean {
  if (!tag) return false;
  const primary = tag.toLowerCase().split(/[-_]/)[0]!;
  const b = primary.length === 2 ? ISO_639_1_TO_2B[primary] : (T_TO_B[primary] ?? primary);
  return b === pin;
}
