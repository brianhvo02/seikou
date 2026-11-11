// SPDX-License-Identifier: LGPL-3.0-or-later
// Read a font file's faces: the family names, weight and style the renderer matches on.
import { readFile } from 'node:fs/promises';
import { readFontFile } from '@seikou/ass';

export default async function example(): Promise<void> {
  const bytes = new Uint8Array(await readFile(new URL('../../../fixtures/synthetic/disc-bdj-menu/BDMV/AUXDATA/00000.otf', import.meta.url)));
  const file = await readFontFile('00000.otf', bytes); // rejects with a FontFileError for bytes that are not a font
  const face = file.faces[0]!;
  console.log(face.families, 'weight', face.weight, face.italic ? 'italic' : 'upright');
  if (!face.families.includes('Source Sans 3') || !face.hasGlyph('A'.codePointAt(0)!)) throw new Error('the font was not read');
}
