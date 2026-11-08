import { execFileSync } from 'node:child_process';
import { CodingType } from '@seikou/bdmv/stream-types';
import { CLIP_START_PTS, buildSyntheticDisc } from '../tests/helpers/synthetic-disc';
import { SPEECH_BURSTS, SPEECH_CLIP_SPLIT_S, SPEECH_DISC_SECONDS } from '../tests/helpers/speech-bursts';
import { framed } from './audio-units';
import { writeFixture } from './fixture-dir';
import { encodeTestVideo } from './x264';

const args = process.argv.slice(2);
const sizeAt = args.indexOf('--video-size');
const videoSize = sizeAt >= 0 ? args.splice(sizeAt, 2)[1] : undefined;
const outDir = args[0];
if (!outDir || (videoSize !== undefined && !/^\d+x\d+$/.test(videoSize))) {
  console.error('usage: tsx scripts/make-speech-disc.ts <outDir> [--video-size WxH]');
  process.exit(1);
}
/**
 * The picture. The default 64x36 (crf 51) is what the committed synthetic disc holds; a larger size is for discs
 * whose picture a browser must decode, which Chrome refuses at 64x36, and gets a rate that keeps the disc small.
 */
const videoArgs = videoSize === undefined ? ['-crf', '51'] : ['-crf', '41', '-preset', 'fast'];

/** The AC-3 encoder's delay: its output sounds this many samples after its input, which the encoded signal leads by. */
const AC3_PRIMING_SAMPLES = 256;

/**
 * Stereo AC-3 at 192 kb/s: pink noise at -20 dBFS inside the bursts that fall in [fromS, fromS + seconds), silence
 * elsewhere. The gate follows the bursts to the millisecond (the source makes 48-sample frames, which `volume` gates
 * whole) and the signal is cut 256 samples early, so the encoder's delay puts each burst at its time in the decode.
 */
function speechAudio(fromS: number, seconds: number): Uint8Array {
  const gate = SPEECH_BURSTS.map((b) => [b.fromMs / 1000 - fromS, b.toMs / 1000 - fromS] as const)
    .filter(([a, b]) => b > 0 && a < seconds)
    .map(([a, b]) => `between(t,${Math.max(a, 0)},${b})`)
    .join('+');
  const extra = AC3_PRIMING_SAMPLES / 48_000;
  return new Uint8Array(execFileSync('ffmpeg', [
    '-v', 'error', '-f', 'lavfi', '-i', `anoisesrc=color=pink:amplitude=0.3:sample_rate=48000:nb_samples=48:duration=${seconds + extra}:seed=${fromS + 1}`,
    '-af', `volume='if(${gate},1,0)':eval=frame,atrim=start_sample=${AC3_PRIMING_SAMPLES},asetpts=N/SR/TB,pan=stereo|FL=c0|FR=c0`,
    '-c:a', 'ac3', '-b:a', '192k', '-f', 'ac3', '-',
  ], { maxBuffer: 1 << 28 }));
}

const clip = (clipId: string, fromS: number, seconds: number): Parameters<typeof buildSyntheticDisc>[0]['clips'][number] => {
  const frames = seconds * 24;
  return {
    clipId,
    videoAus: encodeTestVideo(frames, videoSize ?? '64x36', videoArgs),
    keyIndices: Array.from({ length: seconds }, (_, i) => i * 24),
    startPts: CLIP_START_PTS,
    audioStreams: [{ pid: 0x1100, codingType: CodingType.AC3, lang: 'jpn', format: 3, units: framed(speechAudio(fromS, seconds), 'ac3') }],
  };
};

const files = buildSyntheticDisc({
  clips: [clip('00001', 0, SPEECH_CLIP_SPLIT_S), clip('00002', SPEECH_CLIP_SPLIT_S, SPEECH_DISC_SECONDS - SPEECH_CLIP_SPLIT_S)],
  playlists: [{ id: '00000', clipIds: ['00001', '00002'], chapterEverySeconds: 30 }],
});
writeFixture(outDir, files);
console.log(`wrote ${files.size} files to ${outDir}`);
