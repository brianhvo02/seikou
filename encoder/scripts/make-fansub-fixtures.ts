// SPDX-License-Identifier: LGPL-3.0-or-later
/**
 * Regenerates the recorded SeaDex, Anime Tosho and AniList answers in encoder/tests/fixtures/fansubs/ (read by
 * `fixtureFansubSources` and `fixtureAniList`): `npx tsx encoder/scripts/make-fansub-fixtures.ts`, then commit the output.
 *
 * Everything is made up. Lantern Harbor is anilist:900101 with two episodes, the speech disc's `1-3,4-5` split:
 * episode 1 is 0-90 s of playlist 00000 and episode 2 is 90-150 s. GroupA's episode 1 Full track has one line per
 * speech burst inside 0-90 s, each 1200 ms earlier than the burst, so aligning it to the disc must find +1200 ms; its
 * episode 2 track has only six lines, too few to align. GroupB's episode 1 has the same timing in another style.
 * The third SeaDex release is a private-tracker one with no info hash, so Anime Tosho has nothing for it.
 * Lantern Harbor's poster is a 4x6 blue PNG in `covers/`, which `fixtureAniList` serves for the poster's URL.
 */
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import SevenZip from '7z-wasm';
import { SPEECH_BURSTS } from '../../tests/helpers/speech-bursts';

const here = new URL('../tests/fixtures/fansubs/', import.meta.url);
const root = new URL('../../', import.meta.url);
const wasm = readFileSync(new URL('node_modules/7z-wasm/7zz.wasm', root));
const FONT = 'DejaVuSansMono.ttf';
const font = readFileSync(new URL(`fixtures/ass/fonts/${FONT}`, root));

/** How much earlier the recorded lines are than the speech on the disc. */
const EARLY_MS = 1200;
const EPISODE_1_END_MS = 90_000;

const clock = (ms: number): string => {
  const cs = Math.round(Math.max(0, ms) / 10);
  const h = Math.floor(cs / 360_000);
  const m = Math.floor((cs % 360_000) / 6000);
  const s = Math.floor((cs % 6000) / 100);
  return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}.${String(cs % 100).padStart(2, '0')}`;
};

const LINES = [
  'The lamps are lit before the boats come in.',
  'Nobody told me the harbour was this quiet.',
  'Follow the light past the second breakwater.',
  'She keeps the tower, and the tower keeps her.',
  'The tide table was wrong again.',
  'We should have left before the fog.',
  'Bring the lantern, and bring the rope.',
  'Every ship here has a name for the wind.',
];

type Line = readonly [startMs: number, endMs: number, style: string, text: string];

/** One Dialogue line per burst, 1200 ms earlier than the burst, with `baseMs` taken off for a file that starts there in the playlist. */
const spoken = (bursts: typeof SPEECH_BURSTS, baseMs: number, style: string): Line[] =>
  bursts.map((b, i) => [b.fromMs - baseMs - EARLY_MS, b.toMs - baseMs - EARLY_MS, style, LINES[i % LINES.length]!]);

const first = SPEECH_BURSTS.filter((b) => b.toMs <= EPISODE_1_END_MS);
const second = SPEECH_BURSTS.filter((b) => b.fromMs >= EPISODE_1_END_MS).slice(0, 6);

const ass = (title: string, font: string, lines: readonly Line[]): string => `[Script Info]
Title: ${title}
ScriptType: v4.00+
PlayResX: 1920
PlayResY: 1080

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Default,${font},64,&H00FFFFFF,&H000000FF,&H00000000,&H00000000,0,0,0,0,100,100,0,0,1,3,0,2,10,10,40,1
Style: Alt,${font},56,&H0000FFFF,&H000000FF,&H00000000,&H00000000,0,1,0,0,100,100,0,0,1,2,1,2,10,10,40,1
Style: Signs,${font},48,&H00FFFFFF,&H000000FF,&H00000000,&H00000000,0,0,0,0,100,100,0,0,1,2,0,8,10,10,40,1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
${lines.map(([start, end, style, text]) => `Dialogue: 0,${clock(start)},${clock(end)},${style},,0,0,0,,${text}`).join('\n')}
`;

const SIGNS: Line[] = [
  [2000, 6000, 'Signs', '{\\an8}Harbor Road'],
  [30_000, 34_000, 'Signs', '{\\an8}Lighthouse Keeper'],
];

const FONT_NAME = 'DejaVu Sans Mono';
const TRACKS: Record<string, string> = {
  '7101-0.ass': ass('Lantern Harbor 01 (GroupA Full)', FONT_NAME, spoken(first, 0, 'Default')),
  '7101-1.ass': ass('Lantern Harbor 01 (GroupA Signs)', FONT_NAME, SIGNS),
  '7102-0.ass': ass('Lantern Harbor 02 (GroupA Full)', FONT_NAME, spoken(second, EPISODE_1_END_MS, 'Default')),
  '7201-0.ass': ass('Lantern Harbor 01 (GroupB Full)', FONT_NAME, spoken(first, 0, 'Alt')),
};

const HASH_A = 'a'.repeat(40);
const HASH_B = 'b'.repeat(40);
const track = (fileId: number, n: number, language: string, name: string) => ({
  track: n, language, name, format: 'ASS', url: `https://storage.animetosho.net/attach/0/${fileId}-${n}.ass.xz`, isDefault: n === 0, forced: false,
});

const seadex = {
  900101: {
    alId: 900101,
    incomplete: false,
    notes: 'GroupA for video and full subs; GroupB has the better signs.',
    comparison: '',
    releases: [
      { tracker: 'Nyaa', infoHash: HASH_A, isBest: true, dualAudio: false, group: 'GroupA', tags: [], files: [
        { name: '[GroupA] Lantern Harbor - 01 (BD 1080p).mkv', length: 1000 },
        { name: '[GroupA] Lantern Harbor - 02 (BD 1080p).mkv', length: 1000 },
      ] },
      { tracker: 'Nyaa', infoHash: HASH_B, isBest: false, dualAudio: false, group: 'GroupB', tags: [], files: [
        { name: '[GroupB] Lantern Harbor - 01 (BD 1080p).mkv', length: 1000 },
      ] },
      { tracker: 'PrivateTracker', infoHash: null, isBest: false, dualAudio: true, group: 'GroupC', tags: [], files: [
        { name: '[GroupC] Lantern Harbor - 01 (BD 1080p).mkv', length: 1000 },
      ] },
    ],
  },
};

const tosho = {
  releases: [
    {
      id: 7001, title: '[GroupA] Lantern Harbor (BD 1080p)', infoHash: HASH_A, status: 'complete', isSeadex: true, date: 1_700_000_000,
      files: [
        { id: 7101, name: '[GroupA] Lantern Harbor - 01 (BD 1080p).mkv', size: 1000, tracks: [track(7101, 0, 'eng', 'Full'), track(7101, 1, 'eng', 'Signs')] },
        { id: 7102, name: '[GroupA] Lantern Harbor - 02 (BD 1080p).mkv', size: 1000, tracks: [track(7102, 0, 'eng', 'Full')] },
      ],
    },
    {
      id: 7002, title: '[GroupB] Lantern Harbor (BD 1080p)', infoHash: HASH_B, status: 'complete', isSeadex: true, date: 1_600_000_000,
      files: [{ id: 7201, name: '[GroupB] Lantern Harbor - 01 (BD 1080p).mkv', size: 1000, tracks: [track(7201, 0, 'eng', 'Full')] }],
    },
  ],
};

/** A 4x6 solid blue PNG: the recorded poster, served offline from `covers/` by its URL's file name. */
const COVER = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAQAAAAGCAIAAABrW6giAAAAEElEQVR42mPQiDoBRwyUcgCoGh7xLGHZ+gAAAABJRU5ErkJggg==', 'base64');
const COVER_URL = 'https://s4.anilist.co/file/anilistcdn/media/anime/cover/large/bx900101-lantern.png';

const anilist = {
  entries: [
    {
      source: 'anilist', id: 'anilist:900101', kind: 'series', format: 'TV',
      names: { english: 'Lantern Harbor', romaji: 'Tomoshibi no Minato', native: '灯の港', synonyms: [] },
      animation: true, year: 2024, startDate: 20240105, episodes: 2, runtimeMin: 24,
      seasons: [], relations: [], poster: { small: COVER_URL, large: COVER_URL }, banner: null,
    },
  ],
  episodes: { 900101: { 1: 'Arrival', 2: 'The Lighthouse' } },
};

async function archive(name: string, files: Record<string, Uint8Array>, args: string[]): Promise<Uint8Array> {
  const sz = await SevenZip({ wasmBinary: wasm.buffer.slice(wasm.byteOffset, wasm.byteOffset + wasm.byteLength) as ArrayBuffer, print: () => {}, printErr: () => {}, stdout: () => {} });
  for (const [n, d] of Object.entries(files)) sz.FS.writeFile(n, d);
  sz.callMain(['a', ...args, name, ...Object.keys(files)]);
  return sz.FS.readFile(name);
}

const out = new URL('files/', here);
rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });
for (const [name, data] of Object.entries({ seadex, tosho, anilist })) writeFileSync(new URL(`${name}.json`, here), `${JSON.stringify(data, null, 2)}\n`);
for (const [name, text] of Object.entries(TRACKS)) writeFileSync(new URL(`${name}.xz`, out), await archive(`${name}.xz`, { [name]: Buffer.from(text) }, ['-txz']));
writeFileSync(new URL('pack-7101.7z', out), await archive('pack.7z', { [FONT]: font }, ['-t7z']));
const covers = new URL('covers/', here);
rmSync(covers, { recursive: true, force: true });
mkdirSync(covers, { recursive: true });
writeFileSync(new URL(new URL(COVER_URL).pathname.split('/').pop()!, covers), COVER);
