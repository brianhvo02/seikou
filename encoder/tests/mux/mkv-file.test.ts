// SPDX-License-Identifier: LGPL-3.0-or-later
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { find, parseMkv, stringOf } from '@seikou/matroska';
import { Id, type MkvInput } from '@seikou/matroska';
import { readMkv, writeMkv } from '../../src/mux/mkv-file';
import { nodeRangeReader } from '../../src/mux/node-io';

async function* of<T>(items: T[]): AsyncGenerator<T> {
  for (const i of items) yield i;
}

function input(over: Partial<MkvInput> = {}): MkvInput {
  return {
    video: { width: 64, height: 48, fpsNum: 25, fpsDen: 1, codecPrivate: new Uint8Array([0x81, 0, 0, 0]), name: 'Video', language: 'und', isDefault: true },
    videoPackets: of([{ index: 0, keyframe: true, data: new Uint8Array([1]) }]),
    audio: [],
    subtitles: [],
    attachments: [],
    chapters: [],
    ...over,
  };
}

describe('writeMkv', () => {
  const dir = mkdtempSync(join(tmpdir(), 'seikou-mkv-file-'));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it('names seikou-encode as the application unless the input names another', async () => {
    const path = join(dir, 'app.mkv');
    await writeMkv(path, input());
    const tree = parseMkv(new Uint8Array(readFileSync(path)));
    expect(stringOf(find(tree, Id.MuxingApp))).toBe('seikou-encode');
    expect(stringOf(find(tree, Id.WritingApp))).toBe('seikou-encode');
    await writeMkv(path, input({ appName: 'other-app' }));
    expect(stringOf(find(parseMkv(new Uint8Array(readFileSync(path))), Id.MuxingApp))).toBe('other-app');
  });

  it('leaves an existing file untouched when the input is invalid', async () => {
    const path = join(dir, 'keep.mkv');
    writeFileSync(path, 'the earlier encode');
    const badSubtitles: MkvInput['subtitles'] = [
      { name: 'English', language: 'eng', isDefault: true, codecId: 'S_TEXT/ASS', blocks: [{ timeMs: -5, data: new Uint8Array([1]) }] },
    ];
    await expect(writeMkv(path, input({ subtitles: badSubtitles }))).rejects.toThrow(RangeError);
    await expect(writeMkv(path, input({ docType: 'webm', attachments: [{ name: 'a.ttf', mediaType: 'font/ttf', data: new Uint8Array([1]) }] }))).rejects.toThrow(/WebM/);
    expect(readFileSync(path, 'utf8')).toBe('the earlier encode');
  });

  it('names the file in a read error', async () => {
    const path = join(dir, 'not-mkv.bin');
    writeFileSync(path, 'not a matroska file at all');
    expect((await nodeRangeReader(path)).name).toBe(path);
    await expect(readMkv(path)).rejects.toThrow(path);
  });
});
