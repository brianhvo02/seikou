// SPDX-License-Identifier: LGPL-3.0-or-later
// Catch the UdfError that reading something that is not a UDF image raises.
import { readUdf, UdfError } from '@seikou/bdmv';

export default async function example(): Promise<void> {
  // #region construct
  const zeros = async (_offset: number, length: number): Promise<Uint8Array> => new Uint8Array(length);
  let caught: unknown;
  try {
    await readUdf(zeros);
  } catch (error) {
    if (error instanceof UdfError) caught = error;
    else throw error;
  }
  console.log(caught instanceof UdfError && caught.message); // not a UDF image
  // #endregion
  if (!caught) throw new Error('an empty image was accepted');
}
