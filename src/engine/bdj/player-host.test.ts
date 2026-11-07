import { describe, expect, it, vi } from 'vitest';
import { buildSoundBdmv } from '../../../tests/helpers/bdmv-builders';
import { buildMovieObjects } from '../../../tests/helpers/hdmv-builders';
import { buildSyntheticDisc, discEntries, syntheticClip } from '../../../tests/helpers/synthetic-disc';
import { createRing, renderQuantum, ringViews } from '../audio/ring';
import { CodingType } from '@seikou/bdmv/stream-types';
import { createAudioDecoderFactory } from '../decode/audio-decoder';
import type { VideoCodecApi, VideoDecoderLike } from '../decode/video-decoder';
import { FileSource } from '../disc/file-source';
import { openDisc } from '../disc/open-disc';
import { normalizeDiscPaths } from '../disc/paths';
import { PSR, RegisterFile } from '../hdmv/registers';
import { Player } from '../player';
import type { EngineEvent, PlaybackState } from '../protocol';
import { bdjPlaybackEvents } from './events';
import { PlayerBdjHost } from './player-host';
import { BdjEvent } from './runtime';

class FakeDecoder implements VideoDecoderLike {
  state: CodecState = 'unconfigured';
  decodeQueueSize = 0;
  constructor(private readonly init: VideoDecoderInit) {}
  configure(): void {
    this.state = 'configured';
  }
  decode(chunk: EncodedVideoChunk): void {
    const { timestamp } = chunk as unknown as EncodedVideoChunkInit;
    this.init.output({ timestamp, displayWidth: 320, displayHeight: 180, close: () => undefined } as unknown as VideoFrame);
  }
  async flush(): Promise<void> {}
  reset(): void {
    this.state = 'unconfigured';
  }
  close(): void {
    this.state = 'closed';
  }
}

const fakeApi: VideoCodecApi = {
  create: (init) => new FakeDecoder(init),
  isConfigSupported: async (config) => ({ supported: true, config }),
  makeChunk: (init) => init as unknown as EncodedVideoChunk,
};

const STEP_MS = 640 / 48;

async function setup(opts: { sounds?: boolean } = {}) {
  const files = buildSyntheticDisc({
    clips: [syntheticClip('00001', 4, { audio: CodingType.LPCM }), syntheticClip('00002', 4, { audio: CodingType.LPCM })],
    playlists: [
      { id: '00000', clipIds: ['00001', '00002'], chapterEverySeconds: 2 },
      { id: '00001', clipIds: ['00002'], chapterEverySeconds: 1 },
    ],
    movieObjects: buildMovieObjects([{ cmds: [] }]),
    index: {
      firstPlay: { kind: 'bdj', name: '00000' },
      topMenu: { kind: 'bdj', name: '00000' },
      titles: [{ kind: 'bdj', name: '00001' }, { kind: 'hdmv', movieObjectId: 0 }],
    },
  });
  if (opts.sounds) files.set('BDMV/AUXDATA/sound.bdmv', buildSoundBdmv([{ channels: 1, samples: new Int16Array(480) }]));
  const engine: EngineEvent[] = [];
  const clock = { ms: 1000 };
  const player = new Player({
    emit: (e) => engine.push(e),
    videoCodecApi: fakeApi,
    nowMs: () => clock.ms,
    requestFrame: () => undefined,
    createAudioDecoder: createAudioDecoderFactory(() => Promise.reject(new Error('no wasm'))),
    createCompositor: () => ({ resize: () => undefined, drawVideo: () => undefined }),
  });
  const ring = createRing(48_000, 2);
  const views = ringViews(ring);
  await player.handle({ type: 'attachAudio', ring });
  await player.handle({ type: 'attachCanvas', canvas: {} as OffscreenCanvas });
  const entries = discEntries(files);
  await player.handle({ type: 'open', disc: { kind: 'files', entries } });
  const source = new FileSource(normalizeDiscPaths(entries));
  const disc = await openDisc(source);
  const regs = new RegisterFile();
  regs.psrWrite(PSR.TITLE_NUMBER, 0xffff);
  const bdj: Array<[number, number]> = [];
  const sink = (ev: number, param: number): void => {
    bdj.push([ev, param]);
  };
  const calls = { startTitle: [] as number[], playHdmvTitle: [] as number[], uoMask: [] as bigint[] };
  const host = new PlayerBdjHost({
    port: player.bdjPort(),
    regs,
    disc,
    events: bdjPlaybackEvents(sink),
    psrEvents: sink,
    startTitle: (t) => calls.startTitle.push(t),
    playHdmvTitle: (t) => {
      calls.playHdmvTitle.push(t);
      return true;
    },
    uoMaskChanged: (bits) => calls.uoMask.push(bits),
  });
  const left = new Float32Array(128);
  const right = new Float32Array(128);
  return {
    player,
    host,
    regs,
    disc,
    engine,
    bdj,
    calls,
    of: (ev: number) => bdj.filter(([e]) => e === ev).map(([, p]) => p),
    state: (): PlaybackState | undefined => engine.flatMap((e) => (e.type === 'state' ? [e.state] : [])).at(-1),
    chapterIds: () => engine.flatMap((e) => (e.type === 'chapters' ? [e.playlistId] : [])),
    async play(ms: number) {
      for (let elapsed = 0; elapsed < ms; elapsed += STEP_MS) {
        clock.ms += STEP_MS;
        for (let q = 0; q < 5; q++) renderQuantum(views, left, right);
        player.tick();
        await new Promise((r) => setTimeout(r, 1));
      }
    },
  };
}

type Setup = Awaited<ReturnType<typeof setup>>;

const START = 1;
const STOP = 2;

async function untilState(h: Setup, state: PlaybackState, timeout = 5000): Promise<void> {
  await vi.waitFor(
    async () => {
      await h.play(100);
      expect(h.state()).toBe(state);
    },
    { timeout },
  );
}

/** selectPlaylist + selectRate(1, START), as the JMF Handler's prefetch and start do. */
async function startPlaylist(h: Setup, playlist: number): Promise<void> {
  expect(await h.host.handle('selectPlaylist', [playlist, -1, -1, '-1'])).toBe(1);
  expect(await h.host.handle('selectRate', [1, START])).toBe(1);
  await untilState(h, 'playing');
}

describe('PlayerBdjHost', () => {
  it('opens the selected playlist paused, writes the playback PSRs and raises PLAYLIST and PLAYITEM', async () => {
    const h = await setup();
    expect(await h.host.handle('selectPlaylist', [1, -1, -1, '-1'])).toBe(1);
    const inTime = h.disc.playlists.get('00001')!.playItems[0]!.inTime;
    expect(h.regs.psrRead(PSR.PLAYLIST)).toBe(1);
    expect(h.regs.psrRead(PSR.PLAYITEM)).toBe(0);
    expect(h.regs.psrRead(PSR.TIME)).toBe(inTime);
    expect(h.regs.psrRead(PSR.ANGLE_NUMBER)).toBe(1);
    expect(h.of(BdjEvent.PLAYLIST)).toEqual([1]);
    expect(h.of(BdjEvent.PLAYITEM)).toEqual([0]);
    expect(h.chapterIds()).toEqual(['00001']);
    await h.play(300);
    expect(h.state()).toBe('paused'); // bdj_wait_start: nothing plays before selectRate(START)
    expect(await h.host.handle('selectRate', [1, START])).toBe(1);
    await untilState(h, 'playing');
    await h.play(500);
    expect(h.regs.psrRead(PSR.TIME)).toBeGreaterThan(inTime + 45_000 * 0.3);
    expect(h.of(BdjEvent.PTS).length).toBeGreaterThan(5);
    expect(h.of(BdjEvent.RATE)).toEqual([]); // Java's own rate change is not echoed (bdpriv_select_rate)
  });

  it('raises PLAYITEM and updates PSR7 when playback crosses into the next play item', async () => {
    const h = await setup();
    await startPlaylist(h, 0);
    await vi.waitFor(async () => {
      await h.play(200);
      expect(h.regs.psrRead(PSR.PLAYITEM)).toBe(1);
    }, { timeout: 10_000 });
    expect(h.of(BdjEvent.PLAYITEM)).toEqual([0, 1]);
  });

  it('raises MARK with the mark index for each mark passed and END_OF_PLAYLIST once at the end', async () => {
    const h = await setup();
    await startPlaylist(h, 1);
    await untilState(h, 'ended', 20_000);
    await h.play(500);
    // mark 0 is at the IN time, past the first item's start_pkt 0 (its EP map entry follows the PAT and PMT), so the first read reaches it as libbluray's does
    expect(h.of(BdjEvent.MARK)).toEqual([0, 1, 2, 3]);
    expect(h.of(BdjEvent.END_OF_PLAYLIST)).toEqual([1]);
  }, 30_000);

  it('seeks to a time and raises SEEK with the playlist media time', async () => {
    const h = await setup();
    await startPlaylist(h, 0);
    h.bdj.length = 0;
    expect(await h.host.handle('seek', [-1, -1, String(5 * 90_000)])).toBe('1');
    expect(h.of(BdjEvent.SEEK)).toEqual([5 * 45_000]);
    expect(h.regs.psrRead(PSR.PLAYITEM)).toBe(1); // the seek opened the second clip
    await h.play(300);
    expect(h.regs.psrRead(PSR.PLAYITEM)).toBe(1);
    expect(h.of(BdjEvent.PLAYITEM)).toEqual([1]);
  });

  it('seeks to a mark and a play item as bdpriv_seek does (play item 0 is not sought)', async () => {
    const h = await setup();
    await startPlaylist(h, 0);
    h.bdj.length = 0;
    await h.host.handle('seek', [0, -1, '-1']);
    expect(h.of(BdjEvent.SEEK)).toEqual([]);
    await h.host.handle('seek', [1, 1, '-1']);
    const firstItem = h.disc.playlists.get('00000')!.playItems[0]!;
    const mark1 = h.disc.playlists.get('00000')!.marks[1]!;
    expect(h.of(BdjEvent.SEEK)).toEqual([firstItem.outTime - firstItem.inTime, mark1.time - firstItem.inTime]);
  });

  it('selectRate(0) pauses and a later rate plays again; STOP does nothing; no RATE echo', async () => {
    const h = await setup();
    await startPlaylist(h, 0);
    expect(await h.host.handle('selectRate', [0, 0])).toBe(1);
    await untilState(h, 'paused');
    await h.host.handle('selectRate', [1, STOP]);
    await h.play(300);
    expect(h.state()).toBe('paused');
    await h.host.handle('selectRate', [1, 0]);
    await untilState(h, 'playing');
    expect(h.of(BdjEvent.RATE)).toEqual([]);
  });

  it("raises RATE for the application's own rate changes (bd_set_rate)", async () => {
    const h = await setup();
    expect(h.host.setRate(0)).toBe(-1); // no playlist
    await startPlaylist(h, 0);
    expect(h.host.setRate(0)).toBe(0);
    expect(h.host.setRate(90_000)).toBe(0);
    expect(h.of(BdjEvent.RATE)).toEqual([0, 90_000]);
  });

  it('restarts a playlist that ended when Java seeks back and starts it again (menu loop)', async () => {
    const h = await setup();
    await startPlaylist(h, 1);
    await untilState(h, 'ended', 20_000);
    await h.host.handle('selectRate', [0, STOP]); // the JMF Handler's doStop at end of media
    await h.host.handle('seek', [-1, -1, '0']);
    await untilState(h, 'paused');
    expect(await h.host.handle('selectRate', [1, START])).toBe(1);
    await untilState(h, 'playing');
  }, 30_000);

  it('starts again after the player was paused from outside', async () => {
    const h = await setup();
    await startPlaylist(h, 0);
    await h.player.handle({ type: 'pause' });
    expect(h.state()).toBe('paused');
    expect(await h.host.handle('selectRate', [1, START])).toBe(1);
    await untilState(h, 'playing');
  });

  it('refuses playlist 100000 without closing the playing one', async () => {
    const h = await setup();
    await startPlaylist(h, 0);
    const cleared = h.engine.filter((e) => e.type === 'playlistCleared').length;
    expect(await h.host.handle('selectPlaylist', [100_000, -1, -1, '-1'])).toBe(0);
    expect(h.engine.filter((e) => e.type === 'playlistCleared').length).toBe(cleared);
    await h.play(200);
    expect(h.state()).toBe('playing');
  });

  it('closes the playing playlist for a missing one, as _open_playlist does, and for playlist -1', async () => {
    const h = await setup();
    await startPlaylist(h, 0);
    expect(await h.host.handle('selectPlaylist', [7, -1, -1, '-1'])).toBe(0);
    expect(h.state()).toBe('idle');
    await startPlaylist(h, 0);
    expect(await h.host.handle('selectPlaylist', [-1, -1, -1, '-1'])).toBe(1);
    expect(h.state()).toBe('idle');
  });

  it('lets the newer of two quick selectPlaylist calls win, and events carry its number', async () => {
    const h = await setup();
    const first = h.host.handle('selectPlaylist', [0, -1, -1, '-1']);
    const second = h.host.handle('selectPlaylist', [1, -1, -1, '-1']);
    expect(await second).toBe(1);
    expect(await first).toBe(1);
    expect(await h.host.handle('selectRate', [1, START])).toBe(1);
    await untilState(h, 'ended', 20_000);
    await h.play(300);
    expect(h.chapterIds()).toEqual(['00001']);
    expect(h.regs.psrRead(PSR.PLAYLIST)).toBe(1);
    expect(h.of(BdjEvent.PLAYLIST).at(-1)).toBe(1);
    expect(h.of(BdjEvent.END_OF_PLAYLIST)).toEqual([1]);
  }, 30_000);

  it('accepts any sound id up to 255 before the sounds are loaded, as bdpriv_sound_effect does, and checks it after', async () => {
    const h = await setup({ sounds: true });
    expect(await h.host.handle('soundEffect', [5])).toBe(0);
    expect(await h.host.handle('soundEffect', [256])).toBe(-1);
    await vi.waitFor(async () => {
      await h.play(20);
      expect(await h.host.handle('soundEffect', [5])).toBe(-1);
    });
    expect(await h.host.handle('soundEffect', [0])).toBe(0);
    await vi.waitFor(() => expect(h.engine).toContainEqual({ type: 'soundEffect', id: 0 }));
    expect(h.engine.filter((e) => e.type === 'soundEffect')).toHaveLength(1);
  });

  it('hands an HDMV title to playHdmvTitle and starts a BD-J title', async () => {
    const h = await setup();
    expect(await h.host.handle('selectTitle', [1])).toBe(1);
    expect(h.calls.startTitle).toEqual([1]);
    expect(h.regs.psrRead(PSR.TITLE_NUMBER)).toBe(1);
    expect(await h.host.handle('selectTitle', [3])).toBe(0); // no such title
    expect(await h.host.handle('selectTitle', [2])).toBe(1);
    expect(h.calls.playHdmvTitle).toEqual([2]);
    expect(h.regs.psrRead(PSR.TITLE_NUMBER)).toBe(2);
  });

  it('publishes the UO mask before setUOMask replies, combined with the playlist mask', async () => {
    const h = await setup();
    let replied = false;
    const reply = h.host.handle('setUOMask', [true, false]).then(() => {
      replied = true;
    });
    expect(h.calls.uoMask).toEqual([1n]);
    expect(replied).toBe(false);
    await reply;
    await h.host.handle('setUOMask', [false, false]);
    expect(h.calls.uoMask).toEqual([1n, 0n]);
  });

  it('writes registers through bd_psr_write_bits and bd_gpr_write', async () => {
    const h = await setup();
    expect(await h.host.handle('writeReg', [0, 5, 77, -1])).toBe(0);
    expect(h.regs.gprRead(5)).toBe(77);
    expect(await h.host.handle('writeReg', [1, 102, 0x1234, 0xff])).toBe(0);
    expect(h.regs.psrRead(102)).toBe(0x34);
    expect(h.of(BdjEvent.PSR102)).toEqual([0x34]);
  });

  it('selects an angle only with a playlist open, writing PSR3', async () => {
    const h = await setup();
    expect(await h.host.handle('selectAngle', [2])).toBe(0);
    await startPlaylist(h, 0);
    expect(await h.host.handle('selectAngle', [2])).toBe(1);
    expect(h.regs.psrRead(PSR.ANGLE_NUMBER)).toBe(2);
    expect(h.of(BdjEvent.ANGLE).at(-1)).toBe(2);
    expect(h.regs.psrRead(PSR.TIME)).toBe(h.disc.playlists.get('00000')!.playItems[0]!.inTime); // _open_m2ts again
  });

  it('sets the virtual package only without a playlist', async () => {
    const h = await setup();
    expect(await h.host.handle('setVirtualPackage', [null, false])).toBe(0);
    await startPlaylist(h, 0);
    expect(await h.host.handle('setVirtualPackage', [null, false])).toBe(-1);
  });

  it('reports a user seek to Java with SEEK', async () => {
    const h = await setup();
    await startPlaylist(h, 0);
    h.bdj.length = 0;
    await h.player.handle({ type: 'seek', timeUs: 2_000_000 });
    expect(h.of(BdjEvent.SEEK)).toEqual([2 * 45_000]);
  });
});

