// SPDX-License-Identifier: LGPL-3.0-or-later
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { afterAll, describe, expect, it } from 'vitest';
import { loadPlaylist } from '../../src/disc/playlist';
import { audioTrackIndex, PmtError, readPlaylistPmts, readPmt } from '../../src/disc/pmt';
import { nullPacket, patSection, pmtSection, psiPackets } from '../helpers/psi';
import { haveTools, toolPaths } from '../helpers/tools';
import { fx } from '../paths';

const dir = mkdtempSync(join(tmpdir(), 'pmt-test-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

function clipFile(name: string, packets: Uint8Array[]): string {
  const file = join(dir, name);
  writeFileSync(file, Buffer.concat(packets));
  return file;
}

const disc3Clip = fx('fixtures/disc3/BDMV/STREAM/00001.m2ts');

describe('readPmt', () => {
  it("reads disc3's PMT in order", async () => {
    const pmt = await readPmt(disc3Clip);
    expect(pmt.streams).toEqual([
      { pid: 0x1011, streamType: 0x1b },
      { pid: 0x1100, streamType: 0x80 },
      { pid: 0x1101, streamType: 0x81 },
      { pid: 0x1102, streamType: 0x83 },
      { pid: 0x1103, streamType: 0x82 },
    ]);
    expect(pmt.pmtPid).toBe(0x100);
    expect(pmt.hdmv).toBe(true);
  });

  it('finds the PAT and PMT at the start of every encoder fixture clip', async () => {
    for (const disc of ['disc1', 'disc1-late', 'disc-speech', 'disc3', 'disc-subs']) {
      const pmts = await readPlaylistPmts(await loadPlaylist(fx(`fixtures/${disc}`), '00000'));
      expect([...pmts.values()].every((p) => p.streams.length > 1), disc).toBe(true);
    }
  });

  it('reads a PMT section that spans two packets, after a network PID entry', async () => {
    const streams = Array.from({ length: 40 }, (_, i) => ({ pid: 0x1100 + i, streamType: 0x81 }));
    const file = clipFile('long.m2ts', [
      ...psiPackets(0, patSection([{ program: 0, pmtPid: 0x10 }, { program: 7, pmtPid: 0x200 }])),
      nullPacket(),
      ...psiPackets(0x200, pmtSection({ program: 7, pcrPid: 0x1011, streams })),
    ]);
    const pmt = await readPmt(file);
    expect(pmt.pmtPid).toBe(0x200);
    expect(pmt.streams).toEqual(streams);
  });

  it('skips a section whose CRC is wrong', async () => {
    const bad = psiPackets(0, patSection([{ program: 1, pmtPid: 0x300 }]));
    bad[0]![22] ^= 0xff; // inside the CRC_32 (the section starts at byte 9)
    const file = clipFile('crc.m2ts', [
      ...bad,
      ...psiPackets(0, patSection([{ program: 1, pmtPid: 0x100 }])),
      ...psiPackets(0x100, pmtSection({ pcrPid: 0x1011, streams: [{ pid: 0x1011, streamType: 0x1b }] })),
    ]);
    expect((await readPmt(file)).pmtPid).toBe(0x100);
  });

  it('fails on a clip with no PMT in its first packets', async () => {
    const late = clipFile('late.m2ts', [
      ...Array.from({ length: 20 }, nullPacket),
      ...psiPackets(0, patSection([{ program: 1, pmtPid: 0x100 }])),
      ...psiPackets(0x100, pmtSection({ pcrPid: 0x1011, streams: [{ pid: 0x1011, streamType: 0x1b }] })),
    ]);
    await expect(readPmt(late, 10)).rejects.toThrow(PmtError);
    await expect(readPmt(late, 10)).rejects.toThrow(/late\.m2ts.*no PAT.*first 10 packets/);
    expect((await readPmt(late)).pmtPid).toBe(0x100);

    const noPmt = clipFile('no-pmt.m2ts', [...psiPackets(0, patSection([{ program: 1, pmtPid: 0x100 }])), nullPacket()]);
    await expect(readPmt(noPmt)).rejects.toThrow(/no-pmt\.m2ts.*no PMT.*0x0100/);
  });
});

describe('audioTrackIndex', () => {
  const pmt = {
    pmtPid: 0x100,
    hdmv: true,
    streams: [
      { pid: 0x1011, streamType: 0x1b },
      { pid: 0x1200, streamType: 0x90 },
      { pid: 0x1101, streamType: 0x81 },
      { pid: 0x1100, streamType: 0x80 },
      { pid: 0x1a00, streamType: 0xa1 },
    ],
  };

  it('counts only audio stream types, in PMT order, from 1', () => {
    expect(audioTrackIndex(pmt, 0x1101)).toBe(1);
    expect(audioTrackIndex(pmt, 0x1100)).toBe(2);
    expect(audioTrackIndex(pmt, 0x1a00)).toBe(3);
  });

  it('counts the AC-3 stream libavformat adds after each TrueHD stream of an HDMV program', () => {
    const streams = [
      { pid: 0x1100, streamType: 0x83 },
      { pid: 0x1101, streamType: 0x82 },
      { pid: 0x1102, streamType: 0x83 },
      { pid: 0x1103, streamType: 0x81 },
    ];
    expect(streams.map((s) => audioTrackIndex({ pmtPid: 0x100, hdmv: true, streams }, s.pid))).toEqual([1, 3, 4, 6]);
    expect(streams.map((s) => audioTrackIndex({ pmtPid: 0x100, hdmv: false, streams }, s.pid))).toEqual([1, 2, 3, 4]);
  });

  it('fails when the PMT lacks a planned PID, naming it and the PMT PIDs', () => {
    expect(() => audioTrackIndex(pmt, 0x1104)).toThrow(PmtError);
    expect(() => audioTrackIndex(pmt, 0x1104)).toThrow(/0x1104.*0x1011, 0x1200, 0x1101, 0x1100, 0x1a00/);
    expect(() => audioTrackIndex(pmt, 0x1200)).toThrow(/0x1200/);
  });
});

describe.skipIf(!haveTools)('with BestSource', () => {
  it("opens each of disc3's PIDs at its track number", async () => {
    // libavformat's view of disc3 (ffprobe): LPCM stereo, AC-3 5.1, TrueHD stereo with its AC-3 core, DTS 5.1.
    const pmt = await readPmt(disc3Clip);
    const channels = (pid: number): number => {
      const script = join(dir, `track-${pid}.vpy`);
      writeFileSync(
        script,
        ['import vapoursynth as vs', `vs.core.bs.AudioSource(r'${disc3Clip}', track=-${audioTrackIndex(pmt, pid)}, cachemode=0).set_output(0)`, ''].join('\n'),
      );
      const info = execFileSync(toolPaths()!.vspipe, ['--info', script, '-'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
      return Number(/Channels: (\d+)/.exec(info)?.[1]);
    };
    expect([0x1100, 0x1101, 0x1102, 0x1103].map(channels)).toEqual([2, 6, 2, 6]);
  }, 120000);
});
