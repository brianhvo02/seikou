// SPDX-License-Identifier: LGPL-3.0-or-later
// Open an ISO image once, find a file in it and read its bytes through the extents.
import { open } from 'node:fs/promises';
import { UdfImage } from '@seikou/bdmv';

export default async function example(): Promise<void> {
  const handle = await open(new URL('../../../fixtures/synthetic/disc1.iso', import.meta.url));
  try {
    const read = async (offset: number, length: number): Promise<Uint8Array> => {
      const buffer = new Uint8Array(length);
      const { bytesRead } = await handle.read(buffer, 0, length, offset);
      return buffer.subarray(0, bytesRead);
    };

    // #region open
    const image = await UdfImage.open(read);
    // #endregion

    // #region find
    const index = await image.find('bdmv/index.bdmv'); // any case
    if (index) {
      const first = index.extents[0]!;
      const head = await read(first.offset, 4);
      console.log(index.path, index.size, new TextDecoder().decode(head)); // BDMV/INDEX.BDMV 120 INDX
    }
    // #endregion

    // #region files
    const files = await image.files();
    console.log(files.length, 'files, the first is', files[0]?.path);
    // #endregion

    if (!index || files.length === 0) throw new Error('the image holds no index.bdmv');
  } finally {
    await handle.close();
  }
}
