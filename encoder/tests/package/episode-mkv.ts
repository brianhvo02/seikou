// SPDX-License-Identifier: LGPL-3.0-or-later
import { createReadStream } from 'node:fs';
import { assToMatroska } from '../../src/mux/ass-track';
import { readIvf } from '../../src/mux/ivf';
import { writeMkv, type MkvResult } from '../../src/mux/mkv-writer';
import { readOggOpus } from '../../src/mux/ogg';
import { fx } from '../paths';

/** A full ASS script with events out of time order, so ReadOrder and time order differ. */
export const SCRIPT = [
  '[Script Info]',
  'Title: Starfall Wanderer',
  'ScriptType: v4.00+',
  '',
  '[V4+ Styles]',
  'Format: Name, Fontname, Fontsize',
  'Style: Default,Starfall Sans,48',
  '',
  '[Events]',
  'Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text',
  'Dialogue: 0,0:00:00.30,0:00:00.45,Default,,0,0,0,,Second, by time',
  'Dialogue: 1,0:00:00.10,0:00:00.20,Default,Mira,0,0,0,,{\\an8}First, with a comma',
  'Dialogue: 0,0:00:00.25,0:00:00.40,Default,,0,0,0,,Third',
  '',
].join('\n');

export const SIGNS = [
  '[Script Info]',
  'ScriptType: v4.00+',
  '',
  '[Events]',
  'Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text',
  'Dialogue: 0,0:00:00.00,0:00:00.40,Default,,0,0,0,,Lantern Harbor',
  '',
].join('\n');

/** One display set: a PCS (type 0x16) with two bytes of data, then an END segment (type 0x80). */
export const PGS_SET = new Uint8Array([0x16, 0x00, 0x02, 0xaa, 0xbb, 0x80, 0x00, 0x00]);
export const FONT = new Uint8Array([0, 1, 0, 0, 1, 2, 3]);

/** Writes a small episode MKV with every kind of track a real one has: AV1, two Opus, two ASS (full and signs), one PGS, a font and chapters. */
export async function writeEpisodeMkv(path: string): Promise<MkvResult> {
  const ivf = await readIvf(createReadStream(fx('fixtures/small.ivf')));
  const seq = await ivf.sequenceHeader;
  const oggs = await Promise.all([0, 1].map(() => readOggOpus(createReadStream(fx('fixtures/tone.opus')))));
  const labels = [
    { name: 'Japanese', language: 'jpn', isDefault: true },
    { name: 'Commentary', language: 'eng', isDefault: false },
  ];
  const full = assToMatroska(SCRIPT, 500);
  const signs = assToMatroska(SIGNS, 500);
  return writeMkv(path, {
    title: 'Starfall Wanderer - 01',
    video: { width: 64, height: 64, fpsNum: 24000, fpsDen: 1001, codecPrivate: seq.av1C, name: 'Starfall Wanderer', language: 'jpn', isDefault: true },
    videoPackets: ivf.packets,
    audio: oggs.map((ogg, i) => ({
      ...labels[i]!,
      channels: 2,
      sampleRate: 48000,
      codecPrivate: ogg.head.raw,
      codecDelayNs: (BigInt(ogg.head.preSkip) * 1_000_000_000n) / 48000n,
      seekPreRollNs: 80_000_000n,
      packets: ogg.packets,
      end: ogg.end,
    })),
    subtitles: [
      { codecId: 'S_TEXT/ASS', name: 'English (Starfall Subs)', language: 'eng', isDefault: true, ...full },
      { codecId: 'S_TEXT/ASS', name: 'Signs (Starfall Subs)', language: 'eng', isDefault: false, isForced: true, ...signs },
      {
        codecId: 'S_HDMV/PGS',
        name: 'Japanese (disc)',
        language: 'jpn',
        isDefault: false,
        blocks: [
          { timeMs: 50, data: PGS_SET },
          { timeMs: 260, data: PGS_SET },
        ],
      },
    ],
    attachments: [{ name: 'StarfallSans.ttf', mediaType: 'font/ttf', data: FONT }],
    chapters: [
      { title: 'Cold open', startNs: 0n },
      { title: 'Part <A> & B', startNs: 250_250_000n },
    ],
  });
}
