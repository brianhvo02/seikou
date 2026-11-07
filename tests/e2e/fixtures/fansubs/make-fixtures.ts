/**
 * Regenerates the NAS E2E stand-in's recorded SeaDex and Anime Tosho answers (`FANSUB_FIXTURE`, read by
 * packages/fansubs/src/fixture-sources.ts): `npx tsx tests/e2e/fixtures/fansubs/make-fixtures.ts`. Everything is made up:
 * Starfall Wanderer is anilist:900001 in nas-metadata.json, its one episode disc1's 4-second playlist 00001, so the
 * tracks' lines fall inside those 4 seconds. GroupA's release is SeaDex's best and has a font pack; GroupB's is its WEB
 * release, with a Spanish track too and no fonts.
 */
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import SevenZip from '7z-wasm';

const here = new URL('./', import.meta.url);
const wasm = readFileSync(new URL('../../../../node_modules/7z-wasm/7zz.wasm', import.meta.url));
const FONT = 'DejaVuSansMono.ttf';
const font = readFileSync(new URL(`../../../../fixtures/ass/fonts/${FONT}`, import.meta.url));

const ass = (title: string, lines: readonly [string, string, string, string][]): string => `[Script Info]
Title: ${title}
ScriptType: v4.00+
PlayResX: 1920
PlayResY: 1080

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Default,DejaVu Sans Mono,64,&H00FFFFFF,&H000000FF,&H00000000,&H00000000,0,0,0,0,100,100,0,0,1,3,0,2,10,10,40,1
Style: Signs,DejaVu Sans Mono,48,&H00FFFFFF,&H000000FF,&H00000000,&H00000000,0,0,0,0,100,100,0,0,1,2,0,8,10,10,40,1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
${lines.map(([start, end, style, text]) => `Dialogue: 0,${start},${end},${style},,0,0,0,,${text}`).join('\n')}
`;

const TRACKS: Record<string, string> = {
  '7101-0.ass': ass('Starfall Wanderer 01 (GroupA Full)', [
    ['0:00:00.20', '0:00:01.90', 'Default', 'The stars fell on the first night.'],
    ['0:00:02.00', '0:00:03.80', 'Default', 'We followed them to the sea.'],
  ]),
  '7101-1.ass': ass('Starfall Wanderer 01 (GroupA Signs)', [['0:00:00.20', '0:00:03.80', 'Signs', 'Harbor Road']]),
  '7201-0.ass': ass('Starfall Wanderer 01 (GroupB Full)', [
    ['0:00:00.20', '0:00:01.90', 'Default', 'Stars fell on the first night.'],
    ['0:00:02.00', '0:00:03.80', 'Default', 'We went after them, to the sea.'],
  ]),
  '7201-1.ass': ass('Starfall Wanderer 01 (GroupB Spanish)', [
    ['0:00:00.20', '0:00:01.90', 'Default', 'Las estrellas cayeron la primera noche.'],
    ['0:00:02.00', '0:00:03.80', 'Default', 'Las seguimos hasta el mar.'],
  ]),
};

const HASH_A = 'c'.repeat(40);
const HASH_B = 'e'.repeat(40);
const track = (fileId: number, n: number, language: string, name: string) => ({
  track: n, language, name, format: 'ASS', url: `https://storage.animetosho.net/attach/0/${fileId}-${n}.ass.xz`, isDefault: n === 0, forced: false,
});

const seadex = {
  900001: {
    alId: 900001, incomplete: false,
    releases: [
      { tracker: 'Nyaa', infoHash: HASH_A, isBest: true, dualAudio: false, group: 'GroupA', tags: [], files: [{ name: '[GroupA] Starfall Wanderer - 01 (BD 1080p).mkv', length: 1000 }] },
      { tracker: 'Nyaa', infoHash: HASH_B, isBest: false, dualAudio: false, group: 'GroupB', tags: ['WEB'], files: [{ name: '[GroupB] Starfall Wanderer - 01 (WEB 1080p).mkv', length: 1000 }] },
    ],
  },
};
const tosho = {
  releases: [
    {
      id: 7001, title: '[GroupA] Starfall Wanderer (BD 1080p)', infoHash: HASH_A, status: 'complete', isSeadex: true, date: 1_700_000_000,
      files: [{ id: 7101, name: '[GroupA] Starfall Wanderer - 01 (BD 1080p).mkv', size: 1000, tracks: [track(7101, 0, 'eng', 'Full'), track(7101, 1, 'eng', 'Signs')] }],
    },
    {
      id: 7002, title: '[GroupB] Starfall Wanderer (WEB 1080p)', infoHash: HASH_B, status: 'complete', isSeadex: true, date: 1_600_000_000,
      files: [{ id: 7201, name: '[GroupB] Starfall Wanderer - 01 (WEB 1080p).mkv', size: 1000, tracks: [track(7201, 0, 'eng', 'Full'), track(7201, 1, 'spa', 'Completo')] }],
    },
  ],
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
writeFileSync(new URL('seadex.json', here), `${JSON.stringify(seadex, null, 2)}\n`);
writeFileSync(new URL('tosho.json', here), `${JSON.stringify(tosho, null, 2)}\n`);
for (const [name, text] of Object.entries(TRACKS)) writeFileSync(new URL(`${name}.xz`, out), await archive(`${name}.xz`, { [name]: Buffer.from(text) }, ['-txz']));
writeFileSync(new URL('pack-7101.7z', out), await archive('pack.7z', { [FONT]: font }, ['-t7z']));
