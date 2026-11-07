import { spawn } from 'node:child_process';
import { setPriority } from 'node:os';
import { CodingType } from '@seikou/bdmv/stream-types';
import { SAMPLE_RATE_OUT, type AudioDecoder } from '@seikou/fansubs/audio-decoder';
import { assertNoDecodeGap, demuxAudioPid, type Write } from '@seikou/fansubs/disc-audio';
import { Semaphore } from '@seikou/fansubs/semaphore';

/** The nice value of an alignment's ffmpeg, as of the levels' software decode: the NAS's other services come first. */
const ALIGN_NICE = 10;
/** The alignments' ffmpeg runs, shared by the title runs, re-alignments and viewers' picks: two at a time. */
export const ALIGN_FFMPEG = new Semaphore(2);

/** Decodes one audio PID of a byte range of a clip to 16 kHz mono s16le with ffmpeg. Throws when it can't, or when frames were lost. */
async function decodeRange({ read, pid, coding, signal }: Parameters<AudioDecoder>[0], ffmpegPath: string): Promise<{ firstPts: number; pcm: Int16Array }> {
  const pesPts: number[] = [];
  const core = coding === CodingType.TRUEHD;
  const input = core ? ['-f', 'ac3'] : ['-f', 'mpegts'];
  const map = core ? [] : ['-map', `0:#0x${pid.toString(16)}`];
  const ff = spawn(ffmpegPath, [
    '-hide_banner', '-nostdin', '-loglevel', 'error', ...input, '-i', 'pipe:0', ...map,
    '-ac', '1', '-ar', String(SAMPLE_RATE_OUT), '-f', 's16le', 'pipe:1',
  ], { stdio: ['pipe', 'pipe', 'pipe'] });
  if (ff.pid !== undefined) {
    try {
      setPriority(ff.pid, ALIGN_NICE);
    } catch {
      // the priority stays as it is where the NAS doesn't allow lowering it
    }
  }
  const out: Buffer[] = [];
  const tail: string[] = [];
  let pending = '';
  ff.stdout.on('data', (d: Buffer) => out.push(d));
  ff.stderr.on('data', (d: Buffer) => {
    const lines = (pending + d.toString()).split('\n');
    pending = lines.pop() ?? '';
    for (const line of lines) if (line.trim()) tail.push(line);
    tail.splice(0, Math.max(0, tail.length - 8));
  });
  ff.stdin.on('error', () => {}); // ffmpeg may stop reading early; its exit code says why
  const closed = new Promise<number | null>((resolve, reject) => {
    ff.on('error', reject);
    ff.on('close', resolve);
  });
  closed.catch(() => {}); // a failed spawn is reported where `closed` is awaited, never as an unhandled rejection
  let alive = true;
  const gone = new Promise<void>((resolve) => {
    const end = (): void => {
      alive = false;
      resolve();
    };
    ff.on('exit', end);
    ff.on('close', end);
    ff.on('error', end);
    ff.stdin.on('close', end);
  });
  const write: Write = async (bytes) => {
    if (!alive) return false;
    if (ff.stdin.write(bytes)) return true;
    await Promise.race([new Promise<void>((resolve) => ff.stdin.once('drain', resolve)), gone]);
    return alive;
  };
  const aborted = new Promise<null>((resolve) => signal?.addEventListener('abort', () => resolve(null), { once: true }));
  const onAbort = (): void => {
    ff.kill('SIGKILL');
    read.destroy();
  };
  signal?.addEventListener('abort', onAbort, { once: true });
  try {
    if (signal?.aborted) onAbort();
    let firstPts: number | null = null;
    try {
      firstPts = await demuxAudioPid(read, pid, core, write, pesPts, signal);
    } catch (err) {
      if (!signal?.aborted) throw err;
    }
    ff.stdin.end();
    // An aborted run doesn't wait for the pipes to close: a child of ffmpeg could hold them open.
    const code = await Promise.race([closed, aborted]);
    signal?.throwIfAborted();
    if (pending.trim()) tail.push(pending);
    if (code !== 0) throw new Error(`disc audio: ffmpeg exited ${code}: ${tail.join(' | ').slice(0, 300)}`);
    if (firstPts === null) throw new Error(`disc audio: no audio PES on PID 0x${pid.toString(16)} in the byte range`);
    const bytes = Buffer.concat(out);
    const raw = new Int16Array(bytes.length >> 1);
    for (let i = 0; i < raw.length; i++) raw[i] = bytes.readInt16LE(i * 2);
    assertNoDecodeGap(pesPts, raw.length, pid);
    return { firstPts, pcm: raw };
  } finally {
    signal?.removeEventListener('abort', onAbort);
    read.destroy();
    if (ff.exitCode === null && ff.signalCode === null) ff.kill('SIGKILL');
  }
}

/** The audio decoder that runs ffmpeg (two at a time, at nice 10). */
export function ffmpegAudioDecoder(ffmpegPath: string): AudioDecoder {
  return async (input) => {
    try {
      return await ALIGN_FFMPEG.run(() => decodeRange(input, ffmpegPath), input.signal);
    } catch (err) {
      input.read.destroy(); // refused while waiting for a slot (aborted): decodeRange never took the stream
      throw err;
    }
  };
}
