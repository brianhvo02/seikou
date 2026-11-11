// SPDX-License-Identifier: LGPL-3.0-or-later
// List the files of an ISO image by path and size.
import { open } from 'node:fs/promises';
import { readUdf } from '@seikou/bdmv';

export default async function example(): Promise<void> {
  const file = await open(new URL('../../../fixtures/synthetic/disc1.iso', import.meta.url));
  try {
    // #region read
    const read = async (offset: number, length: number): Promise<Uint8Array> => {
      const buffer = new Uint8Array(length);
      const { bytesRead } = await file.read(buffer, 0, length, offset);
      return buffer.subarray(0, bytesRead); // a short read means the image ends there
    };
    const files = await readUdf(read);
    for (const f of files) console.log(f.path, f.size);
    // #endregion
    if (!files.some((f) => f.path === 'BDMV/INDEX.BDMV')) throw new Error('index.bdmv is not in the image');
  } finally {
    await file.close();
  }
}
