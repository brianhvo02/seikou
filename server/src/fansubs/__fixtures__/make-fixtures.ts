/** Regenerates track.ass.xz and pack.7z with 7z-wasm (`npx tsx server/src/fansubs/__fixtures__/make-fixtures.ts`). */
import { readFileSync, writeFileSync } from 'node:fs';
import SevenZip from '7z-wasm';

const here = new URL('./', import.meta.url);
const wasmBinary = readFileSync(new URL('../../../../node_modules/7z-wasm/7zz.wasm', import.meta.url));

const ASS = `[Script Info]
Title: Starfall Wanderer 01
ScriptType: v4.00+

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Default,Default,48,&H00FFFFFF,&H000000FF,&H00000000,&H00000000,0,0,0,0,100,100,0,0,1,2,0,2,10,10,10,1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
Dialogue: 0,0:00:01.00,0:00:03.00,Default,,0,0,0,,The stars fell on the first night.
`;

async function make(name: string, files: Record<string, Uint8Array>, args: string[]): Promise<void> {
  const sz = await SevenZip({ wasmBinary: wasmBinary.buffer.slice(wasmBinary.byteOffset, wasmBinary.byteOffset + wasmBinary.byteLength) as ArrayBuffer });
  for (const [n, d] of Object.entries(files)) sz.FS.writeFile(n, d);
  sz.callMain(['a', ...args, name, ...Object.keys(files)]);
  writeFileSync(new URL(name, here), sz.FS.readFile(name));
}

await make('track.ass.xz', { 'track.ass': Buffer.from(ASS) }, ['-txz']);
await make('pack.7z', {
  'track.ass': Buffer.from(ASS),
  'Default.ttf': readFileSync(new URL('../../../../packages/ass/src/default-font.ttf', import.meta.url)),
}, ['-t7z']);
