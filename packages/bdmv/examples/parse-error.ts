// SPDX-License-Identifier: LGPL-3.0-or-later
// Catch the ParseError a parser throws for bytes that are not the file they claim to be.
import { ParseError, parseMpls } from '@seikou/bdmv';

export default async function example(): Promise<void> {
  // #region construct
  let caught: unknown;
  try {
    parseMpls(new Uint8Array(40)); // no MPLS signature
  } catch (error) {
    if (error instanceof ParseError) caught = error;
    else throw error;
  }
  console.log(caught instanceof ParseError && caught.message);
  // #endregion
  if (!caught) throw new Error('parseMpls accepted garbage');
}
