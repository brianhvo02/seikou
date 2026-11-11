// SPDX-License-Identifier: LGPL-3.0-or-later
// Catch the error a reader throws for a file cut short, and make one of your own.
import { MkvReadError, concat, readMatroska, writeMatroska, type MkvSink, type RangeReader } from '@seikou/matroska';

// A three-frame AV1 stand-in: the writer takes packets as they are and never decodes them.
async function tinyMkv(): Promise<Uint8Array> {
  let bytes: Uint8Array = new Uint8Array(0);
  const sink: MkvSink = {
    async write(chunk) {
      bytes = concat([bytes, chunk]);
    },
    async writeAt(position, chunk) {
      bytes.set(chunk, position);
    },
    async close() {},
  };
  async function* video() {
    for (let index = 0; index < 3; index++) yield { index, data: new Uint8Array([index, 1, 2, 3]), keyframe: index === 0 };
  }
  await writeMatroska(sink, {
    title: 'Tiny episode',
    tags: { EPISODE: '1' },
    video: { name: 'Video', language: 'und', isDefault: true, width: 640, height: 360, fpsNum: 30, fpsDen: 1, codecPrivate: new Uint8Array([0x81, 0, 0, 0]) },
    videoPackets: video(),
    audio: [],
    subtitles: [],
    attachments: [],
    chapters: [{ title: 'Opening', startNs: 0n }],
  });
  return bytes;
}

function readerOf(bytes: Uint8Array): RangeReader {
  return { size: bytes.length, read: async (offset, length) => bytes.subarray(offset, offset + length) };
}

export default async function example(): Promise<void> {
  const bytes = await tinyMkv();

  const mine = new MkvReadError('the file ends inside a cluster');
  console.log('thrown as', mine.constructor.name + ':', mine.message);

  try {
    await readMatroska(readerOf(bytes.subarray(0, bytes.length - 40))); // cut off the end
  } catch (error) {
    if (!(error instanceof MkvReadError)) throw error;
    console.log('a truncated file:', error.message);
    return;
  }
  throw new Error('a truncated file was read without an error');
}
