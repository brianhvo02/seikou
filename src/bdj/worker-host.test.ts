import { beforeAll, describe, expect, it } from 'vitest';
import { fixtureDiscFiles } from '../../tests/helpers/fixture-disc';
import { syntheticSource } from '../../tests/helpers/synthetic-disc';
import type { Clpi } from '@seikou/bdmv/clpi-parser';
import { loadClips, openDisc } from '@seikou/engine/disc/open-disc';
import type { DiscModel } from '@seikou/engine/disc/open-disc';
import { RegisterFile } from '@seikou/engine/hdmv/registers';
import { playlistInfo, titleInfos } from './disc-info';
import { GraphicsPlaneReader, GraphicsPlaneWriter, createGraphicsPlane } from './graphics-plane';
import { SharedRegisterView, createRegisterBuffer } from './shared-registers';
import { StatusBlockReader, StatusBlockWriter, createStatusBlock } from './status-block';
import { WorkerBdjHost } from './worker-host';
import type { BdjCallName } from './worker-protocol';

type Args = readonly (number | string | boolean | null)[];

describe('WorkerBdjHost', () => {
  let disc: DiscModel;
  let clips: Map<string, Clpi>;

  beforeAll(async () => {
    const source = syntheticSource(fixtureDiscFiles('disc-bdj'));
    disc = await openDisc(source);
    clips = await loadClips(source, ['00000']);
  });

  function setup(answer: (name: BdjCallName, args: Args) => Promise<number | string> = () => Promise.resolve(0)) {
    const planeBuf = createGraphicsPlane();
    const regBuf = createRegisterBuffer();
    const statusBuf = createStatusBlock();
    const engine = new RegisterFile({ shared: regBuf });
    const status = new StatusBlockWriter(statusBuf);
    const calls: [BdjCallName, Args][] = [];
    const logs: [string, boolean][] = [];
    const host = new WorkerBdjHost({
      regs: new SharedRegisterView(regBuf),
      status: new StatusBlockReader(statusBuf),
      call: (name, args) => {
        calls.push([name, args]);
        return answer(name, args);
      },
      disc,
      clips,
      log: (line, error) => void logs.push([line, error]),
      plane: new GraphicsPlaneWriter(planeBuf),
    });
    return { host, engine, status, calls, logs, plane: new GraphicsPlaneReader(planeBuf) };
  }

  it('hands displayImage stills to the engine with no call to answer, and drops them without a sink', () => {
    const { host, calls } = setup();
    expect(() => host.displayImage(new Uint8Array([1]), { x: 0, y: 0, width: 1, height: 1 })).not.toThrow();
    const sent: [Uint8Array | null, unknown][] = [];
    const withSink = new WorkerBdjHost({
      regs: new SharedRegisterView(createRegisterBuffer()),
      status: new StatusBlockReader(createStatusBlock()),
      call: () => Promise.resolve(0),
      disc,
      clips,
      log: () => undefined,
      background: (image, rect) => void sent.push([image, rect]),
    });
    withSink.displayImage(new Uint8Array([1, 2]), { x: 0.5, y: 0, width: 0.5, height: 1 });
    withSink.displayImage(null, { x: 0, y: 0, width: 1, height: 1 });
    expect(sent).toEqual([
      [new Uint8Array([1, 2]), { x: 0.5, y: 0, width: 0.5, height: 1 }],
      [null, { x: 0, y: 0, width: 1, height: 1 }],
    ]);
    expect(calls).toEqual([]);
  });

  it("draws updateGraphicN into the shared plane, locally (no engine call)", () => {
    const { host, plane, calls } = setup();
    host.updateGraphic(1920, 1080, null, 0, 0, 0, 0);
    host.updateGraphic(1920, 1080, new Int32Array(1920 * 1080).fill(-1), 4, 5, 6, 7);
    expect(plane.flushCount()).toBe(1);
    expect(plane.visible()).toBe(true);
    host.updateGraphic(0, 0, null, 0, 0, 0, 0);
    expect(plane.visible()).toBe(false);
    expect(calls).toEqual([]);
  });

  it('reads registers, time and the UO mask synchronously from the shared buffers', () => {
    const { host, engine, status, calls } = setup();
    engine.gprWrite(7, 0xfffffffe);
    engine.psrWrite(4, 3);
    status.setTime45(1000n);
    status.setUoMask(6n);
    expect(host.readReg(0, 7)).toBe(-2);
    expect(host.readReg(1, 4)).toBe(3);
    expect(host.readReg(1, 999)).toBe(-1);
    expect(host.tellTime()).toBe(2000n);
    expect(host.getUOMask()).toBe(6n);
    expect(calls).toEqual([]);
  });

  it('writes registers through the engine; a read after the reply sees the applied value', async () => {
    let apply: (() => void) | null = null;
    const { host, engine, calls } = setup(
      (_name, args) =>
        new Promise((resolve) => {
          apply = () => resolve(engine.gprWrite(args[1] as number, (args[2] as number) >>> 0));
        }),
    );
    const r = host.writeReg(0, 100, 42, -1);
    expect(r).toBeInstanceOf(Promise);
    expect(host.readReg(0, 100)).toBe(0);
    apply!();
    expect(await r).toBe(0);
    expect(host.readReg(0, 100)).toBe(42);
    expect(calls).toEqual([['writeReg', [0, 100, 42, -1]]]);
  });

  it('sends each control call to the engine, bigints as decimal strings both ways', async () => {
    const replies: Partial<Record<BdjCallName, number | string>> = {
      seek: '-1',
      selectTitle: 1,
      selectPlaylist: 1,
      selectAngle: 0,
      selectRate: 1,
      soundEffect: -1,
      setVirtualPackage: 0,
    };
    const { host, calls } = setup((name) => Promise.resolve(replies[name] ?? 0));
    expect(await host.seek(-1, 2, 123456789012n)).toBe(-1n);
    expect(await host.selectPlaylist(5, -1, -1, -1n)).toBe(1);
    expect(await host.selectTitle(1)).toBe(1);
    expect(await host.selectAngle(2)).toBe(0);
    expect(await host.selectRate(0.5, 1)).toBe(1);
    expect(await host.soundEffect(300)).toBe(-1);
    expect(await host.setVirtualPackage(null, true)).toBe(0);
    expect(await host.setUOMask(true, false)).toBeUndefined();
    expect(await host.setKeyInterest(0x81)).toBeUndefined();
    expect(calls).toEqual([
      ['seek', [-1, 2, '123456789012']],
      ['selectPlaylist', [5, -1, -1, '-1']],
      ['selectTitle', [1]],
      ['selectAngle', [2]],
      ['selectRate', [0.5, 1]],
      ['soundEffect', [300]],
      ['setVirtualPackage', [null, true]],
      ['setUOMask', [true, false]],
      ['setKeyInterest', [0x81]],
    ]);
  });

  it('answers the title list, playlist info and AACS data locally', () => {
    const { host, calls } = setup();
    expect(host.getTitleInfos()).toEqual(titleInfos(disc));
    expect(host.getPlaylistInfo(0)).toEqual(playlistInfo(disc, clips, 0));
    expect(host.getPlaylistInfo(0)!.durationTicks).toBe(180000n);
    expect(host.getPlaylistInfo(999)).toBeNull();
    expect(host.getAacsData(1)).toBeNull();
    expect(calls).toEqual([]);
  });

  it('logs Logger.logN lines with their file and line', () => {
    const { host, logs } = setup();
    host.log('Foo.java', 12, 'hello', true);
    host.log(null, 0, 'bye', false);
    expect(logs).toEqual([
      ['Foo.java:12: hello', true],
      ['JVM:0: bye', false],
    ]);
  });
});
