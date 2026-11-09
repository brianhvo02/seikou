// SPDX-License-Identifier: LGPL-3.0-or-later
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { AssFonts, AssRenderer, readFontFile } from '@seikou/ass';
import { createFixedMeasurer } from '@seikou/ass/measure';
import { blobRangeReader, openMatroska, type MatroskaFile, type MkvBlock } from '@seikou/matroska';
import { MEMORY_PROFILES } from '../memory-profile';
import { MkvAssTrack, PgsControl, encodeSubtitleTracks, fontAttachments, resolveMkvAssFonts, shownSubtitle } from './mkv-subtitles';

const FIXTURE = readFileSync(new URL('../../../../fixtures/encodes/990001/1.mkv', import.meta.url));

async function fixture(): Promise<{ file: MatroskaFile; blocks: MkvBlock[] }> {
  const file = await openMatroska(blobRangeReader(new Blob([FIXTURE])));
  const blocks: MkvBlock[] = [];
  for await (const b of file.blocksFrom(0)) if (b.track >= 3) blocks.push({ ...b, data: new Uint8Array(b.data) });
  return { file, blocks };
}

const fakeCtx = (): OffscreenCanvasRenderingContext2D =>
  ({ save: () => undefined, restore: () => undefined, translate: () => undefined, drawImage: () => undefined }) as unknown as OffscreenCanvasRenderingContext2D;

describe('the MKV ASS track', () => {
  it('the ASS track renders its first Dialogue at its time with the attached font', async () => {
    const { file, blocks } = await fixture();
    const [assTrack] = encodeSubtitleTracks(file);
    expect(assTrack).toMatchObject({ kind: 'ass', track: { number: 3, name: 'English', language: 'eng' } });
    const ass = new MkvAssTrack(assTrack!.track.codecPrivate!);
    for (const b of blocks.filter((x) => x.track === 3)) ass.add(b);
    expect(ass.track.events.map((e) => [e.readOrder, e.start, e.duration, e.text])).toEqual([
      [0, 1000, 2000, 'Episode 1 begins'],
      [1, 12_000, 2000, 'The opening line'],
      [2, 19_000, 4000, 'A line across the twenty second mark'],
      [3, 41_000, 3000, 'The ending line'],
      [4, 55_000, 3000, 'Next time'],
    ]);
    expect(ass.track.styles[ass.track.events[0]!.style]!.fontName).toBe('DejaVu Sans Mono');

    // the font comes from the MKV's attachment: without it the family would be missing
    const attached = fontAttachments(file.attachments);
    expect(attached.map((a) => a.name)).toEqual(['DejaVuSansMono.ttf']);
    const defaultFont = await readFontFile('DejaVuSans.ttf', new Uint8Array(readFileSync('fixtures/ass/fonts/DejaVuSans.ttf')));
    const fonts = new AssFonts({ load: async () => undefined, unload: () => undefined }, defaultFont);
    await fonts.add(await Promise.all(attached.map(async (a) => ({ name: a.name, bytes: await a.data() }))));
    resolveMkvAssFonts(fonts, ass.track);
    await fonts.ready();
    expect(fonts.missingFamilies()).toEqual([]);

    const drawnTexts: string[] = [];
    const renderer = new AssRenderer(ass.track, fonts, {
      measurer: createFixedMeasurer(0.5),
      createCanvas: () => ({}) as OffscreenCanvas,
      nowMs: () => 0,
      Path2D: class {} as unknown as typeof Path2D,
      colorMatrix: 'video',
      limits: MEMORY_PROFILES.desktop,
      canvasFilter: true,
      renderEvent: (_rc, ev) => {
        drawnTexts.push(ass.track.events[ev.index]!.text);
        return null;
      },
    });
    ass.attach(renderer);
    const opts = { offsetUs: 0, scale: 1 };
    const rect = { x: 0, y: 0, width: 1920, height: 1080 };
    expect(ass.visible(500_000, opts)).toBe(false);
    expect(ass.visible(1_500_000, opts)).toBe(true);
    expect(ass.visible(3_000_000, opts)).toBe(false);
    expect(ass.render(fakeCtx(), 1_500_000, rect, opts)).toBe(1);
    expect(drawnTexts).toEqual(['Episode 1 begins']);
  });

  it('adds each event once, whenever its block comes again, and an added event shows', async () => {
    const { file, blocks } = await fixture();
    const ass = new MkvAssTrack(encodeSubtitleTracks(file)[0]!.track.codecPrivate!);
    const first = blocks.filter((x) => x.track === 3)[2]!;
    expect(ass.add(first)).toBe(true);
    expect(ass.add(first)).toBe(false); // read again after a seek
    expect(ass.track.events).toHaveLength(1);
    expect(ass.add({ ...first, data: new TextEncoder().encode('9,0,NoSuchStyle,,0,0,0,,x'), timeMs: 30_000, durationMs: 1000 })).toBe(true);
    expect(ass.track.events[1]).toMatchObject({ readOrder: 9, start: 30_000, duration: 1000, text: 'x' });
    expect(ass.add({ ...first, data: new TextEncoder().encode('not a block') })).toBe(false);
  });
});

describe('the MKV PGS track', () => {
  it('a PGS display set shows at its time', async () => {
    const { blocks } = await fixture();
    const pgs = new PgsControl();
    for (const b of blocks.filter((x) => x.track === 4)) pgs.push(b.data, b.timeMs * 1000);
    expect(pgs.queued).toBe(6);
    pgs.tick(4_999_000);
    expect(pgs.shown).toBeNull();
    expect(pgs.plane.hasContent).toBe(false);
    pgs.tick(5_000_000);
    expect(pgs.shown).toEqual({ objectsShown: 1, forced: 0 });
    expect(pgs.plane.hasContent).toBe(true);
    pgs.tick(7_000_000); // the clear set
    expect(pgs.shown).toEqual({ objectsShown: 0, forced: 0 });
    expect(pgs.plane.hasContent).toBe(false);
    pgs.seek();
    expect(pgs.queued).toBe(0);
    expect(pgs.errors).toBe(0);
  });
});

describe('which MKV subtitle shows', () => {
  const t = (language: string, flags: { isDefault?: boolean; isForced?: boolean } = {}) => ({ language, isDefault: flags.isDefault ?? false, isForced: flags.isForced ?? false });
  it('shows the choice, else a forced track in the audio language, else nothing', () => {
    const tracks = [t('eng', { isDefault: true }), t('jpn', { isForced: true }), t('eng', { isForced: true })];
    expect(shownSubtitle(tracks, 1, 'jpn')).toBe(1);
    expect(shownSubtitle(tracks, 0, 'jpn')).toBe(2);
    expect(shownSubtitle(tracks, 0, 'eng')).toBe(3);
    expect(shownSubtitle(tracks, 0, 'fre')).toBe(0);
    expect(shownSubtitle(tracks, 0, null)).toBe(0);
  });
});
