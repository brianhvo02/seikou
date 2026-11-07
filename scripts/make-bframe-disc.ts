import { execFileSync } from 'node:child_process';
import { CodingType } from '@seikou/bdmv/stream-types';
import { analyzeAvc } from '@seikou/bdmv/codecs/h264';
import { SOURCE_PACKET_SIZE } from '@seikou/bdmv/demux/constants';
import { PesAssembler, type PesPacket } from '@seikou/bdmv/demux/pes-assembler';
import { parseSourcePacket } from '@seikou/bdmv/demux/ts-packet';
import { CLIP_START_PTS, buildSyntheticDisc } from '../tests/helpers/synthetic-disc';
import { writeFixture } from './fixture-dir';

const outDir = process.argv[2];
if (!outDir) {
  console.error('usage: tsx scripts/make-bframe-disc.ts <outDir>');
  process.exit(1);
}
const SECONDS = 6;
const FRAMES = SECONDS * 24;

// B-frames with a pyramid and open-GOP I-frames (recovery-point SEI instead of IDR) every 2 s.
const ts = execFileSync(
  'ffmpeg',
  [
    '-v', 'error',
    '-f', 'lavfi', '-i', 'testsrc2=size=640x360:rate=24',
    '-frames:v', String(FRAMES),
    '-c:v', 'libx264', '-profile:v', 'high', '-level', '4.1', '-pix_fmt', 'yuv420p',
    '-x264-params', 'bframes=3:b-pyramid=normal:open-gop=1:keyint=48:min-keyint=48:scenecut=0:aud=1:repeat-headers=1',
    '-f', 'mpegts', '-',
  ],
  { maxBuffer: 1 << 30 },
);

// Demux with the engine's own code. Standard 188-byte packets get a 4-byte dummy TP_extra_header.
const packets = ts.length / 188;
if (!Number.isInteger(packets)) throw new Error('mpegts output is not a whole number of packets');
const source = new Uint8Array(packets * SOURCE_PACKET_SIZE);
for (let i = 0; i < packets; i++) source.set(ts.subarray(i * 188, (i + 1) * 188), i * SOURCE_PACKET_SIZE + 4);

const pesList: PesPacket[] = [];
const assembler = new PesAssembler((pes) => {
  if (pes.streamId === 0xe0 && pes.pts !== undefined) pesList.push(pes);
});
for (let i = 0; i < packets; i++) {
  const packet = parseSourcePacket(source, i * SOURCE_PACKET_SIZE);
  if (packet) assembler.push(packet);
}
assembler.flush();
if (pesList.length !== FRAMES) throw new Error(`expected ${FRAMES} video PES packets, got ${pesList.length}`);

// Re-base so the earliest presentation time is CLIP_START_PTS (DTS runs a few frames earlier).
const minPts = Math.min(...pesList.map((p) => p.pts ?? 0));
const shift = CLIP_START_PTS - minPts;
const pts = pesList.map((p) => (p.pts ?? 0) + shift);
const dts = pesList.map((p) => (p.dts ?? p.pts ?? 0) + shift);
const videoAus = pesList.map((p) => p.payload);
const infos = videoAus.map((au) => analyzeAvc(au));
const keyIndices = infos.flatMap((info, i) => (info.key ? [i] : []));
const idrCount = infos.filter((i) => i.idr).length;
const reordered = pts.some((p, i) => i > 0 && p < pts[i - 1]);
if (!reordered) throw new Error('stream has no B-frame reordering; encoder settings were not applied');
if (keyIndices.length !== SECONDS / 2 || idrCount === keyIndices.length) throw new Error(`expected open-GOP key frames, got ${keyIndices.length} keys / ${idrCount} IDR`);
console.log(`frames=${FRAMES} keys=${keyIndices.join(',')} idr=${idrCount} firstDtsToPts=${pts[0] - dts[0]}`);

const files = buildSyntheticDisc({
  clips: [{ clipId: '00001', videoAus, keyIndices, startPts: CLIP_START_PTS, pts, dts, audio: CodingType.LPCM }],
  playlists: [{ id: '00000', clipIds: ['00001'], chapterEverySeconds: 2 }],
});

writeFixture(outDir, files);
console.log(`wrote ${files.size} files to ${outDir}`);
