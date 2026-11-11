/*
 * Ported from libbluray src/libbluray/bdnav/sound_parse.c
 * Copyright (C) 2010-2019  Petri Hintukainen <phintuka@users.sourceforge.net>
 *
 * Ported to TypeScript and modified for Seikou, 2026.
 *
 * SPDX-License-Identifier: LGPL-2.1-or-later
 */

import { ByteReader, ParseError } from './byte-reader';
import { checkVersion } from './version';

/**
 * One menu sound effect of `sound.bdmv` (the button sounds IG menus play), libbluray `SOUND_OBJECT`
 * (`sound_parse.h`).
 */
export interface SoundClip {
  /** `num_channels`: 1 or 2. */
  readonly channels: 1 | 2;
  /** `sample_rate`: always 48 kHz, the only rate libbluray knows. */
  readonly sampleRate: 48000;
  /** `samples`: interleaved signed 16-bit LPCM, `channels` samples per frame. */
  readonly samples: Int16Array;
}

/** The parsed `BDMV/AUXDATA/sound.bdmv`, libbluray `SOUND_DATA` (`sound_parse.h`). */
export interface SoundData {
  /** The sounds in file order; an IG button's sound id indexes this. */
  readonly clips: readonly SoundClip[];
}

interface SoundIndex {
  readonly channels: 1 | 2;
  readonly dataOffset: number;
  readonly numFrames: number;
}

const SOUND_OBJECTS_START = 40;

/**
 * One sound's index entry (libbluray `_sound_parse_attributes` and `_sound_parse_index`): channel configuration code
 * 3 is stereo and any other is mono; the sample rate and sample size codes are read and taken as 48 kHz and 16 bit
 * whatever they hold, as libbluray does. `numFrames` is the stored byte length divided by 2 bytes per channel.
 */
function parseSoundIndex(r: ByteReader): SoundIndex {
  const channels = r.bits(4) === 3 ? 2 : 1;
  r.bits(4); // sample rate code; only 48 kHz exists
  r.bits(2); // bits per sample code; only 16 bit exists
  r.skipBits(6);
  const dataOffset = r.u32();
  const numFrames = Math.floor(r.u32() / (2 * channels));
  return { channels, dataOffset, numFrames };
}

/**
 * Parses the bytes of `BDMV/AUXDATA/sound.bdmv` (libbluray `_sound_parse`, reached through `sound_get`). Throws a
 * ParseError for a bad `BCLK` signature, an unsupported version, a file with no sounds, or sample data cut off by the
 * end of the file.
 */
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
