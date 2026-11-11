import { existsSync } from 'node:fs';
import { spawn as nodeSpawn } from 'node:child_process';
import type { LevelsConfig } from '../config';
import type { EncoderCodec } from './capacity';
import { qsvBackend, x264Backend, type EncoderBackend } from './encoder';

/** The GPU's render node, which the deploy's `compose.gpu.yaml` passes into the container; without it Quick Sync can't run. */
export const RENDER_NODE = '/dev/dri/renderD128';
/** How long each start-up self-test may take, in milliseconds, before ffmpeg is killed. */
export const SELF_TEST_TIMEOUT_MS = 10_000;

const HEAD = ['-hide_banner', '-nostats', '-loglevel', 'error'];
const TESTSRC = ['-f', 'lavfi', '-i', 'testsrc=duration=1:size=1280x720:rate=24'];
const NULL_OUT = ['-f', 'null', '-'];

const QSV_DEVICE = ['-init_hw_device', `vaapi=va:${RENDER_NODE}`, '-init_hw_device', 'qsv=hw@va', '-filter_hw_device', 'hw'];

interface SelfTest {
  readonly codec: EncoderCodec;
  /** For the log: the encoder (and profile) tested. */
  readonly name: string;
  readonly args: readonly string[];
}

/** One second of `testsrc` through each codec's encoder, to nowhere: every codec the backend's levels use. */
const SELF_TESTS: Readonly<Record<'qsv' | 'x264', { readonly backend: EncoderBackend; readonly tests: readonly SelfTest[] }>> = {
  qsv: {
    backend: qsvBackend,
    tests: [
      {
        codec: 'h264',
        name: 'h264_qsv',
        args: [...HEAD, ...QSV_DEVICE, ...TESTSRC, '-vf', 'format=nv12,hwupload=extra_hw_frames=64', '-c:v', 'h264_qsv', ...NULL_OUT],
      },
      {
        codec: 'hevc',
        name: 'hevc_qsv Main10',
        args: [...HEAD, ...QSV_DEVICE, ...TESTSRC, '-vf', 'format=p010le,hwupload=extra_hw_frames=64', '-c:v', 'hevc_qsv', '-profile:v', 'main10', ...NULL_OUT],
      },
    ],
  },
  // libx264 encodes H.264 only: the HEVC levels aren't offered (`x264Backend` refuses them).
  x264: {
    backend: x264Backend,
    tests: [{ codec: 'h264', name: 'libx264', args: [...HEAD, ...TESTSRC, '-c:v', 'libx264', '-preset', 'veryfast', ...NULL_OUT] }],
  },
};

/** The encoder the quality levels use, and the codecs whose self-test passed. */
export interface LevelsEncoder {
  readonly backend: EncoderBackend;
  readonly codecs: ReadonlySet<EncoderCodec>;
}

const CODEC_NAMES: Readonly<Record<EncoderCodec, string>> = { h264: 'H.264', hevc: 'HEVC' };

/** `levelsBackend`'s side effects, replaced in tests. */
export interface BackendCheckDeps {
  /** Starts ffmpeg; defaults to `child_process.spawn`. */
  readonly spawn?: typeof nodeSpawn;
  /** Whether a path exists; defaults to `fs.existsSync`. */
  readonly exists?: (path: string) => boolean;
  /** Receives the one line the check logs; defaults to `console.log`. */
  readonly log?: (message: string) => void;
  /** Injectable for tests; the log still says 10 s. */
  readonly timeoutMs?: number;
}

/** Runs ffmpeg with `args`; null when it exits 0, else why not. */
function run(spawn: typeof nodeSpawn, binary: string, args: readonly string[], timeoutMs: number): Promise<string | null> {
  return new Promise((resolve) => {
    let settled = false;
    const done = (failure: string | null): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(failure);
    };
    let child: ReturnType<typeof nodeSpawn>;
    try {
      child = spawn(binary, [...args], { stdio: ['ignore', 'ignore', 'pipe'] });
    } catch (err) {
      resolve(`ffmpeg did not start: ${(err as Error).message}`);
      return;
    }
    const timer = setTimeout(() => {
      done(`no answer in ${SELF_TEST_TIMEOUT_MS / 1000} s`);
      child.kill('SIGKILL');
    }, timeoutMs);
    let stderr = '';
    child.stderr?.on('data', (chunk: Buffer) => {
      stderr = (stderr + chunk.toString('utf8')).slice(-4096);
    });
    child.on('error', (err) => done(`ffmpeg did not start: ${err.message}`));
    child.on('close', (code: number | null, signal: NodeJS.Signals | null) => {
      if (code === 0) return done(null);
      const last = stderr.trim().split('\n').pop()?.trim();
      done(`${code === null ? `signal ${signal}` : `exit ${code}`}${last ? `: ${last}` : ''}`);
    });
  });
}

/**
 * The encoder the quality levels use, or null for Original only: `LEVELS_BACKEND=off`; `qsv` without the
 * render node; or when every codec's 1 s `testsrc` encode fails or takes over 10 s. `qsv` tests H.264 and HEVC Main10,
 * and offers the codecs that pass; `x264` tests and offers H.264 only. The backend runs `FFMPEG_PATH`. Logs one line.
 */
export async function levelsBackend(config: Pick<LevelsConfig, 'backend' | 'ffmpegPath'>, deps: BackendCheckDeps = {}): Promise<LevelsEncoder | null> {
  const log = deps.log ?? console.log;
  if (config.backend === 'off') {
    log('quality levels: off (LEVELS_BACKEND=off); only Original is offered');
    return null;
  }
  if (config.backend === 'qsv' && !(deps.exists ?? existsSync)(RENDER_NODE)) {
    log(`quality levels: off; no ${RENDER_NODE} for Quick Sync, so only Original is offered`);
    return null;
  }
  const { backend, tests } = SELF_TESTS[config.backend];
  const started = Date.now();
  const codecs = new Set<EncoderCodec>();
  const failures: string[] = [];
  for (const test of tests) {
    const failure = await run(deps.spawn ?? nodeSpawn, config.ffmpegPath, test.args, deps.timeoutMs ?? SELF_TEST_TIMEOUT_MS);
    if (failure === null) codecs.add(test.codec);
    else failures.push(`the ${test.name} self-test failed (${failure})`);
  }
  if (codecs.size === 0) {
    log(`quality levels: off; ${failures.join(', and ')}, so only Original is offered`);
    return null;
  }
  const only = codecs.size < 2 ? `, ${[...codecs].map((c) => CODEC_NAMES[c]).join('')} only` : '';
  if (failures.length > 0) log(`quality levels: ${config.backend}${only}; ${failures.join(', and ')}`);
  else {
    const names = tests.map((t) => t.name);
    const passed = names.length > 1 ? `${names.join(' and ')} self-tests passed` : `${names[0]} self-test passed`;
    log(`quality levels: ${config.backend}${only} (${passed} in ${Date.now() - started} ms)`);
  }
  return { backend: { ...backend, binary: config.ffmpegPath }, codecs };
}
