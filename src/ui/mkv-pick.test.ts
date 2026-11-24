import { describe, expect, it } from 'vitest';
import type { MkvTextExtract, MkvTextTrack } from '@seikou/engine/subs/mkv-extract';
import { expandMkvPicks, markCurrentTrack, MkvPickCache } from './mkv-pick';

const track = (number: number, over: Partial<MkvTextTrack> = {}): MkvTextTrack => ({
  number, kind: 'ass', name: null, language: null, isDefault: false, isForced: false, dialogueLines: 1, text: `text ${number}`, ...over,
});
const extractOf = (tracks: MkvTextTrack[], fonts: MkvTextExtract['fonts'] = []): MkvTextExtract => ({ tracks, fonts, via: 'cues' });
const mkv = (name = 'Show 01.mkv'): File => new File(['x'], name);

describe('expandMkvPicks', () => {
  it('picks the default track, else the subtitle language, else the first', async () => {
    const tracks = [track(2, { language: 'eng' }), track(3, { language: 'jpn' }), track(4, { language: 'fre', isDefault: true })];
    const run = async (prefs: string | null, ts: MkvTextTrack[]) => {
      const out = await expandMkvPicks([mkv()], { subtitleLanguage: prefs }, async () => extractOf(ts));
      return out.files.map((f) => f.name);
    };
    expect((await run('jpn', tracks))[0]).toContain('[4]');
    const noDefault = tracks.map((t) => ({ ...t, isDefault: false }));
    expect((await run('jpn', noDefault))[0]).toContain('[3]');
    expect((await run(null, noDefault))[0]).toContain('[2]');
    expect((await run('ger', noDefault))[0]).toContain('[2]');
  });

  it("turns the MKV's fonts into font files the pick carries", async () => {
    const out = await expandMkvPicks([mkv(), new File(['y'], 'other.srt')], { subtitleLanguage: null }, async () =>
      extractOf([track(2), track(3)], [{ name: 'Face.ttf', data: new Uint8Array([1, 2, 3]) }]));
    expect(out.files.map((f) => f.name)).toEqual([expect.stringMatching(/\[2\]\.ass$/), 'Face.ttf', 'other.srt']);
    expect(out.files[1]!.size).toBe(3);
    expect(out.tracks.map((t) => [t.track.number, t.current])).toEqual([[2, true], [3, false]]);
    expect(out.tracks[1]).toMatchObject({ source: 'Show 01.mkv' });
  });

  it('an MKV without text tracks adds nothing and says so', async () => {
    const out = await expandMkvPicks([mkv('Plain.mkv')], { subtitleLanguage: null }, async () => extractOf([]));
    expect(out.files).toEqual([]);
    expect(out.tracks).toEqual([]);
    expect(out.notices.join(' ')).toContain('Plain.mkv');
  });

  it('leaves files that are not MKVs alone and reads nothing for them', async () => {
    let reads = 0;
    const out = await expandMkvPicks([new File(['y'], 'a.srt')], { subtitleLanguage: null }, async () => (reads++, extractOf([])));
    expect(reads).toBe(0);
    expect(out.files.map((f) => f.name)).toEqual(['a.srt']);
  });
});

describe('MkvPickCache', () => {
  it('reads an MKV once and rebuilds a track pick from it', async () => {
    let reads = 0;
    const cache = new MkvPickCache(async () => (reads++, extractOf([track(2), track(3)], [{ name: 'F.otf', data: new Uint8Array(1) }])));
    const file = mkv();
    await expandMkvPicks([file], { subtitleLanguage: null }, cache.extract);
    await expandMkvPicks([file], { subtitleLanguage: null }, cache.extract);
    expect(reads).toBe(1);
    const files = cache.filesFor(file.name, 3)!;
    expect(files.map((f) => f.name)).toEqual([expect.stringMatching(/\[3\]\.ass$/), 'F.otf']);
    expect(cache.filesFor('nope.mkv', 3)).toBeNull();
    cache.clear();
    expect(cache.filesFor(file.name, 3)).toBeNull();
  });
});

describe('switching tracks', () => {
  it('pick (track 2 loaded), switch to 3: 2 is offered again and 3 is current', async () => {
    const out = await expandMkvPicks([mkv()], { subtitleLanguage: null }, async () => extractOf([track(2), track(3)]));
    const after = markCurrentTrack(out.tracks, 'Show 01.mkv', 3);
    expect(after.map((t) => [t.track.number, t.current])).toEqual([[2, false], [3, true]]);
  });

  it('a read that ends after clear() is not kept', async () => {
    let finish!: (e: MkvTextExtract) => void;
    const cache = new MkvPickCache(() => new Promise((r) => (finish = r)));
    const reading = cache.extract(mkv());
    cache.clear();
    finish(extractOf([track(2)]));
    await reading;
    expect(cache.filesFor('Show 01.mkv', 2)).toBeNull();
  });
});
