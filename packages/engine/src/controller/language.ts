import type { AudioTrack } from '../protocol';

/** ISO 639-2 codes (B and T forms) that differ from the two-letter tags Intl expects. */
const TWO_LETTER: Readonly<Record<string, string>> = {
  ara: 'ar', cat: 'ca', ces: 'cs', cze: 'cs', chi: 'zh', zho: 'zh', dan: 'da', deu: 'de', ger: 'de', dut: 'nl', nld: 'nl', ell: 'el', gre: 'el',
  eng: 'en', fin: 'fi', fra: 'fr', fre: 'fr', heb: 'he', hin: 'hi', hun: 'hu', ice: 'is', isl: 'is', ind: 'id', ita: 'it', jpn: 'ja', kor: 'ko',
  may: 'ms', msa: 'ms', nor: 'no', pol: 'pl', por: 'pt', ron: 'ro', rum: 'ro', rus: 'ru', spa: 'es', swe: 'sv', tha: 'th', tur: 'tr', ukr: 'uk',
  vie: 'vi',
};

let names: Intl.DisplayNames | null = null;

/**
 * The English name of an ISO 639-2 language code as a disc stores it (`jpn` gives "Japanese"). An empty or `und` code
 * gives an empty string; a code the browser does not know comes back as given.
 */
export function languageName(code: string): string {
  const c = code.trim().toLowerCase();
  if (c === '' || c === 'und') return '';
  try {
    names ??= new Intl.DisplayNames(['en'], { type: 'language' });
    return names.of(TWO_LETTER[c] ?? c) ?? code;
  } catch {
    return code;
  }
}

/** "2. Japanese · AC-3 (5.1)": the audio track's index, language name, codec and, when known, channel layout. */
export function trackLabel(track: AudioTrack): string {
  const language = languageName(track.language) || 'Unknown language';
  return `${track.index}. ${language} · ${track.codec}${track.channels ? ` (${track.channels})` : ''}`;
}
