// SPDX-License-Identifier: LGPL-3.0-or-later
// Open a file for playback: tags, chapters and the blocks from a time on.
import { concat, openMatroska, writeMatroska, type MkvSink, type RangeReader } from '@seikou/matroska';

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

  const file = await openMatroska(readerOf(bytes));
  const blocks = [];
  for await (const block of file.blocksFrom(0)) blocks.push(block);
  console.log(file.durationMs, 'ms,', file.tags, file.chapters, blocks.length, 'blocks');

  if (file.tags.EPISODE !== '1' || file.chapters[0]!.name !== 'Opening' || blocks.length !== 3) throw new Error('the file did not open as written');
}
