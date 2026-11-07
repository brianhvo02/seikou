import { describe, expect, it } from 'vitest';
import { languageName, trackLabel } from './language';

describe('languageName', () => {
  it('names ISO 639-2 codes, including bibliographic variants', () => {
    expect(['jpn', 'eng', 'fre', 'fra', 'ger', 'chi'].map(languageName)).toEqual(['Japanese', 'English', 'French', 'French', 'German', 'Chinese']);
  });

  it('returns empty for missing or undetermined, and the raw code when unknown', () => {
    expect([languageName(''), languageName('und'), languageName('qqq'), languageName('1x!')]).toEqual(['', '', 'qqq', '1x!']);
  });
});

describe('trackLabel', () => {
  it('reads number, language, codec and channels', () => {
    expect(trackLabel({ index: 2, codec: 'DTS-HD Master Audio', language: 'eng', channels: 'multichannel', playable: true })).toBe('2. English · DTS-HD Master Audio (multichannel)');
    expect(trackLabel({ index: 1, codec: 'LPCM', language: '', channels: '', playable: true })).toBe('1. Unknown language · LPCM');
  });
});
