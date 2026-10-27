import { describe, expect, it } from 'vitest';
import { muxM2ts, type MuxUnit } from '../../../tests/helpers/ts-muxer';
import { FileSource } from '../disc/file-source';
import { M2tsReader, type M2tsReaderOptions } from './m2ts-reader';
import type { PesPacket } from './pes-assembler';

const PATH = 'BDMV/STREAM/00001.M2TS';
const VIDEO = 0x1011;
const AUDIO = 0x1100;

function clip(withAudio: boolean): { source: FileSource; units: MuxUnit[]; unitSpns: number[]; bytes: Uint8Array<ArrayBuffer> } {
  const units: MuxUnit[] = [];
  for (let i = 0; i < 40; i++) {
    units.push({ pid: VIDEO, streamId: 0xe0, pts: 900_000 + i * 3750, payload: new Uint8Array(1000).fill(i) });
    if (withAudio) units.push({ pid: AUDIO, streamId: 0xbd, pts: 900_000 + i * 3750, payload: new Uint8Array(100).fill(i) });
  }
  const { bytes, unitSpns } = muxM2ts(units);
  return { source: new FileSource(new Map([[PATH, new Blob([bytes])]])), units, unitSpns, bytes };
}

async function readAll(opts: M2tsReaderOptions): Promise<PesPacket[]> {
  const reader = new M2tsReader(opts);
  const out: PesPacket[] = [];
  for (let batch = await reader.next(); batch !== null; batch = await reader.next()) out.push(...batch);
  return out;
}

describe('M2tsReader', () => {
  it('reads every selected PES across small chunks', async () => {
    const { source, units } = clip(true);
    const out = await readAll({ source, path: PATH, startSpn: 0, pids: new Set([VIDEO]), chunkPackets: 32 });
    expect(out.map((p) => p.pts)).toEqual(units.filter((u) => u.pid === VIDEO).map((u) => u.pts));
  });

  it('starts at the aligned unit containing startSpn and skips partial PES', async () => {
    const { source, units, unitSpns } = clip(false);
    const startSpn = unitSpns[20];
    const aligned = Math.floor(startSpn / 32) * 32;
    const out = await readAll({ source, path: PATH, startSpn, pids: new Set([VIDEO]), chunkPackets: 64 });
    const expected = units.filter((_, i) => unitSpns[i] >= aligned).map((u) => u.pts);
    expect(out.map((p) => p.pts)).toEqual(expected);
    expect(out.some((p) => p.pts === units[20].pts)).toBe(true);
  });

  it('with a lead-in passes only its PIDs before startSpn, and the others exactly as a read from startSpn', async () => {
    const { source, units, unitSpns } = clip(true);
    const startSpn = unitSpns[40]!; // unit 20's video
    const lead = { fromSpn: unitSpns[10]!, pids: new Set([AUDIO]) };
    const pids = new Set([VIDEO, AUDIO]);
    const plain = await readAll({ source, path: PATH, startSpn, pids, chunkPackets: 64 });
    const out = await readAll({ source, path: PATH, startSpn, pids, lead, chunkPackets: 64 });
    expect(out.filter((p) => p.pid === VIDEO).map((p) => p.pts)).toEqual(plain.filter((p) => p.pid === VIDEO).map((p) => p.pts));
    const leadFrom = Math.floor(lead.fromSpn / 32) * 32;
    const audio = units.filter((u, i) => u.pid === AUDIO && unitSpns[i]! >= leadFrom).map((u) => u.pts);
    expect(out.filter((p) => p.pid === AUDIO).map((p) => p.pts)).toEqual(audio);
    expect(audio.length).toBeGreaterThan(plain.filter((p) => p.pid === AUDIO).length);
  });

  it('stops at endSpn', async () => {
    const { source, units, unitSpns } = clip(false);
    const out = await readAll({ source, path: PATH, startSpn: 0, endSpn: unitSpns[10], pids: new Set([VIDEO]) });
    expect(out.map((p) => p.pts)).toEqual(units.slice(0, 10).map((u) => u.pts));
  });

  it('discards a PES cut short by endSpn instead of emitting it truncated', async () => {
    const { source, units, unitSpns } = clip(false);
    const out = await readAll({ source, path: PATH, startSpn: 0, endSpn: unitSpns[10] + 2, pids: new Set([VIDEO]) });
    expect(out.map((p) => p.pts)).toEqual(units.slice(0, 10).map((u) => u.pts));
  });

  it('counts corrupt packets and keeps going', async () => {
    const { bytes, units } = clip(false);
    bytes[192 * 3 + 4] = 0x00; // break one packet inside the first PES
    const source = new FileSource(new Map([[PATH, new Blob([bytes])]]));
    const reader = new M2tsReader({ source, path: PATH, startSpn: 0, pids: new Set([VIDEO]) });
    const out: PesPacket[] = [];
    for (let batch = await reader.next(); batch !== null; batch = await reader.next()) out.push(...batch);
    expect(reader.stats.corruptPackets).toBe(1);
    expect(reader.stats.continuityErrors).toBe(1);
    expect(out.map((p) => p.pts)).toEqual(units.slice(1).map((u) => u.pts));
  });

  it('cancel() aborts the in-flight prefetch and ends the reader', async () => {
    const { source } = clip(true);
    const signals: AbortSignal[] = [];
    const spy = { ...source, exists: source.exists.bind(source), size: source.size.bind(source), list: source.list.bind(source),
      read: (path: string, offset: number, length: number, signal?: AbortSignal) => {
        if (signal) signals.push(signal);
        return source.read(path, offset, length, signal);
      },
    };
    const reader = new M2tsReader({ source: spy, path: PATH, startSpn: 0, pids: new Set([VIDEO]), chunkPackets: 32 });
    expect(await reader.next()).not.toBeNull();
    expect(signals.length).toBeGreaterThanOrEqual(2); // the first chunk and its prefetch
    reader.cancel();
    expect(signals.every((s) => s.aborted)).toBe(true);
    expect(await reader.next()).toBeNull();
  });

  it('returns null instead of data when cancelled during a read', async () => {
    const { source } = clip(true);
    let release: () => void = () => undefined;
    const gate = new Promise<void>((r) => (release = r));
    const slow = { exists: source.exists.bind(source), size: source.size.bind(source), list: source.list.bind(source),
      read: async (path: string, offset: number, length: number) => {
        await gate; // ignores the signal, like a read that finishes anyway
        return source.read(path, offset, length);
      },
    };
    const reader = new M2tsReader({ source: slow, path: PATH, startSpn: 0, pids: new Set([VIDEO]), chunkPackets: 32 });
    const pending = reader.next();
    reader.cancel();
    release();
    expect(await pending).toBeNull();
  });
});
