// SPDX-License-Identifier: LGPL-3.0-or-later
import { UdfError, UdfImage } from '@seikou/bdmv/udf';
import type { UdfFile } from '@seikou/bdmv/udf';
import type { DiscEntries } from './disc-input';

/** The largest run of unrecorded bytes (read as zeros) a disc file may have; a real disc's files have none this size. */
export const MAX_ZERO_RUN_BYTES = 64 * 1024 * 1024;

/** Why an image can't be opened as a disc, in the words the landing screen shows. */
export class IsoError extends Error {}

/** Whether `file` looks like a disc image by its name (`.iso`, any case). */
export function isIsoFile(file: { readonly name: string }): boolean {
  return /\.iso$/i.test(file.name);
}

/**
 * The files of a Blu-ray image as `[path, file]` pairs, the paths under a folder named after the image (`Name/BDMV/…`),
 * so they open as a picked folder does. Each file is a Blob made of slices of the image, so nothing is copied or read
 * beyond the UDF descriptors and directories. Throws IsoError when the image isn't UDF, has no `BDMV/INDEX.BDMV`, or
 * has a file that runs past its end; a read error of the image propagates as it is.
 */
export async function entriesFromIso(image: Blob & { readonly name: string }): Promise<DiscEntries> {
  const read = async (offset: number, length: number): Promise<Uint8Array> =>
    new Uint8Array(await image.slice(offset, Math.min(image.size, offset + length)).arrayBuffer());
  let files: UdfFile[];
  try {
    const udf = await UdfImage.open(read);
    if (!(await udf.find('BDMV/INDEX.BDMV'))) throw new IsoError(`"${image.name}" is not a Blu-ray image: it has no BDMV folder.`);
    files = await udf.files();
  } catch (err) {
    if (err instanceof UdfError) throw new IsoError(`"${image.name}" can't be read as a Blu-ray image (${err.message}).`);
    throw err;
  }
  const folder = image.name.replace(/\.iso$/i, '') || 'Disc';
  return files.map((f) => [`${folder}/${f.path}`, fileOf(image, f)]);
}

/** One file of the image as a File of slices (and zero runs for unrecorded pieces). */
function fileOf(image: Blob & { readonly name: string }, file: UdfFile): File {
  const parts: BlobPart[] = [];
  for (const extent of file.extents) {
    if (extent.offset >= 0) {
      if (extent.offset + extent.length > image.size) throw new IsoError(`"${image.name}" is cut short: ${file.path} runs past its end.`);
      parts.push(image.slice(extent.offset, extent.offset + extent.length));
    } else {
      if (extent.length > MAX_ZERO_RUN_BYTES) throw new IsoError(`"${image.name}" has a file this player can't read: ${file.path}.`);
      parts.push(new Uint8Array(extent.length));
    }
  }
  return new File(parts, file.path.slice(file.path.lastIndexOf('/') + 1));
}
