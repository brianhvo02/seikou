import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fixtureDir } from './fixture-dir';

const out = fixtureDir('fixtures/synthetic/audio');
rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });

/** 1 s of 440 Hz at −12 dBFS (the lavfi sine source peaks at 0.125, so gain 2 gives 0.25) in the front left and right channels only, so a downmix keeps it in both. */
function tone(file: string, codec: string[], layout: 'stereo' | '5.1'): void {
  const pan = layout === 'stereo' ? 'pan=stereo|FL=c0|FR=c0' : 'pan=5.1|FL=c0|FR=c0';
  const bytes = execFileSync('ffmpeg', [
    '-v', 'error', '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000:duration=1',
    '-af', `volume=2,${pan}`, ...codec, '-',
  ], { maxBuffer: 1 << 26 });
  writeFileSync(join(out, file), bytes);
}

tone('tone-ac3-stereo.ac3', ['-c:a', 'ac3', '-b:a', '192k', '-f', 'ac3'], 'stereo');
tone('tone-ac3-51.ac3', ['-c:a', 'ac3', '-b:a', '448k', '-f', 'ac3'], '5.1');
tone('tone-eac3-51.eac3', ['-c:a', 'eac3', '-b:a', '384k', '-f', 'eac3'], '5.1');
tone('tone-dts-51.dts', ['-c:a', 'dca', '-strict', '-2', '-b:a', '768k', '-f', 'dts'], '5.1');

/**
 * TrueHD streams for the lossless decoder (ffmpeg's encoder stops at 5.1; 7.1 is tested with DTS-HD samples and the
 * local discs): each channel carries its own tone (220 Hz × its position, at −12 dBFS), so
 * a test can tell the channels apart. `truehd.json` holds ffmpeg's own decode of each (s32le, MD5): `native` in the
 * stream's layout and order, `stereo` and `surround` with ffmpeg's `-downmix stereo` and `-downmix 5.1(side)`, which
 * the WASM decoder must match bit for bit.
 */
const TRUEHD: ReadonlyArray<readonly [file: string, layout: string, channels: number, rate: number]> = [
  ['truehd-stereo.thd', 'stereo', 2, 48_000],
  ['truehd-51.thd', '5.1(side)', 6, 48_000],
  ['truehd-51-96k.thd', '5.1(side)', 6, 96_000],
];
const reference: Record<string, { layout: string; rate: number; native: string; stereo: string; surround: string }> = {};
for (const [file, layout, channels, rate] of TRUEHD) {
  const tones = Array.from({ length: channels }, (_, c) => `0.25*sin(2*PI*${220 * (c + 1)}*t)`).join('|');
  const bytes = execFileSync('ffmpeg', [
    '-v', 'error', '-f', 'lavfi', '-i', `aevalsrc=${tones}:s=${rate}:d=1:c=${layout}`,
    '-c:a', 'truehd', '-strict', '-2', '-flags', '+bitexact', '-f', 'truehd', '-',
  ], { maxBuffer: 1 << 26 });
  writeFileSync(join(out, file), bytes);
  const md5 = (downmix: string[]): string =>
    execFileSync('ffmpeg', ['-v', 'error', ...downmix, '-i', join(out, file), '-f', 's32le', '-flags', '+bitexact', '-'], { maxBuffer: 1 << 28 }).toString('base64');
  const hash = (b64: string): string => createHash('md5').update(Buffer.from(b64, 'base64')).digest('hex');
  reference[file] = { layout, rate, native: hash(md5([])), stereo: hash(md5(['-downmix', 'stereo'])), surround: hash(md5(['-downmix', '5.1(side)'])) };
}
writeFileSync(join(out, 'truehd.json'), `${JSON.stringify(reference, null, 2)}\n`);
