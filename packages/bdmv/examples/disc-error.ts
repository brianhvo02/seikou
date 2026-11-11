// SPDX-License-Identifier: LGPL-3.0-or-later
// Raise a DiscError with a code and the files it concerns, and read them back.
import { DiscError } from '@seikou/bdmv';

export default async function example(): Promise<void> {
  // #region construct
  const error = new DiscError('missing-file', 'The playlist needs a clip the disc lacks.', ['BDMV/STREAM/00003.m2ts']);
  console.log(error.code, error.paths);
  // #endregion
  if (!(error instanceof Error) || error.code !== 'missing-file') throw new Error('unexpected error');
}
