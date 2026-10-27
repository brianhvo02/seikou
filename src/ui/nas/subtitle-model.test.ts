import { describe, expect, it } from 'vitest';
import type { StoredSubtitle } from '../../engine/disc/nas-api';
import type { DiscManifest, SeasonDetail, SubtitleCreate } from '../../engine/disc/nas-api';
import { CodingType } from '../../engine/bdmv/stream-types';
import { buildMpls } from '../../../tests/helpers/bdmv-builders';
import { NasHttpError } from './nas-client';
import {
  FONTS_LIMIT_BYTES, LANGUAGES, editPatch, offsetFrom, ownerListing, SUBTITLE_LIMIT_BYTES, forPlaylist, forSeason, formatOffset, languageTag, parseOffset, playlistChoices, sameLanguage, startFor,
  subtitleErrorMessage, subtitleTarget, tagsByEpisode, uploadSubtitle, validateUpload, type SubtitleWriter,
} from './subtitle-model';

const file = (name: string, size = 10): File => new File([new Uint8Array(size)], name);

function sub(id: string, language: string, attachment: StoredSubtitle['attachment']): StoredSubtitle {
  return { id, name: id, language, offsetMs: 0, fileName: `${id}.srt`, fileSize: 1, fonts: [], attachment, uploaderPersonId: 'p', uploadedAt: 1 };
}
const ep = (episode: number, seasonId = 's1', playlistId = '00001'): StoredSubtitle['attachment'] => ({
  kind: 'episode', discKey: 'd.1', playlistId, titleId: 't', seasonId, episode,
});
const ch = (chapter: number, playlistId = '00001', discKey = 'd.1'): StoredSubtitle['attachment'] => ({ kind: 'chapter', discKey, playlistId, chapter });

describe('LANGUAGES', () => {
  it('lists the offered languages', () => {
    expect(LANGUAGES.map((l) => l.code)).toEqual(['en', 'ja', 'zh-Hans', 'zh-Hant', 'ko', 'fr', 'de', 'es', 'it', 'pt', 'ru']);
  });
});

describe('validateUpload', () => {
  it('takes one subtitle and its fonts', () => {
    const sub = file('a.ASS');
    const font = file('f.ttf');
    expect(validateUpload([font, sub])).toEqual({ subtitle: sub, fonts: [font] });
  });
  it('refuses two subtitle files', () => {
    expect(validateUpload([file('a.srt'), file('b.ass')])).toEqual({ error: 'Pick one subtitle file (SRT or ASS) at a time.' });
  });
  it('refuses a pick with no subtitle file, fonts only included', () => {
    expect(validateUpload([file('f.ttf')])).toEqual({ error: 'Pick a subtitle file (SRT, ASS or SSA).' });
    expect(validateUpload([])).toEqual({ error: 'Pick a subtitle file (SRT, ASS or SSA).' });
  });
  it('refuses files that are neither', () => {
    expect(validateUpload([file('a.srt'), file('notes.txt')])).toEqual({ error: 'notes.txt is neither a subtitle file nor a font.' });
  });
  it('refuses a WOFF2 font, which the ASS renderer cannot read', () => {
    expect(validateUpload([file('a.ass'), file('f.woff2')])).toEqual({ error: "f.woff2 is a WOFF2 font, which subtitles can't use. Convert it to TTF or OTF." });
    expect('subtitle' in validateUpload([file('a.ass'), file('f.woff')])).toBe(true);
  });
  it('refuses an empty subtitle file', () => {
    expect(validateUpload([file('a.srt', 0)])).toEqual({ error: 'a.srt is empty.' });
  });
  it('limits the subtitle file to 5 MB', () => {
    expect('subtitle' in validateUpload([file('a.srt', SUBTITLE_LIMIT_BYTES)])).toBe(true);
    expect(validateUpload([file('a.srt', SUBTITLE_LIMIT_BYTES + 1)])).toEqual({ error: 'a.srt is over 5 MB.' });
  });
  it('limits the fonts to 50 MB together', () => {
    const half = FONTS_LIMIT_BYTES / 2;
    expect('subtitle' in validateUpload([file('a.srt'), file('a.ttf', half), file('b.otf', half)])).toBe(true);
    expect(validateUpload([file('a.srt'), file('a.ttf', half), file('b.otf', half + 1)])).toEqual({ error: 'The fonts are over 50 MB together.' });
  });
});

describe('tagsByEpisode', () => {
  it('maps episodes to sorted, unique languages of the season', () => {
    const subs = [sub('a', 'ja', ep(1)), sub('b', 'en', ep(1)), sub('c', 'en', ep(1)), sub('d', 'fr', ep(2)), sub('e', 'de', ep(1, 's2')), sub('f', 'ko', ch(1))];
    expect(tagsByEpisode(subs, 's1')).toEqual(new Map([[1, ['en', 'ja']], [2, ['fr']]]));
  });
});

describe('forPlaylist', () => {
  it('keeps the subtitles of a disc and playlist', () => {
    const a = sub('a', 'en', ep(1));
    const b = sub('b', 'en', ch(2, '00002'));
    const c = sub('c', 'en', ch(2, '00001', 'd.2'));
    expect(forPlaylist([a, b, c], 'd.1', '00001')).toEqual([a]);
  });
});

describe('startFor', () => {
  const chapters = [{ startUs: 0 }, { startUs: 90e6 }];
  it('starts an episode subtitle at 0', () => {
    expect(startFor(sub('a', 'en', ep(1)), chapters)).toBe(0);
  });
  it('starts a chapter subtitle at its chapter', () => {
    expect(startFor(sub('a', 'en', ch(1)), chapters)).toBe(90e6);
  });
  it('is null when the chapter is not there', () => {
    expect(startFor(sub('a', 'en', ch(2)), chapters)).toBeNull(); // the third of two
    expect(startFor(sub('a', 'en', ch(-1)), chapters)).toBeNull();
  });
});

describe('sameLanguage', () => {
  it('finds the first of a language, case-insensitively', () => {
    const a = sub('a', 'ja', ep(1));
    const b = sub('b', 'en', ep(1));
    expect(sameLanguage([a, b], 'EN')).toBe(b);
    expect(sameLanguage([a, b], 'fr')).toBeNull();
  });
});

describe('languageTag', () => {
  it('is the primary subtag, upper-case', () => {
    expect(['en', 'ja', 'zh-Hans', 'pt-BR'].map(languageTag)).toEqual(['EN', 'JA', 'ZH', 'PT']);
  });
});

describe('parseOffset', () => {
  it('takes seconds at one decimal, blank as none', () => {
    expect(parseOffset('0.4')).toBe(400);
    expect(parseOffset('-1.25')).toBe(-1200);
    expect(parseOffset(' ')).toBe(0);
    expect(parseOffset('600')).toBe(600_000);
  });
  it('refuses what is not a number or past ±600 s', () => {
    expect(parseOffset('abc')).toBeNull();
    expect(parseOffset('600.1')).toBeNull();
    expect(parseOffset('-601')).toBeNull();
  });
});

describe('formatOffset', () => {
  it('signs it, in seconds at one decimal, and says nothing for none', () => {
    expect(formatOffset(400)).toBe('+0.4 s');
    expect(formatOffset(-1500)).toBe('−1.5 s');
    expect(formatOffset(0)).toBeNull();
  });
});

describe('playlistChoices', () => {
  const S = 45_000;
  const video = [{ pid: 0x1011, codingType: CodingType.AVC, format: 6, rate: 1 }];
  const mpls = (seconds: number, marks: number[]): Uint8Array =>
    buildMpls({ playItems: [{ clipId: '00001', inTime: 0, outTime: seconds * S, video }], marks: marks.map((t) => ({ playItemRef: 0, time: t * S })) });
  const base64 = (bytes: Uint8Array): string => btoa(String.fromCharCode(...bytes));
  function manifest(playlists: Record<string, Uint8Array>): DiscManifest {
    const paths = Object.keys(playlists).map((id) => `BDMV/PLAYLIST/${id}.MPLS`);
    return {
      discId: 'x', name: 'x',
      files: [...paths, 'BDMV/CLIPINF/00001.CLPI', 'BDMV/STREAM/00001.M2TS'].map((path) => ({ path, size: 1 })),
      inline: Object.fromEntries(Object.entries(playlists).map(([id, bytes]) => [`BDMV/PLAYLIST/${id}.MPLS`, base64(bytes)])),
    };
  }

  it('offers playlists of a minute or more, the main title first, each with its chapters', () => {
    const m = manifest({ '00000': mpls(30, [0]), '00001': mpls(120, [0, 60]), '00002': mpls(600, [0, 200, 400]) });
    const choices = playlistChoices(m);
    expect(choices.map((c) => c.id)).toEqual(['00002', '00001']);
    expect(choices[0]!.durationUs).toBe(600_000_000);
    expect(choices[0]!.chapters.map((c) => c.startUs)).toEqual([0, 200_000_000, 400_000_000]);
    expect(choices[1]!.chapters).toHaveLength(2);
  });
  it('keeps the playlist an upload is attached to, however short', () => {
    const m = manifest({ '00000': mpls(30, [0]), '00002': mpls(600, [0]) });
    expect(playlistChoices(m, '00000').map((c) => c.id)).toEqual(['00002', '00000']);
  });
});

describe('forSeason', () => {
  it("keeps the season's episodes and the chapters of its discs", () => {
    const a = sub('a', 'en', ep(1, 's1'));
    const b = sub('b', 'en', ep(1, 's2'));
    const c = sub('c', 'en', ch(0, '00001', 'd.1'));
    const d = sub('d', 'en', ch(0, '00001', 'd.9'));
    expect(forSeason([a, b, c, d], 's1', new Set(['d.1']))).toEqual([a, c]);
  });
});

describe('uploadSubtitle', () => {
  const body: SubtitleCreate = { name: 'n', language: 'en', offsetMs: 400, for: { kind: 'episode', titleId: 't', seasonId: 's1', episode: 1 } };
  const stored = sub('s', 'en', ep(1));
  function writer(fail?: 'create' | 'file' | 'font'): { nas: SubtitleWriter; calls: string[] } {
    const calls: string[] = [];
    const nas: SubtitleWriter = {
      createSubtitle: async () => {
        calls.push('create');
        if (fail === 'create') throw new NasHttpError(400, 'not-found');
        return stored;
      },
      uploadSubtitleFile: async (id, f) => {
        calls.push(`file ${id} ${f.name}`);
        if (fail === 'file') throw new NasHttpError(413, 'too-large');
        return stored;
      },
      uploadSubtitleFont: async (id, f) => {
        calls.push(`font ${id} ${f.name}`);
        if (fail === 'font' && f.name === 'b.ttf') throw new TypeError('Failed to fetch');
        return stored;
      },
      deleteSubtitle: async (id) => {
        calls.push(`delete ${id}`);
      },
    };
    return { nas, calls };
  }
  const files = { subtitle: file('ep.ass', 10), fonts: [file('a.ttf', 20), file('b.ttf', 30)] };

  it('registers, then sends the file, then each font, telling the bytes sent', async () => {
    const { nas, calls } = writer();
    const progress: [number, number][] = [];
    await expect(uploadSubtitle(nas, body, files, (sent, total) => progress.push([sent, total]))).resolves.toBe(stored);
    expect(calls).toEqual(['create', 'file s ep.ass', 'font s a.ttf', 'font s b.ttf']);
    expect(progress).toEqual([[10, 60], [30, 60], [60, 60]]);
  });
  it('passes on the bytes of each file as they go, counted over the whole upload', async () => {
    const { nas } = writer();
    const progress: number[] = [];
    const going: SubtitleWriter = {
      ...nas,
      uploadSubtitleFile: async (id, f, onSent) => {
        onSent?.(4);
        onSent?.(2); // a retried request counts again from the start: never told as going back
        return nas.uploadSubtitleFile(id, f);
      },
      uploadSubtitleFont: async (id, f, onSent) => {
        onSent?.(f.size / 2);
        return nas.uploadSubtitleFont(id, f);
      },
    };
    await uploadSubtitle(going, body, files, (sent) => progress.push(sent));
    expect(progress).toEqual([4, 10, 20, 30, 45, 60]);
  });
  it('deletes the upload when its file is refused', async () => {
    const { nas, calls } = writer('file');
    await expect(uploadSubtitle(nas, body, files)).rejects.toMatchObject({ status: 413 });
    expect(calls).toEqual(['create', 'file s ep.ass', 'delete s']);
  });
  it('deletes the upload when a font fails, and throws that failure', async () => {
    const { nas, calls } = writer('font');
    await expect(uploadSubtitle(nas, body, files)).rejects.toThrow('Failed to fetch');
    expect(calls).toEqual(['create', 'file s ep.ass', 'font s a.ttf', 'font s b.ttf', 'delete s']);
  });
  it('deletes nothing when the registration is refused', async () => {
    const { nas, calls } = writer('create');
    await expect(uploadSubtitle(nas, body, files)).rejects.toMatchObject({ code: 'not-found' });
    expect(calls).toEqual(['create']);
  });
  it('throws the failure even when the delete fails too', async () => {
    const { nas, calls } = writer('file');
    nas.deleteSubtitle = async () => {
      calls.push('delete failed');
      throw new TypeError('offline');
    };
    await expect(uploadSubtitle(nas, body, files)).rejects.toMatchObject({ status: 413 });
    expect(calls.at(-1)).toBe('delete failed');
  });
});

describe('subtitleErrorMessage', () => {
  it("says what the NAS refused", () => {
    expect(subtitleErrorMessage(new NasHttpError(413, 'too-large'))).toBe('The NAS refused a file as too large (5 MB a subtitle file, 50 MB of fonts).');
    expect(subtitleErrorMessage(new NasHttpError(400, 'not-found'))).toBe("That episode or chapter isn't on the NAS any more.");
    expect(subtitleErrorMessage(new NasHttpError(400, 'bad-name'))).toBe('The NAS refused a file name. Rename the file and try again.');
    expect(subtitleErrorMessage(new NasHttpError(403, 'forbidden'))).toBe('Only owners can change subtitles on the NAS.');
    expect(subtitleErrorMessage(new Error('The NAS is unreachable.'))).toBe('The NAS is unreachable.');
  });
});

describe('subtitleTarget', () => {
  const copy = (discId: string, folder: string, displayName: string | null = null) => ({ discId, root: 'r', folder, displayName });
  const season: SeasonDetail = {
    id: 's1', label: 'Season 1', number: 1,
    discs: [{ number: 1, label: 'Disc 1', copies: [copy('a', 'X/Vol.1'), copy('b', 'Y/Vol.1 copy', 'Vol.1 (copy)')] }, { number: 2, label: 'Disc 2', copies: [copy('c', 'X/Vol.2')] }],
    episodes: [{ number: 1, name: null, runtimeMin: null, discId: 'a', playlistId: '00001' }],
    extras: [{ number: null, label: 'Bonus', copies: [copy('d', 'X/Bonus')] }],
  };
  it("labels each copy with its disc and name, and takes the season's episodes", () => {
    expect(subtitleTarget('t', [season], { episodes: true })).toEqual({
      titleId: 't',
      season: { id: 's1', episodes: season.episodes },
      discs: [
        { discId: 'a', label: 'Disc 1 · Episode 1 · Vol.1' },
        { discId: 'b', label: 'Disc 1 · Episode 1 · Vol.1 (copy)' },
        { discId: 'c', label: 'Disc 2 · Vol.2' },
        { discId: 'd', label: 'Bonus · Bonus' },
      ],
    });
  });
  it("takes no episodes on a movie's screen, and the title's own extras", () => {
    const movie: SeasonDetail = { id: 'm', label: '', number: null, discs: [{ number: null, label: '', copies: [copy('m1', 'Movies/Harbor')] }], episodes: null, extras: [] };
    const target = subtitleTarget('t', [movie], { episodes: false, extras: [{ number: null, label: 'Extras', copies: [copy('x', 'Movies/Harbor Extras')] }] });
    expect(target.season).toBeNull();
    expect(target.discs).toEqual([{ discId: 'm1', label: 'Harbor' }, { discId: 'x', label: 'Extras · Harbor Extras' }]);
  });
});

describe('ownerListing', () => {
  const off = (s: StoredSubtitle): StoredSubtitle => ({ ...s, attached: false });
  const a = sub('a', 'en', ep(1, 's1'));
  const b = off(sub('b', 'en', ep(1, 's-gone')));
  const c = sub('c', 'en', ch(0, '00001', 'd.1'));
  const d = off(sub('d', 'en', ch(0, '00001', 'd.gone')));
  const e = sub('e', 'en', ep(2, 's2'));
  const seasons = new Set(['s1', 's2']);
  it("lists a season's attached uploads, and every upload of the title that isn't attached", () => {
    expect(ownerListing([a, b, c, d, e], { id: 's1', discKeys: new Set(['d.1']) }, seasons)).toEqual({ attached: [a, c], notAttached: [b, d] });
    expect(ownerListing([a, b, c, d, e], { id: 's2', discKeys: new Set() }, seasons)).toEqual({ attached: [e], notAttached: [b, d] });
  });
  it("lists everything on a movie's screen, the unattached apart", () => {
    expect(ownerListing([c, d], null, new Set())).toEqual({ attached: [c], notAttached: [d] });
  });
  it("puts an episode upload whose season the title no longer has under Not attached, on each screen, marked so Edit re-attaches it", () => {
    // its disc and playlist still resolve (attached on the NAS), but a rescan gave the season another id
    const moved = sub('m', 'en', ep(3, 's-old'));
    expect(ownerListing([a, moved, e], { id: 's1', discKeys: new Set() }, seasons)).toEqual({ attached: [a], notAttached: [{ ...moved, attached: false }] });
    expect(ownerListing([a, moved, e], { id: 's2', discKeys: new Set() }, seasons)).toEqual({ attached: [e], notAttached: [{ ...moved, attached: false }] });
    expect(ownerListing([moved, c], null, seasons)).toEqual({ attached: [c], notAttached: [{ ...moved, attached: false }] });
  });
});

describe('offsetFrom', () => {
  it("refuses what the number field couldn't read, however it looks", () => {
    expect(offsetFrom('', true)).toBeNull();
    expect(offsetFrom('', false)).toBe(0);
    expect(offsetFrom('0.4', false)).toBe(400);
  });
});

describe('editPatch', () => {
  const fields = { name: 'n', language: 'en', offsetMs: 0 };
  const place = { kind: 'chapter', discId: 'x', playlistId: '00001', chapter: 0, titleId: 't' } as const;
  it('sends no place when it was not touched', () => {
    expect(editPatch(fields, place, { touched: false, attached: true })).toEqual(fields);
    expect(editPatch(fields, 'Choose a disc.', { touched: false, attached: true })).toEqual(fields);
  });
  it("renames an upload that isn't attached and whose place the form can't name", () => {
    expect(editPatch(fields, 'Choose a disc.', { touched: false, attached: false })).toEqual(fields);
  });
  it("re-attaches an upload that isn't attached to the place the form names", () => {
    expect(editPatch(fields, place, { touched: false, attached: false })).toEqual({ ...fields, for: place });
  });
  it('sends a changed place, which must be complete', () => {
    expect(editPatch(fields, place, { touched: true, attached: true })).toEqual({ ...fields, for: place });
    expect(editPatch(fields, 'Choose a chapter.', { touched: true, attached: true })).toEqual({ error: 'Choose a chapter.' });
  });
});
