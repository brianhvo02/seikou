// SPDX-License-Identifier: LGPL-3.0-or-later
// Generates fixtures/tone.opus: 0.5 s (24000 frames) of a 440 Hz stereo sine at 48 kHz, via opusenc.
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { toolPaths } from '../tests/helpers/tools';

const FRAMES = 24000;
const RATE = 48000;
const CHANNELS = 2;

function makeWav(): Buffer {
  const dataSize = FRAMES * CHANNELS * 2;
  const buf = Buffer.alloc(44 + dataSize);
  buf.write('RIFF', 0, 'ascii');
  buf.writeUInt32LE(36 + dataSize, 4);
  buf.write('WAVE', 8, 'ascii');
  buf.write('fmt ', 12, 'ascii');
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20); // PCM
  buf.writeUInt16LE(CHANNELS, 22);
  buf.writeUInt32LE(RATE, 24);
  buf.writeUInt32LE(RATE * CHANNELS * 2, 28);
  buf.writeUInt16LE(CHANNELS * 2, 32);
  buf.writeUInt16LE(16, 34);
  buf.write('data', 36, 'ascii');
  buf.writeUInt32LE(dataSize, 40);
  for (let i = 0; i < FRAMES; i++) {
    const s = Math.round(0.5 * 32767 * Math.sin((2 * Math.PI * 440 * i) / RATE));
    for (let c = 0; c < CHANNELS; c++) buf.writeInt16LE(s, 44 + (i * CHANNELS + c) * 2);
  }
  return buf;
}

const opusenc = toolPaths()?.opusenc ?? process.env.ENCODING_TOOLS_OPUSENC ?? 'opusenc';
const dir = mkdtempSync(path.join(tmpdir(), 'encoding-tools-opus-'));
try {
  const wav = path.join(dir, 'tone.wav');
  writeFileSync(wav, makeWav());
  execFileSync(opusenc, ['--bitrate', '64', wav, 'fixtures/tone.opus'], { stdio: 'inherit' });
} finally {
  rmSync(dir, { recursive: true, force: true });
}
