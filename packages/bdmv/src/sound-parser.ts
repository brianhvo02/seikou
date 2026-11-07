/*
 * Ported from libbluray src/libbluray/bdnav/sound_parse.c
 * Copyright (C) 2010-2019  Petri Hintukainen <phintuka@users.sourceforge.net>
 *
 * Ported to TypeScript and modified for bluray-web, 2026.
 *
 * SPDX-License-Identifier: LGPL-2.1-or-later
 */

import { ByteReader, ParseError } from './byte-reader';
import { checkVersion } from './version';

export interface SoundClip {
  readonly channels: 1 | 2;
  readonly sampleRate: 48000;
  /** Interleaved signed 16-bit samples. */
  readonly samples: Int16Array;
}

export interface SoundData {
  readonly clips: readonly SoundClip[];
}

interface SoundIndex {
  readonly channels: 1 | 2;
  readonly dataOffset: number;
  readonly numFrames: number;
}

const SOUND_OBJECTS_START = 40;

/** _sound_parse_attributes + _sound_parse_index: unknown codes fall back to mono, 48 kHz, 16 bit like libbluray. */
function parseSoundIndex(r: ByteReader): SoundIndex {
  const channels = r.bits(4) === 3 ? 2 : 1;
  r.bits(4); // sample rate code; only 48 kHz exists
  r.bits(2); // bits per sample code; only 16 bit exists
  r.skipBits(6);
  const dataOffset = r.u32();
  const numFrames = Math.floor(r.u32() / (2 * channels));
  return { channels, dataOffset, numFrames };
}

/** sound_parse (_sound_parse) */
export function parseSoundBdmv(bytes: Uint8Array): SoundData {
  const r = new ByteReader(bytes);
  const signature = r.ascii(4);
  const version = r.ascii(4);
  if (signature !== 'BCLK') throw new ParseError(`sound.bdmv: bad signature "${signature}"`);
  checkVersion('sound.bdmv', version);
  const dataStart = r.u32();
  r.u32(); // extension_data_start
  r.seek(SOUND_OBJECTS_START);
  const dataLen = r.u32();
  r.skip(1); // reserved
  const numSounds = r.u8();
  if (dataLen < 1 || numSounds < 1) throw new ParseError('sound.bdmv: empty database');

  const indexes: SoundIndex[] = [];
  for (let i = 0; i < numSounds; i++) indexes.push(parseSoundIndex(r));

  const clips: SoundClip[] = [];
  for (const [i, idx] of indexes.entries()) {
    const numSamples = idx.numFrames * idx.channels;
    const start = dataStart + idx.dataOffset;
    if (numSamples === 0) {
      clips.push({ channels: idx.channels, sampleRate: 48000, samples: new Int16Array(0) });
      continue;
    }
    r.seek(start);
    if (r.remaining / 2 < numSamples) throw new ParseError(`sound.bdmv: unexpected end of file in sound ${i}`);
    const samples = new Int16Array(numSamples);
    for (let n = 0; n < numSamples; n++) samples[n] = (r.u16() << 16) >> 16;
    clips.push({ channels: idx.channels, sampleRate: 48000, samples });
  }
  return { clips };
}
