import { beforeAll, describe, expect, it } from 'vitest';
import { fixtureDiscFiles } from '../../tests/helpers/fixture-disc';
import { syntheticSource } from '../../tests/helpers/synthetic-disc';
import type { Clpi } from '@seikou/bdmv/clpi-parser';
import { loadClips, openDisc } from '@seikou/engine/disc/open-disc';
import type { DiscModel } from '@seikou/engine/disc/open-disc';
import { parseIndex } from '@seikou/bdmv/index-parser';
import { RegisterFile } from '@seikou/engine/hdmv/registers';
import { buildIndex } from '../../tests/helpers/bdmv-builders';
import { applyDiscProfile } from '@seikou/engine/disc/disc-profile';
import { RecordingHost } from './host';
import type { TraceEntry } from './host';

describe('applyDiscProfile', () => {
  const objects = { firstPlay: { kind: 'bdj', name: '00000' }, topMenu: { kind: 'bdj', name: '00001' }, titles: [] } as const;
  const profile = (spec: Partial<Parameters<typeof buildIndex>[0]>): number => {
    const regs = new RegisterFile();
    applyDiscProfile(regs, parseIndex(buildIndex({ ...objects, titles: [], ...spec })));
    return regs.psrRead(31);
  };

  it("switches a UHD index (0300) to Profile 6 and a 3D one (02xx with content) to Profile 5, as _fill_disc_info does", () => {
    expect(profile({ version: '0300' })).toBe(0x0310);
    expect(profile({ version: '0200', appInfo: { initialOutputModePreference: 1, contentExistFlag: true } })).toBe((0x13 << 16) | 0x0240);
    expect(profile({ version: '0240', appInfo: { initialOutputModePreference: 0, contentExistFlag: true } })).toBe((0x13 << 16) | 0x0240);
    expect(profile({ version: '0200' })).toBe((0x03 << 16) | 0x0200);
    expect(profile({ version: '0100', appInfo: { initialOutputModePreference: 0, contentExistFlag: true } })).toBe((0x03 << 16) | 0x0200);
  });
});

describe('RecordingHost on disc-bdj', () => {
  let disc: DiscModel;
  let clips: Map<string, Clpi>;

  beforeAll(async () => {
    const source = syntheticSource(fixtureDiscFiles('disc-bdj'));
    disc = await openDisc(source);
    clips = await loadClips(source, ['00000']);
  });

  const host = (startTitle: (t: number) => void = () => {}): RecordingHost => new RecordingHost(disc, clips, { startTitle });

  it('lists titles as bd_get_disc_info does: top menu, the index titles, then First Play as 65535', () => {
    const titles = host().getTitleInfos();
    expect(titles).toHaveLength(3);
    expect(titles[1]).toEqual({ number: 1, objectType: 'bdj', playbackType: expect.any(Number), bdjoName: '00001', hdmvObjectId: null });
    expect(titles[2]).toMatchObject({ number: 65535, objectType: 'bdj', bdjoName: '00000' });
  });

  it('reports playlists as bd_get_playlist_info does, in 90 kHz ticks', () => {
    const h = host();
    const pl = h.getPlaylistInfo(0)!;
    expect(pl.playlist).toBe(0);
    expect(pl.durationTicks).toBe(180000n);
    expect(pl.angleCount).toBe(1);
    expect(pl.clips.map((c) => c.clipId)).toEqual(['00000']);
    expect(pl.clips[0]!.videoStreams).toHaveLength(1);
    expect(pl.clips[0]!.videoStreams[0]).toMatchObject({ subpathId: -1 });
    expect(h.getPlaylistInfo(999)).toBeNull();
    expect(h.getPlaylistInfo(-1)).toBeNull();
    expect(h.trace).toEqual([
      { call: 'getPlaylistInfoN', args: [0], ret: 0 },
      { call: 'getPlaylistInfoN', args: [999], ret: null },
      { call: 'getPlaylistInfoN', args: [-1], ret: null },
    ]);
  });

  it('writes registers as bdpriv_reg_write does', () => {
    const h = host();
    expect(h.writeReg(0, 100, 42, 0xffffffff | 0)).toBe(0);
    expect(h.readReg(0, 100)).toBe(42);
    expect(h.writeReg(1, 102, 0x12, 0xff)).toBe(0);
    expect(h.readReg(1, 102)).toBe(0x12);
    expect(h.registers.psrRead(102)).toBe(0x12);
    expect(h.writeReg(1, 200, 1, -1)).toBe(-1);
    expect(h.writeReg(0, 4096, 1, -1)).toBe(-1);
    expect(h.writeReg(1, 20, 1, -1)).toBe(-2);
    expect(h.writeReg(0, 5, -1, -1)).toBe(0);
    expect(h.readReg(0, 5)).toBe(-1);
    expect(h.trace.slice(0, 3)).toEqual([
      { call: 'writeRegN', args: [0, 100, 42, -1], ret: 0 },
      { call: 'readRegN', args: [0, 100], ret: 42 },
      { call: 'writeRegN', args: [1, 102, 18, 255], ret: 0 },
    ]);
  });

  it('selects a BD-J title and starts it after the call returns', async () => {
    const started: number[] = [];
    const h = host((t) => started.push(t));
    expect(h.selectTitle(1)).toBe(1);
    expect(started).toEqual([]);
    await Promise.resolve();
    expect(started).toEqual([1]);
    expect(h.readReg(1, 4)).toBe(1);
    expect(h.selectTitle(7)).toBe(0);
    expect(h.trace.filter((e) => e.call === 'selectTitleN')).toEqual([
      { call: 'selectTitleN', args: [1], ret: 1 },
      { call: 'selectTitleN', args: [7], ret: 0 },
    ]);
  });

  it('selects an HDMV title without starting BD-J, failing as hdmv_vm_select_object does for a missing object', async () => {
    const hdmv = { object: { kind: 'hdmv', playbackType: 1, movieObjectId: 0 }, accessType: 0 } as const;
    const withHdmv = (movieObjects: DiscModel['movieObjects']): DiscModel => ({ ...disc, index: { ...disc.index, titles: [...disc.index.titles, hdmv] }, movieObjects });
    const started: number[] = [];
    const h = new RecordingHost(withHdmv({ version: '0200', objects: [{} as NonNullable<DiscModel['movieObjects']>['objects'][number]] }), clips, { startTitle: (t) => started.push(t) });
    expect(h.getTitleInfos()[2]).toEqual({ number: 2, objectType: 'hdmv', playbackType: 1, bdjoName: null, hdmvObjectId: 0 });
    expect(h.selectTitle(2)).toBe(1);
    await Promise.resolve();
    expect(started).toEqual([]);
    expect(h.readReg(1, 4)).toBe(2);
    expect(new RecordingHost(withHdmv(null), clips, { startTitle: () => {} }).selectTitle(2)).toBe(0);
  });

  it('selects playlists, seeks and answers the other control calls with libbluray\'s values', () => {
    const seen: TraceEntry[] = [];
    const h = new RecordingHost(disc, clips, { startTitle: () => {}, onTrace: (e) => seen.push(e) });
    expect(h.selectAngle(1)).toBe(0);
    expect(h.selectPlaylist(0, -1, -1, -1n)).toBe(1);
    expect(h.selectAngle(1)).toBe(1);
    expect(h.selectPlaylist(5, -1, -1, -1n)).toBe(0);
    expect(h.seek(-1, -1, 900n)).toBe(1n);
    expect(h.tellTime()).toBe(0n);
    expect(h.selectRate(0.5, 1)).toBe(1);
    expect(h.soundEffect(256)).toBe(-1);
    expect(h.soundEffect(0)).toBe(0);
    h.setUOMask(true, false);
    expect(h.getUOMask()).toBe(1n);
    h.setKeyInterest(1);
    expect(h.getAacsData(1)).toBeNull();
    expect(h.setVirtualPackage(null, false)).toBe(0);
    h.updateGraphic(1920, 1080, null, 0, 0, 0, 0);
    expect(h.updateGraphicCount).toBe(1);
    h.log('X.java', 3, 'hi', false);
    expect(JSON.stringify(seen)).toBe(JSON.stringify(h.trace));
    expect(h.trace.map((e) => JSON.stringify(e))).toEqual([
      '{"call":"selectAngleN","args":[1],"ret":0}',
      '{"call":"selectPlaylistN","args":[0,-1,-1,"-1"],"ret":1}',
      '{"call":"selectAngleN","args":[1],"ret":1}',
      '{"call":"selectPlaylistN","args":[5,-1,-1,"-1"],"ret":0}',
      '{"call":"seekN","args":[-1,-1,"900"],"ret":"1"}',
      '{"call":"tellTimeN","args":[],"ret":"0"}',
      '{"call":"selectRateN","args":[0.5,1],"ret":1}',
      '{"call":"soundEffectN","args":[256],"ret":-1}',
      '{"call":"soundEffectN","args":[0],"ret":0}',
      '{"call":"setUOMaskN","args":[true,false],"ret":null}',
      '{"call":"getUOMaskN","args":[],"ret":"1"}',
      '{"call":"setKeyInterestN","args":[1],"ret":null}',
      '{"call":"getAacsDataN","args":[1],"ret":null}',
      '{"call":"setVirtualPackageN","args":[null,false],"ret":0}',
      '{"call":"updateGraphicN","args":[1920,1080,0,0,0,0,true],"ret":null}',
      '{"call":"logN","args":["X.java",3,"hi"],"ret":null}',
    ]);
  });

  it('refuses a virtual package while a playlist plays', () => {
    const h = host();
    h.selectPlaylist(0, -1, -1, -1n);
    expect(h.setVirtualPackage('/x', true)).toBe(-1);
    h.selectPlaylist(-1, -1, -1, -1n);
    expect(h.setVirtualPackage('/x', true)).toBe(0);
  });

  it('counts the title list in getTitleInfosN\'s trace as num_titles + 2', () => {
    const h = host();
    h.getTitleInfos();
    expect(h.trace).toEqual([{ call: 'getTitleInfosN', args: [], ret: 3 }]);
  });
});
