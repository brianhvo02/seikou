// SPDX-License-Identifier: LGPL-3.0-or-later
// Line a fansub track up with the disc's audio, here through a stand-in decoder.
import { align } from '@seikou/fansubs';
import { createReadStream, existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { parseSourcePacket, PesAssembler } from '@seikou/bdmv';
import type { AudioDecoder, FansubDiscSource } from '@seikou/fansubs';

// Where the speech disc's speech sits, in playlist time (start and end, in ms).
const SPEECH = '1200,3310 4330,6320 8990,11270 12840,15550 18050,19010 21700,22960 23720,26700 27140,28780 29150,30110 32030,34860 37100,39530 39980,42140 43630,44880 47320,48270 50500,51620 51990,54370 56440,59140 61400,64040 66120,67000 68110,69240 71120,72760 73780,76320 77370,80090 81730,82970 84380,86440 87740,89200 91520,93640 94790,97170 98880,100560 102240,103560 104070,106170 107730,109530 110540,112330 112820,115320 116110,117180 119520,121650 123430,126280 127180,129040 130280,132470 134400,135710'.split(' ').map((pair) => pair.split(',').map(Number) as [number, number]);
const CLIP_START_PTS = 900_000; // the 90 kHz time at which each clip's first packet plays

// The speech disc as the package reads discs: whole files and byte ranges of a clip.
const root = fileURLToPath(new URL('../../../fixtures/synthetic/disc-speech/', import.meta.url));
let lastClip = '';
const disc: FansubDiscSource = {
  readFile: async (path) => (existsSync(root + path) ? new Uint8Array(readFileSync(root + path)) : null),
  clip: async (path) => {
    lastClip = path;
    return { read: (from, to) => createReadStream(root + path, { start: from, ...(to === undefined ? {} : { end: to - 1 }) }) };
  },
};

// A stand-in for a real AC-3 decoder (the server runs ffmpeg): it reads when the range's audio packets play and
// gives back 16 kHz mono noise, loud where the disc has speech.
const decode: AudioDecoder = async ({ read, pid }) => {
  const pts: number[] = [];
  const assembler = new PesAssembler((pes) => {
    if (pes.pts !== undefined) pts.push(pes.pts);
  });
  let carry = Buffer.alloc(0);
  for await (const chunk of read as AsyncIterable<Buffer>) {
    const bytes = Buffer.concat([carry, chunk]);
    const whole = bytes.length - (bytes.length % 192);
    carry = bytes.subarray(whole);
    for (let at = 0; at < whole; at += 192) {
      const packet = parseSourcePacket(bytes, at);
      if (packet && packet.pid === pid) assembler.push(packet);
    }
  }
  assembler.flush();
  const firstPts = pts[0]!;
  const step = pts.length > 1 ? pts[pts.length - 1]! - pts[pts.length - 2]! : 0;
  const samples = Math.round(((pts[pts.length - 1]! + step - firstPts) / 90) * 16);
  // The second clip holds the playlist from 90 s on.
  const startMs = (lastClip.includes('00002') ? 90_000 : 0) + (firstPts - CLIP_START_PTS) / 90;
  const pcm = new Int16Array(samples);
  for (let i = 0; i < samples; i++) {
    const ms = startMs + i / 16;
    const noise = (Math.imul(i, 1664525) + 1013904223) >>> 0;
    pcm[i] = Math.round((noise / 2 ** 32 - 0.5) * (SPEECH.some(([from, to]) => ms >= from && ms < to) ? 24_000 : 40));
  }
  return { firstPts, pcm };
};

// An ASS script with one line over each stretch of speech, a little early.
function track(earlyMs: number, lines = SPEECH.length): string {
  const time = (ms: number): string => {
    const cs = Math.round(ms / 10);
    const p2 = (n: number): string => String(n).padStart(2, '0');
    return `${Math.floor(cs / 360000)}:${p2(Math.floor(cs / 6000) % 60)}:${p2(Math.floor(cs / 100) % 60)}.${p2(cs % 100)}`;
  };
  return [
    '[Script Info]', 'ScriptType: v4.00+', '', '[V4+ Styles]',
    'Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding',
    'Style: Default,Arial,20,&H00FFFFFF,&H000000FF,&H00000000,&H00000000,0,0,0,0,100,100,0,0,1,2,2,2,10,10,10,1',
    '', '[Events]', 'Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text',
    ...SPEECH.slice(0, lines).map(([from, to], i) => `Dialogue: 0,${time(from - earlyMs)},${time(to - earlyMs)},Default,,0,0,0,,Line ${i}`),
  ].join('\n');
}

export default async function example(): Promise<void> {
  // The track's lines start 500 ms before the speech they belong to, so the offset to add is +500 ms.
  const aligned = await align(disc, '00000', 150_000, track(500), decode);
  console.log(aligned);
  if (aligned.kind !== 'offset' || Math.abs(aligned.offsetMs - 500) > 30 || aligned.confidence < 0.8) throw new Error('the track was not lined up at +500 ms');

  // A track with too little dialogue to judge by is never guessed at.
  const sparse = await align(disc, '00000', 150_000, track(500, 5), decode);
  console.log(sparse);
  if (sparse.kind !== 'none') throw new Error('a sparse track was lined up');
}
