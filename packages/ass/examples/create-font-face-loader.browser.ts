// SPDX-License-Identifier: LGPL-3.0-or-later
// Register font bytes in the page's FontFaceSet under a private family, and remove them.
import { createFontFaceLoader } from '@seikou/ass';

export default async function example(): Promise<void> {
  const bytes = new Uint8Array(await (await fetch('/developers/_examples/fixtures/disc-bdj-menu/BDMV/AUXDATA/00000.otf')).arrayBuffer());
  const loader = createFontFaceLoader(document.fonts);
  await loader.load('example-face', bytes);
  const registered = document.fonts.check('16px "example-face"');
  loader.unload('example-face');
  console.log('registered:', registered, 'after unload:', document.fonts.check('16px "example-face"'));
  if (!registered) throw new Error('the font was not registered');
}
