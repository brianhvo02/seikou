// SPDX-License-Identifier: LGPL-3.0-or-later
// Write a small Matroska file into memory through an MkvSink: a video track, a chapter and a tag.
import { concat, writeMatroska, type MkvSink } from '@seikou/matroska';

export default async function example(): Promise<void> {
  let bytes: Uint8Array = new Uint8Array(0);
  const sink: MkvSink = {
    async write(chunk) {
      bytes = concat([bytes, chunk]);
    },
    async writeAt(position, chunk) {
      bytes.set(chunk, position); // the Segment size and duration are filled in at the end
    },
    async close() {},
  };
  async function* video() {
    for (let index = 0; index < 3; index++) yield { index, data: new Uint8Array([index, 1, 2, 3]), keyframe: index === 0 };
  }

  const result = await writeMatroska(sink, {
    title: 'Tiny episode',
    tags: { EPISODE: '1' },
    video: { name: 'Video', language: 'und', isDefault: true, width: 640, height: 360, fpsNum: 30, fpsDen: 1, codecPrivate: new Uint8Array([0x81, 0, 0, 0]) },
    videoPackets: video(),
    audio: [],
    subtitles: [],
    attachments: [],
    chapters: [{ title: 'Opening', startNs: 0n }],
  });
  console.log(result.videoPackets, 'frames,', result.clusters, 'cluster,', result.durationNs, 'ns,', bytes.length, 'bytes');

  const magic = [0x1a, 0x45, 0xdf, 0xa3]; // every EBML file starts with this
  if (result.videoPackets !== 3 || result.durationNs !== 100_000_000n || !magic.every((b, i) => bytes[i] === b)) throw new Error('the file was not written');
}
