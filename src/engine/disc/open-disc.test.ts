import { describe, expect, it } from 'vitest';
import { buildClpi, buildIndex, buildMpls, buildSoundBdmv } from '../../../tests/helpers/bdmv-builders';
import { asm, buildMovieObjects } from '../../../tests/helpers/hdmv-builders';
import { CodingType } from '@seikou/bdmv/stream-types';
import { DiscError } from '@seikou/bdmv/byte-source';
import { FileSource } from './file-source';
import { checkStreamReadable, loadClips, openDisc, readBdid } from './open-disc';
import { normalizeDiscPaths } from './paths';

const VIDEO = [{ pid: 0x1011, codingType: CodingType.AVC }];

function m2ts(packets: number, syncedPackets = packets): Uint8Array<ArrayBuffer> {
  const bytes = new Uint8Array(packets * 192);
  for (let k = 0; k < syncedPackets; k++) bytes[k * 192 + 4] = 0x47;
  return bytes;
}

function clpi(): Uint8Array<ArrayBuffer> {
  return buildClpi({ numSourcePackets: 64, streams: VIDEO, presentationStart: 0, presentationEnd: 45_000, epMaps: [{ pid: 0x1011, entries: [{ pts: 0, spn: 0 }] }] });
}

function disc(files: Record<string, Uint8Array<ArrayBuffer>>): FileSource {
  return new FileSource(normalizeDiscPaths(Object.entries(files).map(([p, b]) => [p, new Blob([b])] as const)));
}

function baseFiles(): Record<string, Uint8Array<ArrayBuffer>> {
  return {
    'Movie/BDMV/index.bdmv': buildIndex({ firstPlay: { kind: 'hdmv', movieObjectId: 0 }, topMenu: { kind: 'hdmv', movieObjectId: 1 }, titles: [] }),
    'Movie/BDMV/PLAYLIST/00000.mpls': buildMpls({
      playItems: [
        { clipId: '00001', inTime: 0, outTime: 450_000, video: VIDEO },
        { clipId: '00002', inTime: 0, outTime: 225_000, video: VIDEO },
      ],
      marks: [
        { playItemRef: 0, time: 0 },
        { playItemRef: 1, time: 0 },
        { playItemRef: 1, time: 100, type: 2 },
      ],
    }),
    'Movie/BDMV/PLAYLIST/00001.mpls': buildMpls({ playItems: [{ clipId: '00002', inTime: 0, outTime: 45_000, video: VIDEO }] }),
    'Movie/BDMV/CLIPINF/00001.clpi': clpi(),
    'Movie/BDMV/CLIPINF/00002.clpi': clpi(),
    'Movie/BDMV/STREAM/00001.m2ts': m2ts(64),
    'Movie/BDMV/STREAM/00002.m2ts': m2ts(64),
  };
}

describe('openDisc', () => {
  it('summarizes playlists longest first', async () => {
    const model = await openDisc(disc(baseFiles()));
    expect(model.usesBdj).toBe(false);
    expect(model.summaries.map((s) => [s.id, s.durationUs, s.chapterCount, s.playable])).toEqual([
      ['00000', 15_000_000, 2, true],
      ['00001', 1_000_000, 0, true],
    ]);
    expect(model.summaries[0].clipIds).toEqual(['00001', '00002']);
    expect(model.playlists.get('00000')?.playItems).toHaveLength(2);
  });

  it('lists the main feature first and a longer loop playlist last, still listed', async () => {
    const files = baseFiles();
    const segment = { clipId: '00002', inTime: 0, outTime: 45_000, video: VIDEO };
    files['Movie/BDMV/PLAYLIST/00149.mpls'] = buildMpls({ playItems: Array.from({ length: 30 }, () => segment) }); // 30 s, longer than 00000
    const model = await openDisc(disc(files));
    expect(model.summaries.map((s) => [s.id, s.looped])).toEqual([
      ['00000', false],
      ['00001', false],
      ['00149', true],
    ]);
  });

  it('marks playlists with missing clip files as not playable', async () => {
    const files = baseFiles();
    delete files['Movie/BDMV/STREAM/00002.m2ts'];
    const model = await openDisc(disc(files));
    expect(model.summaries.every((s) => !s.playable)).toBe(true);
    expect(model.summaries[0].missingPaths).toEqual(['BDMV/STREAM/00002.M2TS']);
  });

  it('rejects a folder without index.bdmv', async () => {
    const files = baseFiles();
    delete files['Movie/BDMV/index.bdmv'];
    await expect(openDisc(disc(files))).rejects.toMatchObject({ code: 'not-bdmv', paths: ['BDMV/INDEX.BDMV'] });
  });

  it('skips damaged playlists with a warning', async () => {
    const files = baseFiles();
    files['Movie/BDMV/PLAYLIST/00001.mpls'] = new Uint8Array([0x4d, 0x50]);
    const model = await openDisc(disc(files));
    expect(model.summaries.map((s) => s.id)).toEqual(['00000']);
    expect(model.warnings[0]).toContain('00001');
  });

  it('reports an encrypted disc when AACS is present and the stream does not parse', async () => {
    const files = baseFiles();
    files['Movie/BDMV/STREAM/00001.m2ts'] = m2ts(64, 1);
    files['Movie/AACS/Unit_Key_RO.inf'] = new Uint8Array(16);
    await expect(openDisc(disc(files))).rejects.toMatchObject({ code: 'encrypted' });
  });

  it('reports an unreadable stream when it does not parse and there is no AACS folder', async () => {
    const files = baseFiles();
    files['Movie/BDMV/STREAM/00001.m2ts'] = m2ts(64, 1);
    await expect(checkStreamReadable(disc(files), '00001')).rejects.toBeInstanceOf(DiscError);
    await expect(checkStreamReadable(disc(files), '00001')).rejects.toMatchObject({ code: 'unreadable-stream' });
  });

  it('loads clip info for a list of clips', async () => {
    const clips = await loadClips(disc(baseFiles()), ['00001', '00002']);
    expect([...clips.keys()]).toEqual(['00001', '00002']);
    expect(clips.get('00001')?.epMaps[0].entries).toEqual([{ pts: 0, spn: 0 }]);
  });

  /** A source whose reads of `failing` reject: the first-by-name late, the others at once. */
  function failingReads(source: FileSource, failing: readonly string[]): FileSource {
    const read = source.read.bind(source);
    source.read = (path, offset, length, signal) => {
      const i = failing.indexOf(path);
      if (i < 0) return read(path, offset, length, signal);
      return new Promise((_, reject) => setTimeout(() => reject(new Error(`unreadable ${path}`)), i === 0 ? 20 : 0));
    };
    return source;
  }

  it('reports the first unreadable playlist by name, though its read fails last', async () => {
    const source = failingReads(disc(baseFiles()), ['BDMV/PLAYLIST/00000.MPLS', 'BDMV/PLAYLIST/00001.MPLS']);
    await expect(openDisc(source)).rejects.toThrow('unreadable BDMV/PLAYLIST/00000.MPLS');
  });

  it('reports the first unreadable clip info by name, though its read fails last', async () => {
    const failing = ['BDMV/CLIPINF/00001.CLPI', 'BDMV/CLIPINF/00002.CLPI'];
    await expect(loadClips(failingReads(disc(baseFiles()), failing), ['00001', '00002'])).rejects.toThrow('unreadable BDMV/CLIPINF/00001.CLPI');
    const files = { ...baseFiles(), 'Movie/BDMV/MovieObject.bdmv': buildMovieObjects([{ cmds: [asm.nop()] }]) };
    await expect(openDisc(failingReads(disc(files), failing))).rejects.toThrow('unreadable BDMV/CLIPINF/00001.CLPI');
  });

  it('loads movie objects and sounds', async () => {
    const files = baseFiles();
    files['Movie/BDMV/MovieObject.bdmv'] = buildMovieObjects([{ cmds: [asm.nop()] }]);
    files['Movie/BDMV/AUXDATA/sound.bdmv'] = buildSoundBdmv([{ channels: 1, samples: Int16Array.of(5) }]);
    const model = await openDisc(disc(files));
    expect(model.movieObjects?.objects.length).toBeGreaterThan(0);
    expect([...(model.sounds?.clips[0].samples ?? [])]).toEqual([5]);
    expect(model.warnings).toEqual([]);
  });

  it('ignores a damaged MovieObject.bdmv with a warning', async () => {
    const files = baseFiles();
    files['Movie/BDMV/MovieObject.bdmv'] = new Uint8Array([0x4d, 0x4f]);
    const model = await openDisc(disc(files));
    expect(model.movieObjects).toBeNull();
    expect(model.warnings[0]).toMatch(/^MovieObject\.bdmv/);
  });

  it('opens a BD-J disc without reading id.bdmv, even when it cannot be read', async () => {
    const files = baseFiles();
    files['Movie/BDMV/index.bdmv'] = buildIndex({ firstPlay: { kind: 'bdj', name: '00000' }, topMenu: { kind: 'hdmv', movieObjectId: 0 }, titles: [] });
    files['Movie/CERTIFICATE/id.bdmv'] = new Uint8Array(104);
    const source = disc(files);
    const read = source.read.bind(source);
    source.read = (path, offset, length, signal) =>
      path === 'CERTIFICATE/ID.BDMV' ? Promise.reject(new Error('unreadable')) : read(path, offset, length, signal);
    const model = await openDisc(source);
    expect(model.usesBdj).toBe(true);
    expect('bdid' in model).toBe(false);
  });

  it('has no sounds and no warning when AUXDATA is absent', async () => {
    const model = await openDisc(disc(baseFiles()));
    expect(model.sounds).toBeNull();
    expect(model.movieObjects).toBeNull();
    expect(model.warnings).toEqual([]);
  });
});

describe('readBdid', () => {
  const id = (last: number): Uint8Array<ArrayBuffer> => {
    const b = new Uint8Array(104);
    b.set([...'BDID0200'].map((c) => c.charCodeAt(0)));
    b.set([0x7f, 0xff, 0x55, 0x53], 40);
    b[59] = last;
    return b;
  };

  it('reads id.bdmv first, then the backup copy when it does not parse, as bdid_get does', async () => {
    const files = { ...baseFiles(), 'Movie/CERTIFICATE/id.bdmv': id(1), 'Movie/CERTIFICATE/BACKUP/id.bdmv': id(2) };
    expect(await readBdid(disc(files))).toEqual({ orgId: '7fff5553', discId: '00000000000000000000000000000001' });
    files['Movie/CERTIFICATE/id.bdmv'] = new Uint8Array([0x42]);
    expect((await readBdid(disc(files)))?.discId).toBe('00000000000000000000000000000002');
  });

  it('falls back to the backup when reading id.bdmv rejects, and is null when neither file reads', async () => {
    const source = disc({ ...baseFiles(), 'Movie/CERTIFICATE/id.bdmv': id(1), 'Movie/CERTIFICATE/BACKUP/id.bdmv': id(2) });
    const read = source.read.bind(source);
    const failing = new Set(['CERTIFICATE/ID.BDMV']);
    source.read = (path, offset, length, signal) =>
      failing.has(path) ? Promise.reject(new Error('unreadable')) : read(path, offset, length, signal);
    expect((await readBdid(source))?.discId).toBe('00000000000000000000000000000002');
    failing.add('CERTIFICATE/BACKUP/ID.BDMV');
    expect(await readBdid(source)).toBeNull();
    expect(await readBdid(disc(baseFiles()))).toBeNull();
  });
});
