/// <reference types="node" />
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { loadFreeType, type FreeType } from '../../src/engine/bdj/fonts/freetype';
import type { BdjFontSources } from '../../src/engine/bdj/runtime';

const read = (rel: string): Uint8Array => new Uint8Array(readFileSync(fileURLToPath(new URL(rel, import.meta.url))));

let freeType: Promise<FreeType> | null = null;

/** BD-J text as the BD-J worker entry gives it: freetype.wasm and the bundled fallback font, read from the repo. */
export const testBdjFonts: BdjFontSources = {
  loadFreeType: () => (freeType ??= loadFreeType(read('../../src/wasm/freetype/freetype.wasm'))),
  loadDefaultFont: () => Promise.resolve(read('../../packages/ass/src/default-font.ttf')),
};
