// SPDX-License-Identifier: LGPL-3.0-or-later
import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import type { Readable } from 'node:stream';
import { guardWav, type WavExpectation } from './wav-guard';

// Video and audio travel through two-process pipelines with no intermediate files: `vspipe` runs
// a VapourSynth script and writes raw frames (Y4M) or samples (WAV) to its stdout, which is piped
// into the encoder's stdin (SvtAv1EncApp or opusenc); the encoder's stdout is what the muxer reads.

/** Absolute paths (or bare names found on PATH) of the three external tools. */
export interface ToolPaths {
  vspipe: string;
  /** SvtAv1EncApp, the SVT-AV1 command-line encoder. */
  svt: string;
  opusenc: string;
}

/** A tool in a chain exited with an error or could not start; carries the tool's last stderr output. */
export class ChainError extends Error {
  constructor(
    public tool: string,
    public code: number | null,
    public signal: NodeJS.Signals | null,
    public stderrTail: string,
  ) {
    super(
      `${tool} failed (${signal !== null ? `signal ${signal}` : `exit code ${String(code)}`})` +
        (stderrTail !== '' ? `: ${stderrTail.trim()}` : ''),
    );
    this.name = 'ChainError';
  }
}

/**
 * A running two-process pipeline. Failure of either process kills the other and rejects `done`;
 * success needs both processes to exit with code 0 and `stream` to end.
 */
export interface Chain {
  /** Last process's stdout. It ends cleanly even on failure, so consumers must await `done` to learn the outcome.
   * `done` cannot settle successfully until the consumer drains this stream. */
  stream: Readable;
  /** Settles once both processes are finished: resolves on success, rejects with a `ChainError` (or the abort reason). */
  done: Promise<void>;
  /** Stops both processes and rejects `done` with `reason`, unless it has already settled. */
  abort(reason: Error): void;
  /**
   * Resolves once both processes have exited (or could not start), whatever the outcome. A process that ignores
   * SIGTERM is killed after five seconds. `abort` does not wait for this; a caller that must leave no process
   * behind does.
   */
  exited: Promise<void>;
}

const STDERR_TAIL_BYTES = 4096;
const KILL_AFTER_MS = 5000;

interface Stage {
  name: string;
  cmd: string;
  args: string[];
}

/**
 * Runs `first | second`. `between`, when given, wraps the first process's stdout before it reaches the second's
 * stdin (a check on the stream); an error it raises fails the chain with that error and stops both processes,
 * except that an error raised after the first process's output ended or broke waits for that process to exit, and
 * gives way to its `ChainError` when it exits with an error.
 */
function runChain(first: Stage, second: Stage, between?: (out: Readable) => Readable): Chain {
  const p1: ChildProcess = spawn(first.cmd, first.args, { stdio: ['ignore', 'pipe', 'pipe'] });
  const p2: ChildProcess = spawn(second.cmd, second.args, { stdio: ['pipe', 'pipe', 'pipe'] });
  const procs = [p1, p2];
  const names = [first.name, second.name];
  const tails: Buffer[] = [Buffer.alloc(0), Buffer.alloc(0)];

  const out1 = p1.stdout as Readable;
  const in2 = p2.stdin as NodeJS.WritableStream;
  const stream = p2.stdout as Readable;

  // The second process may die before consuming everything; the exit codes report the real failure.
  out1.on('error', () => {});
  in2.on('error', () => {});
  const into2 = between === undefined ? out1 : between(out1);

  let settled = false;
  let resolveDone!: () => void;
  let rejectDone!: (e: Error) => void;
  const done = new Promise<void>((res, rej) => {
    resolveDone = res;
    rejectDone = rej;
  });

  // Mark handled so a rejection before the caller attaches does not raise unhandledRejection;
  // callers awaiting `done` still observe it.
  done.catch(() => {});

  const alive = (p: ChildProcess): boolean => p.exitCode === null && p.signalCode === null;
  const exited_ = Promise.all(
    procs.map((p) => new Promise<void>((res) => {
      // 'exit', not 'close': a stdout nobody reads any more never closes.
      p.once('exit', () => res());
      p.once('error', () => {
        // A process that never started never closes.
        if (p.pid === undefined) res();
      });
    })),
  ).then(() => {});
  const killAll = (): void => {
    for (const p of procs) if (alive(p)) p.kill('SIGTERM');
    const timer = setTimeout(() => {
      for (const p of procs) if (alive(p)) p.kill('SIGKILL');
    }, KILL_AFTER_MS);
    timer.unref();
    void exited_.then(() => clearTimeout(timer));
  };
  const fail = (err: Error): void => {
    if (settled) return;
    settled = true;
    killAll();
    rejectDone(err);
  };

  if (into2 !== out1) {
    into2.on('error', (e: Error) => {
      // An error raised once the first process's output has ended or broken (a WAV cut short, say) is
      // usually that process failing: let its exit decide. A nonzero exit fails the chain with the
      // tool's own ChainError (from the exit handler below); a clean exit fails it with this error.
      if (!(out1.readableEnded || out1.destroyed)) return fail(e);
      if (p1.exitCode !== null || p1.signalCode !== null) {
        if (p1.exitCode === 0) fail(e);
        return;
      }
      p1.once('exit', (code) => {
        if (code === 0) fail(e);
      });
    });
  }
  into2.pipe(in2);

  procs.forEach((p, i) => {
    (p.stderr as Readable).on('data', (d: Buffer) => {
      const all = Buffer.concat([tails[i], d]);
      tails[i] = all.length > STDERR_TAIL_BYTES ? all.subarray(all.length - STDERR_TAIL_BYTES) : all;
    });
  });

  const exited = [false, false];
  let streamEnded = false;
  const check = (): void => {
    if (!settled && exited[0] && exited[1] && streamEnded) {
      settled = true;
      resolveDone();
    }
  };

  procs.forEach((p, i) => {
    p.on('error', (e: Error) => {
      fail(new ChainError(names[i], null, null, `${e.message}\n${tails[i].toString('utf8')}`));
    });
    p.on('exit', (code, signal) => {
      if (code !== 0) {
        // stdio may not be drained at 'exit'; wait for stderr to finish (bounded) so the tail is complete.
        const stderr = p.stderr as Readable;
        const finish = (): void => fail(new ChainError(names[i], code, signal, tails[i].toString('utf8')));
        if (stderr.destroyed || stderr.readableEnded) {
          finish();
          return;
        }
        const timer = setTimeout(finish, 500);
        stderr.once('close', () => {
          clearTimeout(timer);
          finish();
        });
        return;
      }
      exited[i] = true;
      check();
    });
  });

  const onEnd = (): void => {
    streamEnded = true;
    check();
  };
  stream.on('end', onEnd);
  stream.on('close', onEnd);

  return {
    stream,
    done,
    abort(reason: Error): void {
      fail(reason);
    },
    exited: exited_,
  };
}

/**
 * `vspipe script.vpy - -c y4m | SvtAv1EncApp -i stdin -b stdout <svtArgs>`: the script's video as
 * a Y4M stream (YUV4MPEG2) into SVT-AV1, whose stdout is an IVF stream of AV1 packets.
 */
export function videoChain(tools: ToolPaths, scriptPath: string, svtArgs: string[]): Chain {
  return runChain(
    { name: 'vspipe', cmd: tools.vspipe, args: [scriptPath, '-', '-c', 'y4m'] },
    { name: 'SvtAv1EncApp', cmd: tools.svt, args: ['-i', 'stdin', '-b', 'stdout', ...svtArgs] },
  );
}

/**
 * `vspipe script.vpy - -c wav | guardWav | opusenc <opusArgs> - -`: the script's audio as WAV into opusenc, whose
 * stdout is an Ogg Opus stream. The WAV passes through `guardWav` with `expected` on its way, so a header that does
 * not match the stream the script was meant to decode rejects `done` with a `WavGuardError` naming the PID and
 * stops both processes before opusenc encodes anything.
 */
export function audioChain(tools: ToolPaths, scriptPath: string, opusArgs: string[], expected: WavExpectation): Chain {
  return runChain(
    { name: 'vspipe', cmd: tools.vspipe, args: [scriptPath, '-', '-c', 'wav'] },
    { name: 'opusenc', cmd: tools.opusenc, args: [...opusArgs, '-', '-'] },
    (out) => guardWav(out, expected),
  );
}
