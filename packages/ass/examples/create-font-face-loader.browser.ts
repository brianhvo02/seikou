// SPDX-License-Identifier: LGPL-3.0-or-later
// Register font bytes in the page's FontFaceSet under a private family, and remove them.
import { createFontFaceLoader } from '@seikou/ass';

const faceCount = (family: string): number => [...document.fonts].filter((f) => f.family.replace(/^["']|["']$/g, '') === family).length;

export default async function example(): Promise<void> {
  const bytes = new Uint8Array(await (await fetch('/developers/_examples/fixtures/disc-bdj-menu/BDMV/AUXDATA/00000.otf')).arrayBuffer());
  const loader = createFontFaceLoader(document.fonts);
  await loader.load('example-face', bytes); // a FontFace under this family joins document.fonts
  const afterLoad = faceCount('example-face');
  loader.unload('example-face'); // and leaves it
  console.log('faces after load:', afterLoad, 'after unload:', faceCount('example-face'));
  if (afterLoad !== 1 || faceCount('example-face') !== 0) throw new Error('the font was not registered and removed');
}
