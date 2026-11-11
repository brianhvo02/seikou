// SPDX-License-Identifier: LGPL-3.0-or-later
// Find the first element of a kind; it throws when there is none.
import { Id, concat, find, parseMkv, writeMatroska, type MkvSink } from '@seikou/matroska';

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

export default async function example(): Promise<void> {
  const tree = parseMkv(await tinyMkv());

  const info = find(tree, Id.Info);
  console.log('Info at byte', info.offset);
  try {
    find(tree, Id.Attachments); // this file attaches nothing
  } catch {
    return;
  }
  throw new Error('a missing element was found');
}
