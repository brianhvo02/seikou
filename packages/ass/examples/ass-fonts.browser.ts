// SPDX-License-Identifier: LGPL-3.0-or-later
// Match ASS font requests to font files and register the faces with the browser.
import { AssFonts, createFontFaceLoader, readFontFile } from '@seikou/ass';

export default async function example(): Promise<void> {
  const bytes = new Uint8Array(await (await fetch('/developers/_examples/fixtures/disc-bdj-menu/BDMV/AUXDATA/00000.otf')).arrayBuffer());
  const font = await readFontFile('00000.otf', bytes);

  // #region construct
  // The fallback face is the one a request nothing matches gets; the loader registers faces in the page's FontFaceSet.
  const fonts = new AssFonts(createFontFaceLoader(document.fonts), font);
  // #endregion

  // #region add
  const { unreadable } = await fonts.add([{ name: '00000.otf', bytes }]); // the files a script or the viewer supplied
  console.log('unreadable font files:', unreadable);
  // #endregion

  // #region resolve
  const regular = fonts.resolve({ family: 'Source Sans 3', bold: 400, italic: 0, vertical: false });
  console.log('draws as', regular.cssFamily, regular.fallback ? '(fallback)' : '(matched)');
  // #endregion

  // #region faceFor
  const forA = fonts.faceFor({ family: 'Source Sans 3', bold: 400, italic: 0, vertical: false }, 'A'.codePointAt(0)!); // the face that has this character
  // #endregion

  // #region missingFamilies
  fonts.resolve({ family: 'Starfall Sans', bold: 400, italic: 0, vertical: false }); // nothing supplied it
  console.log('missing:', fonts.missingFamilies());
  // #endregion

  // #region hasPending
  console.log('faces still to register:', fonts.hasPending()); // layout measured them with a fallback until ready() completes
  // #endregion

  // #region ready
  await fonts.ready(); // registers every face resolved so far
  console.log('faces still to register:', fonts.hasPending());
  // #endregion

  const pending = fonts.hasPending();

  // #region dispose
  fonts.dispose(); // unregisters them again
  // #endregion

  if (regular.fallback || forA.cssFamily !== regular.cssFamily || fonts.missingFamilies().join() !== 'Starfall Sans' || pending) {
    throw new Error('the font was not matched');
  }
}
