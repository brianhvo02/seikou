// SPDX-License-Identifier: LGPL-3.0-or-later
// Read a file front to back: its tracks, chapters and every block.
import { concat, readMatroska, writeMatroska, type MkvSink, type RangeReader } from '@seikou/matroska';

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

  const file = await readMatroska(readerOf(bytes));
  const blocks = [];
  for await (const block of file.blocks()) blocks.push(block);
  console.log(file.docType, file.title, file.tracks[0]!.codecId, blocks.map((b) => b.timeMs));

  if (file.title !== 'Tiny episode' || file.tracks[0]!.codecId !== 'V_AV1' || file.chapters[0]!.title !== 'Opening') throw new Error('the description is wrong');
  if (blocks.length !== 3 || blocks[1]!.timeMs !== 33 || !blocks[0]!.keyframe) throw new Error('the blocks are wrong');
}
