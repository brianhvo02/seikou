import { describe, expect, it, vi } from 'vitest';
import { BDJ_STORAGE_MESSAGE, NO_PICTURE_MESSAGE, type AudioTrack, type EngineEvent, type Telemetry } from '../protocol';
import { FETCH_PORT_RELEASE_MS, INITIAL_SNAPSHOT, PlayerController, reduceEvent, type AudioOutputLike, type WorkerLike } from './player-controller';

class FakeWorker implements WorkerLike {
  readonly posted: unknown[] = [];
  readonly transfers: unknown[][] = [];
  onmessage: ((event: MessageEvent) => void) | null = null;
  onerror: ((event: ErrorEvent) => void) | null = null;
  onmessageerror: ((event: MessageEvent) => void) | null = null;
  postMessage(message: unknown, transfer: unknown[] = []): void {
    this.posted.push(message);
    this.transfers.push(transfer);
  }
  emit(event: EngineEvent): void {
    this.onmessage?.({ data: event } as MessageEvent);
  }
}

class FakeAudio implements AudioOutputLike {
  volume = 1;
  muted = false;
  starts = 0;
  readonly ring = new SharedArrayBuffer(8);
  fail = false;
  ensureStarted(): Promise<SharedArrayBuffer> {
    this.starts++;
    return this.fail ? Promise.reject(new Error('no audio device')) : Promise.resolve(this.ring);
  }
  setVolume(v: number): void {
    this.volume = v;
  }
  setMuted(m: boolean): void {
    this.muted = m;
  }
  readonly loaded: number[] = [];
  readonly played: number[] = [];
  loadEffects(clips: ReadonlyArray<{ channels: 1 | 2; samples: Int16Array }>): void {
    this.loaded.push(clips.length);
  }
  playEffect(id: number): void {
    this.played.push(id);
  }
  stateCb: ((state: AudioContextState | 'interrupted') => void) | null = null;
  onStateChange(cb: (state: AudioContextState | 'interrupted') => void): void {
    this.stateCb = cb;
  }
}

const summary = { id: '00000', durationUs: 8_000_000, chapterCount: 4, clipIds: ['00001'], playable: true, missingPaths: [], looped: false };

describe('reduceEvent', () => {
  it('tracks titles, chapters, state and time', () => {
    let s = reduceEvent(INITIAL_SNAPSHOT, { type: 'titles', playlists: [summary], usesBdj: false, bdjSupported: false, warnings: [] });
    s = reduceEvent(s, { type: 'chapters', playlistId: '00000', durationUs: 8_000_000, chapters: [{ index: 0, startUs: 0 }] });
    s = reduceEvent(s, { type: 'state', state: 'playing' });
    s = reduceEvent(s, { type: 'time', timeUs: 1_500_000 });
    expect(s).toMatchObject({ playlists: [summary], currentPlaylistId: '00000', durationUs: 8_000_000, engineState: 'playing', timeUs: 1_500_000 });
  });

  it('dedupes notices by code and records unsupported streams and errors', () => {
    let s = reduceEvent(INITIAL_SNAPSHOT, { type: 'notice', code: 'audio-disabled', message: 'a' });
    s = reduceEvent(s, { type: 'notice', code: 'audio-disabled', message: 'b' });
    s = reduceEvent(s, { type: 'unsupported', kind: 'audio', codec: 'DTS', message: 'no DTS' });
    s = reduceEvent(s, { type: 'error', code: 'not-bdmv', message: 'nope', paths: ['BDMV/INDEX.BDMV'] });
    expect(s.notices).toEqual([
      { code: 'audio-disabled', message: 'b' },
      { code: 'unsupported-audio', message: 'no DTS' },
    ]);
    expect(s.error).toEqual({ code: 'not-bdmv', message: 'nope', paths: ['BDMV/INDEX.BDMV'] });
  });
});

describe('playlist lifecycle', () => {
  it('clears the playlist when the engine reports it gone', () => {
    let s = reduceEvent(INITIAL_SNAPSHOT, { type: 'chapters', playlistId: '00000', durationUs: 8_000_000, chapters: [{ index: 0, startUs: 0 }] });
    s = reduceEvent(s, { type: 'time', timeUs: 3_000_000 });
    s = reduceEvent(s, { type: 'playlistCleared' });
    expect(s).toMatchObject({ currentPlaylistId: null, durationUs: 0, chapters: [], timeUs: 0 });
  });

  it('closes the disc in the engine, not just the UI', () => {
    const worker = new FakeWorker();
    const c = new PlayerController(worker, new FakeAudio());
    worker.emit({ type: 'titles', playlists: [summary], usesBdj: false, bdjSupported: false, warnings: [] });
    c.closeDisc();
    expect(worker.posted).toEqual([{ type: 'close' }]);
    expect(c.getSnapshot().playlists).toEqual([]);
  });

  it('marks a NAS disc as remote (and as WebRTC for an rtc:// base) until a local disc opens or the disc closes', () => {
    const spec = (base: string) => ({ kind: 'remote' as const, base, token: 't', manifest: { discId: 'a', name: 'a', files: [], inline: {} } });
    expect(INITIAL_SNAPSHOT.remoteDisc).toBe(false);
    expect(INITIAL_SNAPSHOT.rtcDisc).toBe(false);
    const c = new PlayerController(new FakeWorker(), new FakeAudio());
    c.openRemote(spec('https://nas.example/discs/a/'));
    expect([c.getSnapshot().remoteDisc, c.getSnapshot().rtcDisc]).toEqual([true, false]);
    c.openRemote(spec('rtc://nas1/api/discs/a/'));
    expect([c.getSnapshot().remoteDisc, c.getSnapshot().rtcDisc]).toEqual([true, true]);
    c.open([]);
    expect([c.getSnapshot().remoteDisc, c.getSnapshot().rtcDisc]).toEqual([false, false]);
    c.openRemote(spec('rtc://nas1/api/discs/a/'));
    c.closeDisc();
    expect([c.getSnapshot().remoteDisc, c.getSnapshot().rtcDisc]).toEqual([false, false]);
  });

  it('opens an encode: the command carries the spec, its fetch port is transferred, and encodeId is set until another disc opens', () => {
    const worker = new FakeWorker();
    const c = new PlayerController(worker, new FakeAudio());
    const { port1 } = new MessageChannel();
    const encode = { base: 'rtc://nas1/api/encodes/e1/', token: 't', manifest: { discId: 'e1', name: 'e1', files: [{ path: 'EPISODE.MKV', size: 10 }], inline: {} }, encodeId: 'e1', fetchPort: port1 };
    expect(INITIAL_SNAPSHOT.encodeId).toBeNull();
    c.openEncode(encode, undefined, 12_000_000);
    expect(worker.posted.at(-1)).toEqual({ type: 'openEncode', encode, startUs: 12_000_000 });
    expect(worker.transfers.at(-1)).toEqual([port1]);
    expect(c.getSnapshot()).toMatchObject({ encodeId: 'e1', remoteDisc: true, rtcDisc: true, engineState: 'loading' });
    c.open([]);
    expect(c.getSnapshot().encodeId).toBeNull();
    c.openEncode({ ...encode, fetchPort: undefined });
    c.closeDisc();
    expect(c.getSnapshot().encodeId).toBeNull();
    port1.close();
  });

  it('keeps chapter names and shows the AV1 warning as its own notice', () => {
    let s = reduceEvent(INITIAL_SNAPSHOT, { type: 'chapters', playlistId: 'mkv', durationUs: 60_000_000, chapters: [{ index: 0, startUs: 0, name: 'Avant' }] });
    expect(s.chapters).toEqual([{ index: 0, startUs: 0, name: 'Avant' }]);
    s = reduceEvent(s, { type: 'unsupported', kind: 'video', codec: 'AV1', message: "This browser can't play AV1 video.", reason: 'av1' });
    expect(s.notices).toEqual([{ code: 'unsupported-av1', message: "This browser can't play AV1 video." }]);
  });

  it('levelSwitch goes switching, then idle or the error', () => {
    const worker = new FakeWorker();
    const c = new PlayerController(worker, new FakeAudio());
    const spec = { kind: 'remote', base: 'https://nas.example/discs/a/', token: 't', manifest: { discId: 'a', name: 'a', files: [], inline: {} } } as const;
    expect(INITIAL_SNAPSHOT.levelSwitch).toBe('idle');
    c.openRemote(spec);
    const level = { ...spec, query: 'level=h264-1080&audio=1', original: spec.manifest };
    c.setLevel(level);
    expect(worker.posted.at(-1)).toEqual({ type: 'setLevel', disc: level });
    expect(c.getSnapshot().levelSwitch).toBe('switching');
    worker.emit({ type: 'levelChanged', ok: true });
    expect(c.getSnapshot().levelSwitch).toBe('idle');
    c.setLevel(level);
    worker.emit({ type: 'levelChanged', ok: false, message: 'Another disc is open.' });
    expect(c.getSnapshot().levelSwitch).toEqual({ error: 'Another disc is open.' });
    c.openRemote(spec);
    expect(c.getSnapshot().levelSwitch).toBe('idle'); // a new disc starts without one
  });

  it('a late levelChanged from the previous disc does not touch the new one', () => {
    const worker = new FakeWorker();
    const c = new PlayerController(worker, new FakeAudio());
    const spec = { kind: 'remote', base: 'https://nas.example/discs/a/', token: 't', manifest: { discId: 'a', name: 'a', files: [], inline: {} } } as const;
    c.openRemote(spec);
    c.setLevel({ ...spec, query: 'level=h264-1080&audio=1', original: spec.manifest });
    c.openRemote({ ...spec, manifest: { ...spec.manifest, discId: 'b' } });
    worker.emit({ type: 'levelChanged', ok: false, message: 'It would not open.' });
    expect(c.getSnapshot().levelSwitch).toBe('idle');
  });

  it('setLevel carries the audio stream to keep when it is given', () => {
    const worker = new FakeWorker();
    const c = new PlayerController(worker, new FakeAudio());
    const spec = { kind: 'remote', base: 'https://nas.example/discs/a/', token: 't', manifest: { discId: 'a', name: 'a', files: [], inline: {} } } as const;
    c.openRemote(spec);
    c.setLevel(spec, 2);
    expect(worker.posted.at(-1)).toEqual({ type: 'setLevel', disc: spec, audio: 2 });
  });

  it('opens a NAS disc buffering first, reports the fill and cancels it', () => {
    const worker = new FakeWorker();
    const c = new PlayerController(worker, new FakeAudio());
    const spec = { kind: 'remote', base: 'https://nas.example/discs/a/', token: 't', manifest: { discId: 'a', name: 'a', files: [], inline: {} } } as const;
    c.openRemote(spec, undefined, undefined, { fromSeconds: 0, targetBytes: 1000 });
    expect(worker.posted[0]).toEqual({ type: 'open', disc: spec, bufferFirst: { fromSeconds: 0, targetBytes: 1000 } });
    expect(c.getSnapshot().buffer).toBeNull();
    worker.emit({ type: 'bufferProgress', bytes: 250, targetBytes: 1000, mbps: 12 });
    expect(c.getSnapshot().buffer).toEqual({ bytes: 250, targetBytes: 1000, mbps: 12 });
    c.cancelBuffer();
    c.bufferAhead(30, 500);
    expect(worker.posted.slice(1)).toEqual([{ type: 'cancelBuffer' }, { type: 'bufferAhead', fromSeconds: 30, targetBytes: 500 }]);
    worker.emit({ type: 'bufferProgress', bytes: 250, targetBytes: 1000, mbps: 12, stopped: 'failed' });
    expect(c.getSnapshot().buffer).toEqual({ bytes: 250, targetBytes: 1000, mbps: 12, stopped: 'failed' });
    c.openRemote(spec);
    expect(c.getSnapshot().buffer).toBeNull(); // a new disc starts without one
  });

  it('keeps whether this device has a read-ahead cache across discs', () => {
    const worker = new FakeWorker();
    const c = new PlayerController(worker, new FakeAudio());
    expect(c.getSnapshot().readAheadCache).toBeNull();
    worker.emit({ type: 'readAheadCache', available: false });
    c.openRemote({ kind: 'remote', base: 'https://nas.example/discs/a/', token: 't', manifest: { discId: 'a', name: 'a', files: [], inline: {} } });
    c.open([]);
    c.closeDisc();
    expect(c.getSnapshot().readAheadCache).toBe(false);
  });

  it('counts every open and close, so a wait begun for one open can tell another from it', () => {
    const c = new PlayerController(new FakeWorker(), new FakeAudio());
    expect(c.discOpens).toBe(0);
    c.open([]);
    c.openRemote({ kind: 'remote', base: 'https://nas.example/discs/a/', token: 't', manifest: { discId: 'a', name: 'a', files: [], inline: {} } });
    c.closeDisc();
    expect(c.discOpens).toBe(3);
  });

  it('shows a notice of its own, replacing one with the same code', () => {
    const c = new PlayerController(new FakeWorker(), new FakeAudio());
    c.showNotice('episode-missing', 'a');
    c.showNotice('episode-missing', 'b');
    expect(c.getSnapshot().notices).toEqual([{ code: 'episode-missing', message: 'b' }]);
  });
});

describe('notices across playlists', () => {
  // The engine emits a playlist's own notices *before* its `chapters` event (engine/player.ts playPlaylist).
  function startPlaylist(worker: FakeWorker, c: PlayerController, id: string, notices: EngineEvent[]): void {
    c.playPlaylist(id);
    for (const e of notices) worker.emit(e);
    worker.emit({ type: 'chapters', playlistId: id, durationUs: 1, chapters: [] });
  }

  it("keeps the new playlist's own unsupported-audio and audio-disabled notices", () => {
    const worker = new FakeWorker();
    const c = new PlayerController(worker, new FakeAudio());
    startPlaylist(worker, c, '00000', [
      { type: 'unsupported', kind: 'audio', codec: 'DTS', message: 'no DTS' },
      { type: 'notice', code: 'audio-disabled', message: 'no output' },
    ]);
    expect(c.getSnapshot().notices.map((n) => n.code)).toEqual(['unsupported-audio', 'audio-disabled']);
  });

  it("drops the previous playlist's playlist-specific notices when another is picked, keeping disc and device notices", async () => {
    const worker = new FakeWorker();
    const audio = new FakeAudio();
    audio.fail = true;
    const c = new PlayerController(worker, audio);
    worker.emit({ type: 'notice', code: 'bdj', message: 'bd-j' });
    startPlaylist(worker, c, '00000', [
      { type: 'unsupported', kind: 'audio', codec: 'DTS', message: 'no DTS' },
      { type: 'notice', code: 'decoder-recovered', message: 'recovered' },
    ]);
    await new Promise((r) => setTimeout(r, 0)); // audio start rejects → 'audio-output' notice
    startPlaylist(worker, c, '00001', []);
    await new Promise((r) => setTimeout(r, 0));
    expect(c.getSnapshot().notices.map((n) => n.code).sort()).toEqual(['audio-output', 'bdj']);
  });
});

describe("the bdj-storage notice (saved data that won't last, ruling R32)", () => {
  const lost: EngineEvent = { type: 'notice', code: 'bdj-storage', message: BDJ_STORAGE_MESSAGE };
  const codes = (c: PlayerController): string[] => c.getSnapshot().notices.map((n) => n.code);

  it('shows the text once, and keeps it for the disc: past a playlist picked and BD-J stopping', () => {
    const shown = reduceEvent(reduceEvent(INITIAL_SNAPSHOT, lost), lost);
    expect(shown.notices).toEqual([{ code: 'bdj-storage', message: "This disc's saved data can't be kept right now, so progress you make may be lost." }]);
    const worker = new FakeWorker();
    const c = new PlayerController(worker, new FakeAudio());
    c.open([]);
    worker.emit({ type: 'bdjActive', active: true });
    worker.emit(lost);
    worker.emit(lost);
    expect(c.getSnapshot().notices).toEqual([{ code: 'bdj-storage', message: BDJ_STORAGE_MESSAGE }]);
    c.playPlaylist('00000'); // from the picker: BD-J stops
    worker.emit({ type: 'bdjActive', active: false });
    worker.emit({ type: 'chapters', playlistId: '00000', durationUs: 1, chapters: [] });
    expect(codes(c)).toEqual(['bdj-storage']);
  });

  it('is cleared like the other notices: dismissed, or another disc opened', () => {
    const worker = new FakeWorker();
    const c = new PlayerController(worker, new FakeAudio());
    c.open([]);
    worker.emit(lost);
    c.dismissNotice('bdj-storage');
    expect(codes(c)).toEqual([]);
    worker.emit(lost); // the next disc's own (the engine sends one per disc open)
    expect(codes(c)).toEqual(['bdj-storage']);
    c.open([]);
    expect(codes(c)).toEqual([]);
    expect(reduceEvent(reduceEvent(INITIAL_SNAPSHOT, lost), { type: 'noticeCleared', code: 'bdj-storage' }).notices).toEqual([]);
  });
});

describe('the no-picture notice', () => {
  const noPicture: EngineEvent = { type: 'unsupported', kind: 'video', codec: 'MPEG-2 video', message: NO_PICTURE_MESSAGE, noPicture: true };
  const codes = (c: PlayerController): string[] => c.getSnapshot().notices.map((n) => n.code);

  it('stays for the disc when another playlist is picked, and goes when another disc opens (Review Focus 4)', () => {
    const worker = new FakeWorker();
    const c = new PlayerController(worker, new FakeAudio());
    c.open([]);
    c.playPlaylist('00000');
    worker.emit(noPicture);
    worker.emit({ type: 'chapters', playlistId: '00000', durationUs: 1, chapters: [] });
    c.playPlaylist('00001'); // the engine sends it once per disc: nothing comes for this one
    worker.emit({ type: 'chapters', playlistId: '00001', durationUs: 1, chapters: [] });
    expect(c.getSnapshot().notices).toEqual([{ code: 'no-picture', message: NO_PICTURE_MESSAGE }]);
    c.open([]);
    expect(codes(c)).toEqual([]);
    c.playPlaylist('00000');
    worker.emit(noPicture); // the next disc's own notice
    expect(codes(c)).toEqual(['no-picture']);
  });

  it('goes when a playlist with a picture starts, and is not shown again for the disc (R9)', () => {
    const worker = new FakeWorker();
    const c = new PlayerController(worker, new FakeAudio());
    c.open([]);
    c.playPlaylist('00000');
    worker.emit(noPicture);
    worker.emit({ type: 'chapters', playlistId: '00000', durationUs: 1, chapters: [] });
    expect(codes(c)).toEqual(['no-picture']);
    c.playPlaylist('00001'); // H.264: the engine clears the notice before the playlist's chapters
    worker.emit({ type: 'noticeCleared', code: 'no-picture' });
    worker.emit({ type: 'chapters', playlistId: '00001', durationUs: 1, chapters: [] });
    expect(codes(c)).toEqual([]);
    c.playPlaylist('00000'); // MPEG-2 again: the engine sends nothing more for this disc
    worker.emit({ type: 'chapters', playlistId: '00000', durationUs: 1, chapters: [] });
    expect(codes(c)).toEqual([]);
  });

  it('reduces noticeCleared for the no-picture notice', () => {
    const shown = reduceEvent(INITIAL_SNAPSHOT, noPicture);
    expect(shown.notices).toEqual([{ code: 'no-picture', message: NO_PICTURE_MESSAGE }]);
    expect(reduceEvent(shown, { type: 'noticeCleared', code: 'no-picture' }).notices).toEqual([]);
  });

  it('is dismissed like any notice and does not come back for the next playlist', () => {
    const worker = new FakeWorker();
    const c = new PlayerController(worker, new FakeAudio());
    c.playPlaylist('00000');
    worker.emit(noPicture);
    c.dismissNotice('no-picture');
    c.playPlaylist('00001');
    expect(codes(c)).toEqual([]);
  });

  it('drops a playlist-specific unsupported-video error notice when another playlist is picked', () => {
    const worker = new FakeWorker();
    const c = new PlayerController(worker, new FakeAudio());
    c.playPlaylist('00000');
    worker.emit({ type: 'unsupported', kind: 'video', codec: 'HEVC', message: 'HEVC video is not supported by this browser.' });
    c.playPlaylist('00001');
    expect(codes(c)).toEqual([]);
  });
});

describe('PlayerController', () => {
  it('surfaces worker load and message errors as an internal error', () => {
    const worker = new FakeWorker();
    const c = new PlayerController(worker, new FakeAudio());
    worker.emit({ type: 'state', state: 'buffering' });
    worker.onerror?.({ message: 'Failed to fetch module' } as ErrorEvent);
    expect(c.getSnapshot().error).toEqual({ code: 'internal', message: 'The player engine stopped unexpectedly: Failed to fetch module', paths: [] });
    expect(c.getSnapshot().engineState).toBe('error'); // no spinner left behind
    worker.onmessageerror?.({} as MessageEvent);
    expect(c.getSnapshot().error?.code).toBe('internal');
  });

  it('starts audio and attaches the ring once, then opens the disc', async () => {
    const worker = new FakeWorker();
    const audio = new FakeAudio();
    const c = new PlayerController(worker, audio);
    const file = new File(['x'], 'index.bdmv');
    c.open([['Disc/BDMV/index.bdmv', file]]);
    c.play();
    await Promise.resolve();
    await Promise.resolve();
    expect(worker.posted).toEqual([
      { type: 'open', disc: { kind: 'files', entries: [['Disc/BDMV/index.bdmv', file]] } },
      { type: 'play' },
      { type: 'attachAudio', ring: audio.ring },
    ]);
    expect(audio.starts).toBe(2);
  });

  it('opens a served disc (the dev disc server speaks the NAS API) with openRemote, starting audio in the gesture', async () => {
    const worker = new FakeWorker();
    const audio = new FakeAudio();
    const c = new PlayerController(worker, audio);
    const spec = { kind: 'remote', base: 'https://192.168.1.5:8443/api/discs/abc/', token: 'tok', manifest: { discId: 'abc', name: 'Disc', files: [], inline: {} } } as const;
    c.openRemote(spec);
    expect(c.getSnapshot().engineState).toBe('loading');
    await Promise.resolve();
    await Promise.resolve();
    expect(worker.posted).toEqual([
      { type: 'open', disc: spec },
      { type: 'attachAudio', ring: audio.ring },
    ]);
    expect(audio.starts).toBe(1);
  });

  it('opens a NAS disc, answers the engine\'s token requests and relays scheduled refreshes', async () => {
    const worker = new FakeWorker();
    const c = new PlayerController(worker, new FakeAudio());
    const spec = { kind: 'remote', base: 'https://nas.example/bluray/api/discs/d1/', token: 't1', manifest: { discId: 'd1', name: 'Disc', files: [], inline: {} } } as const;
    let refreshes = 0;
    c.openRemote(spec, async () => `t${++refreshes + 1}`);
    expect(c.getSnapshot().engineState).toBe('loading');
    expect(worker.posted[0]).toEqual({ type: 'open', disc: spec });
    worker.emit({ type: 'remoteTokenNeeded' });
    await Promise.resolve();
    await Promise.resolve();
    expect(worker.posted).toContainEqual({ type: 'remoteToken', token: 't2' });
    c.setRemoteToken('t9');
    expect(worker.posted.at(-1)).toEqual({ type: 'remoteToken', token: 't9' });
  });

  it("transfers a NAS disc's fetch port, and releases what serves it only once the engine has closed that port", () => {
    const worker = new FakeWorker();
    const c = new PlayerController(worker, new FakeAudio());
    const { port1, port2 } = new MessageChannel();
    const spec = { kind: 'remote', base: 'rtc://n/api/discs/d1/', token: 't1', manifest: { discId: 'd1', name: 'Disc', files: [], inline: {} }, fetchPort: port2 } as const;
    const released: string[] = [];
    c.openRemote(spec, undefined, () => released.push('first'));
    expect(worker.posted[0]).toEqual({ type: 'open', disc: spec });
    expect(worker.transfers[0]).toEqual([port2]);
    c.openRemote({ ...spec, fetchPort: port1 }, undefined, () => released.push('second'));
    expect(released).toEqual([]); // the engine may still be reading the first disc
    worker.emit({ type: 'fetchPortClosed' });
    expect(released).toEqual(['first']);
    c.closeDisc();
    expect(released).toEqual(['first']);
    worker.emit({ type: 'fetchPortClosed' });
    expect(released).toEqual(['first', 'second']);
    worker.emit({ type: 'fetchPortClosed' }); // nothing left: no harm
    expect(released).toEqual(['first', 'second']);
    expect(c.getSnapshot().error).toBeNull();
  });

  it('releases a replaced serving after 5 s when the engine never reports its port closed, keeping later ones in step', () => {
    vi.useFakeTimers();
    try {
      const worker = new FakeWorker();
      const c = new PlayerController(worker, new FakeAudio());
      const { port1, port2 } = new MessageChannel();
      const spec = { kind: 'remote', base: 'rtc://n/api/discs/d1/', token: 't1', manifest: { discId: 'd1', name: 'Disc', files: [], inline: {} } } as const;
      const released: string[] = [];
      c.openRemote({ ...spec, fetchPort: port1 }, undefined, () => released.push('first'));
      vi.advanceTimersByTime(60_000);
      expect(released).toEqual([]); // still the open disc
      c.openRemote({ ...spec, fetchPort: port2 }, undefined, () => released.push('second'));
      vi.advanceTimersByTime(FETCH_PORT_RELEASE_MS - 1);
      expect(released).toEqual([]);
      vi.advanceTimersByTime(1);
      expect(released).toEqual(['first']);
      worker.emit({ type: 'fetchPortClosed' }); // the first port's, late
      expect(released).toEqual(['first']);
      worker.emit({ type: 'fetchPortClosed' }); // the second disc failed to open
      expect(released).toEqual(['first', 'second']);
      // an HTTPS disc has no port: its release runs as it opens
      c.openRemote(spec, undefined, () => released.push('https'));
      expect(released).toEqual(['first', 'second', 'https']);
    } finally {
      vi.useRealTimers();
    }
  });

  it('shows the NAS waiting notice until the engine clears it', () => {
    const worker = new FakeWorker();
    const c = new PlayerController(worker, new FakeAudio());
    worker.emit({ type: 'notice', code: 'nas-waiting', message: 'Waiting for the NAS drive…' });
    expect(c.getSnapshot().notices).toEqual([{ code: 'nas-waiting', message: 'Waiting for the NAS drive…' }]);
    worker.emit({ type: 'noticeCleared', code: 'nas-waiting' });
    expect(c.getSnapshot().notices).toEqual([]);
  });

  it('notifies subscribers with new snapshots from worker events', () => {
    const worker = new FakeWorker();
    const c = new PlayerController(worker, new FakeAudio());
    let calls = 0;
    const unsubscribe = c.subscribe(() => calls++);
    const before = c.getSnapshot();
    worker.emit({ type: 'state', state: 'buffering' });
    expect(calls).toBe(1);
    expect(c.getSnapshot()).not.toBe(before);
    expect(c.getSnapshot().engineState).toBe('buffering');
    unsubscribe();
    worker.emit({ type: 'state', state: 'playing' });
    expect(calls).toBe(1);
  });

  it('toggles play/pause based on engine state and clamps seeks and volume', () => {
    const worker = new FakeWorker();
    const audio = new FakeAudio();
    const c = new PlayerController(worker, audio);
    worker.emit({ type: 'chapters', playlistId: '00000', durationUs: 8_000_000, chapters: [] });
    worker.emit({ type: 'state', state: 'playing' });
    worker.emit({ type: 'time', timeUs: 7_000_000 });
    worker.posted.length = 0;
    c.togglePlay();
    c.seekBy(10_000_000);
    c.seek(-5);
    c.setVolume(1.7);
    c.toggleMute();
    expect(worker.posted).toEqual([{ type: 'pause' }, { type: 'seek', timeUs: 8_000_000 }, { type: 'seek', timeUs: 0 }]);
    expect(audio.volume).toBe(1);
    expect(audio.muted).toBe(true);
    expect(c.getSnapshot()).toMatchObject({ volume: 1, muted: true });
  });

  it('adjustVolume unmutes, so the change is audible', () => {
    const audio = new FakeAudio();
    const c = new PlayerController(new FakeWorker(), audio);
    c.setVolume(0.5);
    c.toggleMute();
    c.adjustVolume(0.1);
    expect(audio.muted).toBe(false);
    expect(audio.volume).toBeCloseTo(0.6);
    expect(c.getSnapshot()).toMatchObject({ muted: false });
    c.adjustVolume(-5);
    expect(c.getSnapshot().volume).toBe(0);
  });

  it('adds a notice when audio cannot start', async () => {
    const audio = new FakeAudio();
    audio.fail = true;
    const c = new PlayerController(new FakeWorker(), audio);
    c.startAudio();
    await new Promise((r) => setTimeout(r, 0));
    expect(c.getSnapshot().notices).toEqual([{ code: 'audio-output', message: 'Audio output could not start: no audio device' }]);
  });

  it('startAudio resolves once the ring has been posted to the engine', async () => {
    const worker = new FakeWorker();
    const c = new PlayerController(worker, new FakeAudio());
    await c.startAudio();
    expect(worker.posted.some((m) => (m as { type: string }).type === 'attachAudio')).toBe(true);
  });

  it('startAudio resolves (not rejects) when audio cannot start', async () => {
    const audio = new FakeAudio();
    audio.fail = true;
    const c = new PlayerController(new FakeWorker(), audio);
    await expect(c.startAudio()).resolves.toBeUndefined();
    expect(c.getSnapshot().notices).toHaveLength(1);
  });

  it('attaches the ring after a retry when the first audio start failed', async () => {
    const worker = new FakeWorker();
    const audio = new FakeAudio();
    audio.fail = true;
    const c = new PlayerController(worker, audio);
    c.startAudio();
    await new Promise((r) => setTimeout(r, 0));
    expect(c.getSnapshot().notices).toHaveLength(1);

    audio.fail = false;
    c.startAudio();
    await new Promise((r) => setTimeout(r, 0));
    expect(worker.posted.filter((m) => (m as { type: string }).type === 'attachAudio')).toEqual([{ type: 'attachAudio', ring: audio.ring }]);
  });
});

describe('audio tracks', () => {
  const tracks: AudioTrack[] = [
    { index: 1, codec: 'LPCM', language: 'jpn', channels: 'stereo', playable: true },
    { index: 2, codec: 'DTS-HD (secondary)', language: 'eng', channels: 'stereo', playable: false },
    { index: 3, codec: 'Dolby Digital (AC-3)', language: 'eng', channels: 'multichannel', playable: true },
  ];

  it('stores tracks and clears them with the playlist', () => {
    let s = reduceEvent(INITIAL_SNAPSHOT, { type: 'tracks', audio: tracks, selectedAudio: 1 });
    expect(s).toMatchObject({ audioTracks: tracks, selectedAudio: 1 });
    s = reduceEvent(s, { type: 'playlistCleared' });
    expect(s).toMatchObject({ audioTracks: [], selectedAudio: null });
  });

  it('selects a playable track with a confirmation notice and ignores the rest', () => {
    const worker = new FakeWorker();
    const c = new PlayerController(worker, new FakeAudio());
    worker.emit({ type: 'tracks', audio: tracks, selectedAudio: 1 });
    worker.posted.length = 0;
    c.selectAudio(2);
    c.selectAudio(1);
    c.selectAudio(3);
    expect(worker.posted).toEqual([{ type: 'selectAudio', index: 3 }]);
    expect(c.getSnapshot().notices).toContainEqual({ code: 'audio-track', message: 'Audio: 3. English · Dolby Digital (AC-3) (multichannel)' });
  });

  it('cycles through playable tracks and wraps around', () => {
    const worker = new FakeWorker();
    const c = new PlayerController(worker, new FakeAudio());
    worker.emit({ type: 'tracks', audio: tracks, selectedAudio: 3 });
    worker.posted.length = 0;
    c.cycleAudio();
    expect(worker.posted).toEqual([{ type: 'selectAudio', index: 1 }]);
  });

  it('shows a selection at once, so quick A presses move on before the engine confirms', () => {
    const worker = new FakeWorker();
    const c = new PlayerController(worker, new FakeAudio());
    worker.emit({ type: 'tracks', audio: tracks, selectedAudio: 1 });
    worker.posted.length = 0;
    c.cycleAudio();
    expect(c.getSnapshot().selectedAudio).toBe(3);
    c.cycleAudio();
    expect(worker.posted).toEqual([
      { type: 'selectAudio', index: 3 },
      { type: 'selectAudio', index: 1 },
    ]);
    worker.emit({ type: 'tracks', audio: tracks, selectedAudio: 3 }); // the engine's word wins
    expect(c.getSnapshot().selectedAudio).toBe(3);
  });
});

describe('menus', () => {
  const make = () => {
    const worker = new FakeWorker();
    const controller = new PlayerController(worker, new FakeAudio());
    return { worker, controller };
  };

  it('tracks whether a menu is shown and whether a pop-up is available', () => {
    let s = reduceEvent(INITIAL_SNAPSHOT, { type: 'menuActive', active: true, popupAvailable: true });
    expect(s).toMatchObject({ menuActive: true, popupAvailable: true });
    s = reduceEvent(s, { type: 'menuActive', active: false, popupAvailable: false });
    expect(s).toMatchObject({ menuActive: false, popupAvailable: false });
  });

  it('tracks the button under the pointer and forgets it when the menu closes', () => {
    let s = reduceEvent({ ...INITIAL_SNAPSHOT, menuActive: true }, { type: 'pointerTarget', button: 3 });
    expect(s.pointerButton).toBe(3);
    s = reduceEvent(s, { type: 'menuActive', active: false, popupAvailable: false });
    expect(s.pointerButton).toBeNull();
  });

  it('counts menu clicks that missed every button', () => {
    let s = reduceEvent({ ...INITIAL_SNAPSHOT, menuActive: true }, { type: 'menuTapMissed' });
    s = reduceEvent(s, { type: 'menuTapMissed' });
    expect(s.menuTapMisses).toBe(2);
  });

  it('posts menu keys and pointer moves and clicks', () => {
    const { worker, controller } = make();
    controller.menuKey('ok');
    controller.pointer('move', 10, 20);
    controller.pointer('click', 30, 40);
    expect(worker.posted).toEqual([
      { type: 'menuKey', key: 'ok' },
      { type: 'pointer', kind: 'move', x: 10, y: 20 },
      { type: 'pointer', kind: 'click', x: 30, y: 40 },
    ]);
  });
});

describe('UO masks', () => {
  it('exposes the masked operations', () => {
    const worker = new FakeWorker();
    const controller = new PlayerController(worker, new FakeAudio());
    expect(controller.isMasked('timeSearch')).toBe(false);
    worker.emit({ type: 'uoMask', masked: ['timeSearch'] });
    expect(controller.getSnapshot().uoMask).toEqual(['timeSearch']);
    expect(controller.isMasked('timeSearch')).toBe(true);
    expect(controller.isMasked('pauseOn')).toBe(false);
  });

  it('refuses a masked key locally with the same notice, without posting', () => {
    const worker = new FakeWorker();
    const controller = new PlayerController(worker, new FakeAudio());
    worker.emit({ type: 'uoMask', masked: ['timeSearch'] });
    expect(controller.allow('timeSearch')).toBe(false);
    expect(controller.getSnapshot().notices).toContainEqual({ code: 'uo-masked', message: "The disc doesn't allow this here." });
    expect(controller.allow('pauseOn')).toBe(true);
  });
});

describe('titles and the top menu', () => {
  it('keeps the index titles and whether there is a top menu', () => {
    const s = reduceEvent(INITIAL_SNAPSHOT, { type: 'indexTitles', titles: [{ number: 1, kind: 'hdmv' }, { number: 2, kind: 'bdj' }], hasTopMenu: true });
    expect(s.indexTitles).toEqual({ titles: [{ number: 1, kind: 'hdmv' }, { number: 2, kind: 'bdj' }], hasTopMenu: true });
    expect(reduceEvent(s, { type: 'titles', playlists: [], usesBdj: false, bdjSupported: false, warnings: [] }).indexTitles).toBeNull();
  });

  it('records BD-J support and whether a BD-J title runs; the menu state and the ignored-tap notice go when BD-J stops', () => {
    let s = reduceEvent(INITIAL_SNAPSHOT, { type: 'titles', playlists: [summary], usesBdj: true, bdjSupported: true, warnings: [] });
    expect(s).toMatchObject({ usesBdj: true, bdjSupported: true, bdjActive: false, bdjMenuVisible: false });
    s = reduceEvent(s, { type: 'bdjActive', active: true });
    s = reduceEvent(s, { type: 'bdjMenu', visible: true });
    s = reduceEvent(s, { type: 'notice', code: 'bdj-tap-ignored', message: 'ignored' });
    expect(s).toMatchObject({ bdjActive: true, bdjMenuVisible: true, notices: [{ code: 'bdj-tap-ignored', message: 'ignored' }] });
    s = reduceEvent(s, { type: 'bdjActive', active: false });
    s = reduceEvent(s, { type: 'notice', code: 'bdj-failed', message: 'failed' });
    expect(s).toMatchObject({ bdjActive: false, bdjMenuVisible: false });
    expect(s.notices.map((n) => n.code)).toEqual(['bdj-failed']);
    s = reduceEvent(s, { type: 'bdjActive', active: true });
    s = reduceEvent(s, { type: 'bdjMenu', visible: true });
    expect(reduceEvent(s, { type: 'titles', playlists: [], usesBdj: false, bdjSupported: false, warnings: [] })).toMatchObject({ bdjActive: false, bdjSupported: false, bdjMenuVisible: false });
  });

  it('follows the BD-J menu turning visible and empty', () => {
    let s = reduceEvent(INITIAL_SNAPSHOT, { type: 'bdjMenu', visible: true });
    expect(s.bdjMenuVisible).toBe(true);
    s = reduceEvent(s, { type: 'bdjMenu', visible: false });
    expect(s.bdjMenuVisible).toBe(false);
  });

  it('counts the taps the disc ignored (each opens the remote)', () => {
    let s = reduceEvent(INITIAL_SNAPSHOT, { type: 'bdjTapIgnored' });
    s = reduceEvent(s, { type: 'bdjTapIgnored' });
    expect(s.bdjTapsIgnored).toBe(2);
    expect(s.notices).toEqual([]); // the notice is the engine's, once per menu
  });

  it('asks for the remote on the first ignored tap of each BD-J menu only', () => {
    let s = reduceEvent(INITIAL_SNAPSHOT, { type: 'bdjActive', active: true });
    s = reduceEvent(s, { type: 'bdjMenu', visible: true });
    s = reduceEvent(s, { type: 'bdjTapIgnored' });
    expect(s).toMatchObject({ bdjTapsIgnored: 1, bdjRemoteRequests: 1, bdjRemoteOpenedInMenu: true });
    // the user closed the remote: later ignored taps in this menu do not force it open again
    s = reduceEvent(s, { type: 'bdjTapIgnored' });
    s = reduceEvent(s, { type: 'bdjTapIgnored' });
    expect(s).toMatchObject({ bdjTapsIgnored: 3, bdjRemoteRequests: 1 });
    // a repeated visible report is the same menu
    s = reduceEvent(s, { type: 'bdjMenu', visible: true });
    s = reduceEvent(s, { type: 'bdjTapIgnored' });
    expect(s.bdjRemoteRequests).toBe(1);
    // the plane empties and shows again: a new menu
    s = reduceEvent(s, { type: 'bdjMenu', visible: false });
    s = reduceEvent(s, { type: 'bdjTapIgnored' }); // (the engine sends none on an empty plane; still not a new menu)
    expect(s.bdjRemoteRequests).toBe(1);
    s = reduceEvent(s, { type: 'bdjMenu', visible: true });
    s = reduceEvent(s, { type: 'bdjTapIgnored' });
    expect(s).toMatchObject({ bdjRemoteRequests: 2, bdjRemoteOpenedInMenu: true });
    // BD-J stopping ends the menu too
    s = reduceEvent(s, { type: 'bdjActive', active: false });
    expect(s.bdjRemoteOpenedInMenu).toBe(false);
  });

  it('the controller opens the remote once per menu from the engine events', () => {
    const worker = new FakeWorker();
    const c = new PlayerController(worker, new FakeAudio());
    worker.emit({ type: 'bdjActive', active: true });
    worker.emit({ type: 'bdjMenu', visible: true });
    worker.emit({ type: 'bdjTapIgnored' });
    worker.emit({ type: 'notice', code: 'bdj-tap-ignored', message: 'ignored' });
    worker.emit({ type: 'bdjTapIgnored' });
    expect(c.getSnapshot()).toMatchObject({ bdjRemoteRequests: 1, bdjTapsIgnored: 2 });
  });

  it('drops the ignored-tap notice when the user picks a playlist (BD-J stops)', () => {
    const worker = new FakeWorker();
    const c = new PlayerController(worker, new FakeAudio());
    worker.emit({ type: 'notice', code: 'bdj-tap-ignored', message: 'ignored' });
    c.playPlaylist('00000');
    expect(c.getSnapshot().notices).toEqual([]);
  });

  it('posts menu keys, marking a held key\'s repeats', () => {
    const worker = new FakeWorker();
    const c = new PlayerController(worker, new FakeAudio());
    c.menuKey('down');
    c.menuKey('down', true);
    expect(worker.posted).toEqual([{ type: 'menuKey', key: 'down' }, { type: 'menuKey', key: 'down', repeat: true }]);
  });

  it('posts playTitle and menuCall', () => {
    const worker = new FakeWorker();
    const controller = new PlayerController(worker, new FakeAudio());
    controller.playTitle(1);
    controller.menuCall();
    expect(worker.posted).toEqual([{ type: 'playTitle', title: 1 }, { type: 'menuCall' }]);
  });
});

describe('menu sounds', () => {
  it('loads the disc sounds into the audio output and plays them by id', () => {
    const worker = new FakeWorker();
    const audio = new FakeAudio();
    new PlayerController(worker, audio);
    worker.emit({ type: 'soundEffects', clips: [{ channels: 1, samples: new Int16Array(4) }, { channels: 2, samples: new Int16Array(8) }] });
    worker.emit({ type: 'soundEffect', id: 1 });
    expect(audio.loaded).toEqual([2]);
    expect(audio.played).toEqual([1]);
  });
});

describe('subtitles', () => {
  const subs = (over: Partial<Extract<EngineEvent, { type: 'subtitles' }>> = {}): EngineEvent => ({
    type: 'subtitles', pg: [{ index: 1, language: 'eng' }, { index: 2, language: 'jpn' }], text: null, selected: 'off', scale: 1, ...over,
  });
  const oneFile = { files: [{ name: 'a.srt', format: 'srt' as const, cues: 3, startUs: 0, offsetMs: 0 }], missingFonts: [], episodeStarts: [0] };
  const posted = (w: FakeWorker) => w.posted as Array<{ type: string } & Record<string, unknown>>;

  it('puts the subtitles state and the encoding prompt in the snapshot; a new disc clears them', () => {
    let s = reduceEvent(INITIAL_SNAPSHOT, subs({ selected: { pg: 2 }, text: oneFile }));
    s = reduceEvent(s, { type: 'subtitleEncodingNeeded', names: ['a.srt', 'b.ass'] });
    expect(s.subtitles).toEqual({ pg: [{ index: 1, language: 'eng' }, { index: 2, language: 'jpn' }], text: oneFile, selected: { pg: 2 }, scale: 1 });
    expect(s.encodingPrompt).toEqual({ names: ['a.srt', 'b.ass'] });
    s = reduceEvent(s, { type: 'titles', playlists: [summary], usesBdj: false, bdjSupported: false, warnings: [] });
    expect(s.subtitles).toBeNull();
    expect(s.encodingPrompt).toBeNull();
  });

  it('selects, shifts by absolute offsets with a notice, and scales in steps', () => {
    const worker = new FakeWorker();
    const c = new PlayerController(worker, new FakeAudio());
    worker.emit(subs({ text: oneFile, selected: 'text' }));
    c.selectSubtitle({ kind: 'pg', stream: 2 });
    c.shiftSubtitles(100);
    c.shiftSubtitles(100);
    c.scaleSubtitles(0.1);
    c.scaleSubtitles(5);
    expect(posted(worker)).toEqual([
      { type: 'selectSubtitle', choice: { kind: 'pg', stream: 2 } },
      { type: 'setSubtitleOffset', file: 0, ms: 100 },
      { type: 'setSubtitleOffset', file: 0, ms: 200 },
      { type: 'setSubtitleScale', scale: 1.1 },
      { type: 'setSubtitleScale', scale: 2 },
    ]);
    expect(c.getSnapshot().notices).toContainEqual({ code: 'subtitle-offset', message: 'Subtitles +0.2 s' });
    c.shiftSubtitles(-500);
    expect(c.getSnapshot().notices).toContainEqual({ code: 'subtitle-offset', message: 'Subtitles −0.3 s' });
  });

  it('cycles Off → each PG track → the file → Off', () => {
    const worker = new FakeWorker();
    const c = new PlayerController(worker, new FakeAudio());
    worker.emit(subs({ text: oneFile }));
    for (let i = 0; i < 4; i++) c.cycleSubtitles();
    expect(posted(worker).map((m) => m.choice)).toEqual([{ kind: 'pg', stream: 1 }, { kind: 'pg', stream: 2 }, { kind: 'text' }, { kind: 'off' }]);
  });

  it('refuses a masked subtitle change with the notice and sends nothing', () => {
    const worker = new FakeWorker();
    const c = new PlayerController(worker, new FakeAudio());
    worker.emit(subs({ selected: { pg: 1 } }));
    worker.emit({ type: 'uoMask', masked: ['pgChange'] });
    c.selectSubtitle({ kind: 'pg', stream: 2 });
    expect(worker.posted).toEqual([]);
    expect(c.getSnapshot().notices.map((n) => n.code)).toEqual(['uo-masked']);
    c.selectSubtitle({ kind: 'off' }); // only the display flag: pgEnableDisable is not masked
    expect(posted(worker)).toEqual([{ type: 'selectSubtitle', choice: { kind: 'off' } }]);
  });

  it('refuses a file far too large to be subtitles with a notice, without reading it', async () => {
    const worker = new FakeWorker();
    const c = new PlayerController(worker, new FakeAudio());
    let read = false;
    const huge = { name: 'movie.mkv', size: 4 * 1024 ** 3, arrayBuffer: async () => { read = true; return new ArrayBuffer(0); } } as unknown as File;
    await c.loadSubtitleFile(huge);
    expect(read).toBe(false);
    expect(worker.posted).toEqual([]);
    expect(c.getSnapshot().notices).toContainEqual({ code: 'subtitle-file', message: 'This file is too large to be a subtitle file' });
  });

  it('sends a loaded file\'s bytes, and sends them again with the encoding the user picks', async () => {
    const worker = new FakeWorker();
    const c = new PlayerController(worker, new FakeAudio());
    const file = new File([Uint8Array.of(0x63, 0x61, 0x66, 0xe9)], 'latin.srt');
    await c.loadSubtitleFile(file);
    const first = posted(worker)[0]!;
    const sent = first.files as Array<{ name: string; bytes: ArrayBuffer }>;
    expect(first.type).toBe('addTextSubtitles');
    expect(sent[0]!.name).toBe('latin.srt');
    expect([...new Uint8Array(sent[0]!.bytes)]).toEqual([0x63, 0x61, 0x66, 0xe9]);
    expect(first.encoding).toBeUndefined();
    worker.emit({ type: 'subtitleEncodingNeeded', names: ['latin.srt'] });
    await c.answerEncoding('windows-1252');
    expect(c.getSnapshot().encodingPrompt).toBeNull();
    expect(posted(worker)[1]).toMatchObject({ type: 'addTextSubtitles', encoding: 'windows-1252' });
    worker.emit({ type: 'subtitleEncodingNeeded', names: ['latin.srt'] });
    await c.answerEncoding(null);
    expect(c.getSnapshot().encodingPrompt).toBeNull();
    expect(worker.posted).toHaveLength(2);
    c.removeSubtitleFile();
    expect(posted(worker)[2]).toEqual({ type: 'removeTextSubtitle' });
  });

  describe('subtitle sets', () => {
    const file = (name: string, size = 3) => ({ name, size, arrayBuffer: async () => new ArrayBuffer(size) }) as unknown as File;
    const twoFiles = { files: [{ name: 'ep1.ass', format: 'ass' as const, cues: 3, startUs: 0, offsetMs: 0 }, { name: 'ep2.ass', format: 'ass' as const, cues: 3, startUs: 1_000_000, offsetMs: 0 }], missingFonts: [], episodeStarts: [0, 1_000_000] };

    it('sends the subtitle files and fonts of a pick in one load, transferring every buffer', async () => {
      const worker = new FakeWorker();
      const c = new PlayerController(worker, new FakeAudio());
      await c.loadSubtitleFiles([file('a.ass'), file('b.srt'), file('x.ttf'), file('y.otf')]);
      const sent = posted(worker)[0]!;
      expect(sent.type).toBe('addTextSubtitles');
      expect((sent.files as { name: string }[]).map((f) => f.name)).toEqual(['a.ass', 'b.srt']);
      expect((sent.fonts as { name: string }[]).map((f) => f.name)).toEqual(['x.ttf', 'y.otf']);
      expect(worker.transfers.at(-1)).toHaveLength(4);
    });

    it('skips fonts over the size limit and subtitle files past 64, with notices', async () => {
      const worker = new FakeWorker();
      const c = new PlayerController(worker, new FakeAudio());
      const many = Array.from({ length: 65 }, (_, i) => file(`ep${i}.srt`));
      await c.loadSubtitleFiles([...many, file('huge.ttf', 70 * 1024 * 1024), file('ok.ttf')]);
      const sent = posted(worker)[0]!;
      expect((sent.files as unknown[]).length).toBe(64);
      expect((sent.fonts as { name: string }[]).map((f) => f.name)).toEqual(['ok.ttf']);
      expect(c.getSnapshot().notices).toContainEqual({ code: 'subtitle-fonts', message: 'Fonts over the size limit were skipped: huge.ttf' });
      expect(c.getSnapshot().notices).toContainEqual({ code: 'subtitle-file', message: 'Only the first 64 subtitle files were loaded' });
    });

    it('sends a pick of fonts alone as more fonts for an ASS set', async () => {
      const worker = new FakeWorker();
      const c = new PlayerController(worker, new FakeAudio());
      worker.emit(subs({ text: twoFiles, selected: 'text' }));
      await c.loadSubtitleFiles([file('x.ttf')]);
      expect(posted(worker)[0]).toMatchObject({ type: 'addSubtitleFonts' });
    });

    it('resends the whole load with the encoding the user picks', async () => {
      const worker = new FakeWorker();
      const c = new PlayerController(worker, new FakeAudio());
      await c.loadSubtitleFiles([file('a.srt'), file('x.ttf')]);
      worker.emit({ type: 'subtitleEncodingNeeded', names: ['a.srt'] });
      await c.answerEncoding('windows-1252');
      expect(posted(worker)[1]).toMatchObject({ type: 'addTextSubtitles', encoding: 'windows-1252' });
      expect((posted(worker)[1]!.fonts as unknown[]).length).toBe(1);
    });

    it('places a file and shifts the one showing now', () => {
      const worker = new FakeWorker();
      const c = new PlayerController(worker, new FakeAudio());
      worker.emit(subs({ text: twoFiles, selected: 'text' }));
      c.setSubtitleStart(1, 2_000_000);
      c.shiftSubtitles(100); // nothing showing: no telemetry yet, two files
      worker.emit({ type: 'telemetry', telemetry: { textFile: 1 } as unknown as Telemetry });
      c.shiftSubtitles(100);
      expect(posted(worker)).toEqual([{ type: 'setSubtitleStart', file: 1, startUs: 2_000_000 }, { type: 'setSubtitleOffset', file: 1, ms: 100 }]);
    });
  });
});

describe('shaders', () => {
  const tel = (presented: number, dropped: number): Telemetry => ({ framesPresented: presented, framesDropped: dropped }) as unknown as Telemetry;
  const setup = (): { c: PlayerController; worker: FakeWorker; t: { now: number }; feed: (sec: number, rate: number) => void } => {
    const worker = new FakeWorker();
    const t = { now: 0 };
    const c = new PlayerController(worker, new FakeAudio(), { nowMs: () => t.now });
    let presented = 0;
    let dropped = 0;
    const feed = (sec: number, rate: number): void => {
      for (let i = 0; i < sec; i++) {
        t.now += 1000;
        dropped += Math.round(120 * rate);
        presented += 120 - Math.round(120 * rate);
        worker.emit({ type: 'telemetry', telemetry: tel(presented, dropped) });
      }
    };
    return { c, worker, t, feed };
  };

  it('maps shaderStatus into the snapshot', () => {
    expect(INITIAL_SNAPSHOT.shaders).toEqual({ state: 'off', set: null, error: null });
    const s = reduceEvent(INITIAL_SNAPSHOT, { type: 'shaderStatus', state: 'error', set: 'A', error: 'bad' });
    expect(s.shaders).toEqual({ state: 'error', set: 'A', error: 'bad' });
  });

  it('posts setVideoShaders', () => {
    const { c, worker } = setup();
    c.setShaderSet(null);
    const set = { name: 'A', files: [{ name: 'a.glsl', source: 'x' }] };
    c.setShaderSet(set);
    expect(worker.posted).toEqual([
      { type: 'setVideoShaders', set: null },
      { type: 'setVideoShaders', set },
    ]);
  });

  it('warns above 5 % drops while active, not at 2 %', () => {
    const { c, worker, feed } = setup();
    worker.emit({ type: 'shaderStatus', state: 'active', set: 'A', error: null });
    feed(6, 0.2);
    expect(c.getSnapshot().shaderDropWarning).toBeCloseTo(0.2, 5);
    const b = setup();
    b.worker.emit({ type: 'shaderStatus', state: 'active', set: 'A', error: null });
    b.feed(6, 0.02);
    expect(b.c.getSnapshot().shaderDropWarning).toBeNull();
  });

  it('never warns without an active set, and off clears the warning and the meter', () => {
    const { c, worker, feed } = setup();
    feed(6, 0.2);
    expect(c.getSnapshot().shaderDropWarning).toBeNull();
    worker.emit({ type: 'shaderStatus', state: 'active', set: 'A', error: null });
    feed(6, 0.2);
    expect(c.getSnapshot().shaderDropWarning).not.toBeNull();
    worker.emit({ type: 'shaderStatus', state: 'off', set: null, error: null });
    expect(c.getSnapshot().shaderDropWarning).toBeNull();
    worker.emit({ type: 'shaderStatus', state: 'active', set: 'A', error: null });
    feed(1, 0.2); // under 1 s of fresh samples
    expect(c.getSnapshot().shaderDropWarning).toBeNull();
  });
});

describe('platform audio suspension', () => {
  function setup() {
    const worker = new FakeWorker();
    const audio = new FakeAudio();
    let hidden = false;
    let onVis: () => void = () => undefined;
    const c = new PlayerController(worker, audio, { visibility: { hidden: () => hidden, onChange: (cb) => (onVis = cb) } });
    worker.emit({ type: 'state', state: 'playing' });
    return { worker, audio, c, setHidden: (h: boolean) => { hidden = h; onVis(); } };
  }
  const message = 'Playback paused while the app was in the background.';

  it('pauses when hidden and suspended, and shows the notice when the page is visible again', () => {
    const { worker, audio, c, setHidden } = setup();
    setHidden(true);
    audio.stateCb?.('suspended');
    expect(worker.posted).toEqual([{ type: 'pause' }]);
    expect(c.getSnapshot().notices).toEqual([]);
    setHidden(false);
    expect(c.getSnapshot().notices).toEqual([{ code: 'background-pause', message }]);
    expect(worker.posted).toEqual([{ type: 'pause' }]); // never auto-resumes
  });

  it('keeps playing when hidden while the audio stays running', () => {
    const { worker, audio, c, setHidden } = setup();
    setHidden(true);
    audio.stateCb?.('running');
    setHidden(false);
    expect(worker.posted).toEqual([]);
    expect(c.getSnapshot().notices).toEqual([]);
  });

  it('pauses with the notice at once on an interruption while visible', () => {
    const { worker, audio, c } = setup();
    audio.stateCb?.('interrupted');
    expect(worker.posted).toEqual([{ type: 'pause' }]);
    expect(c.getSnapshot().notices).toEqual([{ code: 'background-pause', message }]);
  });

  it('keeps the notice when a playlist starts', () => {
    const { audio, c } = setup();
    audio.stateCb?.('interrupted');
    c.playPlaylist('00000');
    expect(c.getSnapshot().notices.map((n) => n.code)).toContain('background-pause');
  });
});

describe('opening at a place', () => {
  const start = { playlistId: '00001', timeUs: 5_000_000, hdmv: null, playback: { psr1: 2, psr2: 0, psr3: 1 } } as const;

  it('sends the start point with a local or a NAS open', () => {
    const worker = new FakeWorker();
    const c = new PlayerController(worker, new FakeAudio());
    const file = new File(['x'], 'index.bdmv');
    c.open([['Disc/BDMV/index.bdmv', file]], start);
    expect(worker.posted[0]).toEqual({ type: 'open', disc: { kind: 'files', entries: [['Disc/BDMV/index.bdmv', file]] }, start });
    const spec = { kind: 'remote', base: 'https://nas.example/bluray/api/discs/d1/', token: 't1', manifest: { discId: 'd1', name: 'Disc', files: [], inline: {} } } as const;
    c.openRemote(spec, undefined, undefined, undefined, start);
    expect(worker.posted.at(-1)).toEqual({ type: 'open', disc: spec, start });
  });

  it('readPlace resolves with the next placeState', async () => {
    const worker = new FakeWorker();
    const c = new PlayerController(worker, new FakeAudio());
    const first = c.readPlace();
    const second = c.readPlace();
    expect(worker.posted).toEqual([{ type: 'readPlace' }, { type: 'readPlace' }]);
    worker.emit({ type: 'placeState', mode: 'hdmv', title: 2, psrs: [1, 2], gprs: { 5: 9 } });
    await expect(first).resolves.toEqual({ mode: 'hdmv', title: 2, psrs: [1, 2], gprs: { 5: 9 } });
    await expect(second).resolves.toEqual({ mode: 'hdmv', title: 2, psrs: [1, 2], gprs: { 5: 9 } });
    const third = c.readPlace();
    worker.emit({ type: 'placeState', mode: 'none', title: null, psrs: [], gprs: null });
    await expect(third).resolves.toEqual({ mode: 'none', title: null, psrs: [], gprs: null });
  });

  it('readPlace rejects pending and later reads once the engine worker fails', async () => {
    for (const fail of [(w: FakeWorker) => w.onerror?.({ message: 'boom' } as ErrorEvent), (w: FakeWorker) => w.onmessageerror?.({} as MessageEvent)]) {
      const worker = new FakeWorker();
      const c = new PlayerController(worker, new FakeAudio());
      const pending = c.readPlace();
      fail(worker);
      await expect(pending).rejects.toThrow(/player engine/);
      await expect(c.readPlace()).rejects.toThrow(/player engine/);
      expect(worker.posted.filter((m) => (m as { type: string }).type === 'readPlace')).toHaveLength(1);
    }
  });

  it('a read made before an open or a close resolves with the answer, which describes the disc open when it was made', async () => {
    const worker = new FakeWorker();
    const c = new PlayerController(worker, new FakeAudio());
    const beforeOpen = c.readPlace();
    c.open([], start);
    const beforeClose = c.readPlace();
    c.closeDisc();
    // the engine handles readPlace at once, in command order: its answer comes for the read posted before the open
    expect(worker.posted.map((m) => (m as { type: string }).type)).toEqual(['readPlace', 'open', 'readPlace', 'close']);
    worker.emit({ type: 'placeState', mode: 'hdmv', title: 1, psrs: [], gprs: {} });
    await expect(beforeOpen).resolves.toMatchObject({ mode: 'hdmv', title: 1 });
    await expect(beforeClose).resolves.toMatchObject({ mode: 'hdmv', title: 1 });
  });

  it('records startFailed, and forgets it on the next open', () => {
    expect(INITIAL_SNAPSHOT.startFailed).toBeNull();
    expect(reduceEvent(INITIAL_SNAPSHOT, { type: 'startFailed', reason: 'past-end' }).startFailed).toBe('past-end');
    const worker = new FakeWorker();
    const c = new PlayerController(worker, new FakeAudio());
    c.open([], start);
    worker.emit({ type: 'startFailed', reason: 'no-playlist' });
    expect(c.getSnapshot().startFailed).toBe('no-playlist');
    c.open([]);
    expect(c.getSnapshot().startFailed).toBeNull();
    worker.emit({ type: 'startFailed', reason: 'past-end' });
    const spec = { kind: 'remote', base: 'https://nas.example/bluray/api/discs/d1/', token: 't1', manifest: { discId: 'd1', name: 'Disc', files: [], inline: {} } } as const;
    c.openRemote(spec);
    expect(c.getSnapshot().startFailed).toBeNull();
  });
});
