// SPDX-License-Identifier: LGPL-3.0-or-later
// A disc for judging A/V sync by eye and ear: the picture flashes white and a 1 kHz beep sounds together for the first
// two frames (83 ms) of every second, over black and silence. Whichever comes first shows which way playback is off.
// Playlist 00000 has them together; 00001 to 00006 move the beep 40, 80, 120, 160, 200 and 240 ms earlier, so the one
// that looks together on a device says how late its sound arrives.
// Usage: npx tsx scripts/make-sync-disc.ts <outDir> [--seconds N]
import { CodingType } from '@seikou/bdmv/stream-types';
import { AUDIO_FRAMES_PER_PES, CLIP_START_PTS, buildSyntheticDisc, type SyntheticAudioStream } from '../tests/helpers/synthetic-disc';
import { writeFixture } from './fixture-dir';
import { encodeTestVideo } from './x264';

const [outDir, ...args] = process.argv.slice(2);
if (!outDir) {
  console.error('usage: tsx scripts/make-sync-disc.ts <outDir> [--seconds N]');
  process.exit(1);
}
const flag = args.indexOf('--seconds');
const seconds = flag >= 0 ? Number(args[flag + 1]) : 20;
if (!Number.isInteger(seconds) || seconds <= 0) {
  console.error(`--seconds must be a positive whole number (got ${args[flag + 1]})`);
  process.exit(1);
}

const FPS = 24;
const FLASH_FRAMES = 2;
const RATE = 48_000;
const BEEP_FRAMES = Math.round((FLASH_FRAMES / FPS) * RATE);
/** How much earlier the beep comes in each playlist after 00000, in ms. */
const LEADS_MS = [0, 40, 80, 120, 160, 200, 240];

// testsrc2 painted over: black, and white on the flash frames
const aus = encodeTestVideo(seconds * FPS, '1280x720', [
  '-vf',
  `drawbox=x=0:y=0:w=iw:h=ih:color=black:t=fill,drawbox=x=0:y=0:w=iw:h=ih:color=white:t=fill:enable='lt(mod(n\\,${FPS})\\,${FLASH_FRAMES})'`,
]);

/**
 * One 16-bit stereo LPCM PES payload starting at sample `start`: the beep in each second's first BEEP_FRAMES, moved
 * `lead` samples earlier, else silence.
 */
function payload(start: number, lead: number): Uint8Array {
  const out = new Uint8Array(4 + AUDIO_FRAMES_PER_PES * 4);
  const size = AUDIO_FRAMES_PER_PES * 4;
  out.set([size >> 8, size & 0xff, 0x31, 0x40]); // stereo, 48 kHz, 16-bit
  for (let i = 0; i < AUDIO_FRAMES_PER_PES; i++) {
    const n = start + i + lead;
    const v = n % RATE < BEEP_FRAMES ? Math.round(Math.sin((2 * Math.PI * 1000 * n) / RATE) * 16384) & 0xffff : 0;
    const o = 4 + i * 4;
    out.set([v >> 8, v & 0xff, v >> 8, v & 0xff], o);
  }
  return out;
}

const ticks = (AUDIO_FRAMES_PER_PES * 90_000) / RATE;
const audio = (leadMs: number): SyntheticAudioStream => ({
  pid: 0x1100,
  codingType: CodingType.LPCM,
  units: Array.from({ length: Math.ceil((seconds * RATE) / AUDIO_FRAMES_PER_PES) }, (_, j) => ({
    pts: CLIP_START_PTS + j * ticks,
    payload: payload(j * AUDIO_FRAMES_PER_PES, Math.round((leadMs / 1000) * RATE)),
  })),
});

const id = (i: number): string => String(i + 1).padStart(5, '0');
const files = buildSyntheticDisc({
  clips: LEADS_MS.map((lead, i) => ({ clipId: id(i), videoAus: aus, keyIndices: Array.from({ length: seconds }, (_, k) => k * FPS), startPts: CLIP_START_PTS, audioStreams: [audio(lead)] })),
  playlists: LEADS_MS.map((_, i) => ({ id: id(i - 1), clipIds: [id(i)] })),
});
writeFixture(outDir, files);
console.log(`wrote ${files.size} files to ${outDir}`);
