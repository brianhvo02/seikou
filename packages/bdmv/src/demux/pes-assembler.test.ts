import { describe, expect, it } from 'vitest';
import { muxM2ts, type MuxUnit } from '../../../../tests/helpers/ts-muxer';
import { PesAssembler, type PesPacket } from './pes-assembler';
import { parseSourcePacket, type TsPacket } from './ts-packet';

function packetsOf(bytes: Uint8Array): TsPacket[] {
  const out: TsPacket[] = [];
  for (let o = 0; o < bytes.length; o += 192) {
    const p = parseSourcePacket(bytes, o);
    if (p && p.pid !== 0x1fff) out.push(p);
  }
  return out;
}

function demuxAll(bytes: Uint8Array): PesPacket[] {
  const out: PesPacket[] = [];
  const assembler = new PesAssembler((p) => out.push(p));
  for (const packet of packetsOf(bytes)) assembler.push(packet);
  assembler.flush();
  return out;
}

const units: MuxUnit[] = [
  { pid: 0x1011, streamId: 0xe0, pts: 903_600, dts: 900_000, payload: new Uint8Array(500).fill(1) },
  { pid: 0x1100, streamId: 0xbd, pts: 900_000, payload: new Uint8Array(40).fill(2) },
  { pid: 0x1011, streamId: 0xe0, pts: 907_200, payload: new Uint8Array(10).fill(3) },
];

describe('PesAssembler', () => {
  it('hands over a PES with a declared length once it is complete, without waiting for the next unit start (m2ts_demux)', () => {
    const out: PesPacket[] = [];
    const asm = new PesAssembler((p) => out.push(p));
    const ig: MuxUnit = { pid: 0x1400, streamId: 0xbd, pts: 900_000, payload: new Uint8Array(400).fill(7) };
    for (const p of packetsOf(muxM2ts([ig]).bytes)) asm.push(p);
    expect(out.map((p) => [p.pid, p.pts, p.payload.length])).toEqual([[0x1400, 900_000, 400]]);
    asm.flush();
    expect(out).toHaveLength(1); // not emitted twice
  });


  it('reassembles PES packets per PID with PTS and DTS', () => {
    const out: PesPacket[] = [];
    const asm = new PesAssembler((p) => out.push(p));
    for (const p of packetsOf(muxM2ts(units).bytes)) asm.push(p);
    asm.flush();
    // Every PES here declares its length, so each one is handed over with its last packet, in stream order.
    expect(out.map((p) => [p.pid, p.pts, p.dts, p.payload.length, p.payload[0]])).toEqual([
      [0x1011, 903_600, 900_000, 500, 1],
      [0x1100, 900_000, undefined, 40, 2],
      [0x1011, 907_200, undefined, 10, 3],
    ]);
  });

  it('handles timestamps above 2^32', () => {
    const out: PesPacket[] = [];
    const asm = new PesAssembler((p) => out.push(p));
    const pts = 2 ** 33 - 90_000;
    for (const p of packetsOf(muxM2ts([{ pid: 0x1011, streamId: 0xe0, pts, payload: new Uint8Array(4) }]).bytes)) asm.push(p);
    asm.flush();
    expect(out[0].pts).toBe(pts);
  });

  it('drops a PES with a continuity gap and counts it', () => {
    const out: PesPacket[] = [];
    const asm = new PesAssembler((p) => out.push(p));
    const packets = packetsOf(muxM2ts(units).bytes);
    asm.push(packets[0]);
    asm.push(packets[2]); // skip packets[1] (second packet of the first video PES)
    for (const p of packets.slice(3)) asm.push(p);
    asm.flush();
    expect(asm.continuityErrors).toBe(1);
    expect(out.map((p) => p.pts)).toEqual([900_000, 907_200]); // the broken video PES is dropped; the rest in completion order
  });

  it('discards a PES whose last packet is lost before the next unit start', () => {
    const out: PesPacket[] = [];
    const asm = new PesAssembler((p) => out.push(p));
    const spanning: MuxUnit[] = [
      { pid: 0x1011, streamId: 0xe0, pts: 900_000, payload: new Uint8Array(400).fill(1) },
      { pid: 0x1011, streamId: 0xe0, pts: 903_600, payload: new Uint8Array(10).fill(2) },
    ];
    const packets = packetsOf(muxM2ts(spanning).bytes);
    expect(packets.slice(0, 3).map((p) => p.payloadUnitStart)).toEqual([true, false, false]);
    for (const p of packets.slice(0, 2)) asm.push(p); // lose the last packet of the first PES
    for (const p of packets.slice(3)) asm.push(p);
    asm.flush();
    expect(asm.continuityErrors).toBe(1);
    expect(out.map((p) => [p.pts, p.payload.length, p.payload[0]])).toEqual([[903_600, 10, 2]]);
  });

  it('ignores a PES joined mid-way', () => {
    const out: PesPacket[] = [];
    const asm = new PesAssembler((p) => out.push(p));
    for (const p of packetsOf(muxM2ts(units).bytes).slice(1)) asm.push(p);
    asm.flush();
    expect(out.map((p) => p.pid)).toEqual([0x1100, 0x1011]);
  });

  it('reads stream_id_extension from 0xFD packets (TrueHD and its AC-3 core)', () => {
    const { bytes } = muxM2ts([
      { pid: 0x1100, streamId: 0xfd, streamIdExtension: 0x76, pts: 90_000, payload: new Uint8Array([0x0b, 0x77, 1, 2]) },
      { pid: 0x1100, streamId: 0xfd, streamIdExtension: 0x72, pts: 90_450, payload: new Uint8Array([0xf8, 0x72, 0x6f, 0xba]) },
      { pid: 0x1101, streamId: 0xbd, pts: 90_000, payload: new Uint8Array([9, 9]) },
    ]);
    const pes = demuxAll(bytes);
    expect(pes.map((p) => [p.pid, p.streamId, p.streamIdExtension, p.pts, [...p.payload]])).toEqual([
      [0x1100, 0xfd, 0x76, 90_000, [0x0b, 0x77, 1, 2]],
      [0x1100, 0xfd, 0x72, 90_450, [0xf8, 0x72, 0x6f, 0xba]],
      [0x1101, 0xbd, undefined, 90_000, [9, 9]],
    ]);
  });
});
