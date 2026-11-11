// SPDX-License-Identifier: LGPL-3.0-or-later
// Drive the player through PlayerController: open discs, play and seek, pick tracks and subtitles, use a disc's menu.
import type { DiscManifest } from '@seikou/nas';
import { PlayerController, createController, createEngineWorker, type AudioOutputLike, type PlayerSnapshot } from '@seikou/engine';

const DISC1 = '/developers/_examples/fixtures/disc1/';
const DISC3 = '/developers/_examples/fixtures/disc3/'; // four audio tracks
const DISC_SUBS = '/developers/_examples/fixtures/disc-subs/'; // two PG streams
const DISC_MENU = '/developers/_examples/fixtures/disc-menu/'; // an HDMV menu
const FONT = '/developers/_examples/fixtures/disc-bdj-menu/BDMV/AUXDATA/00000.otf'; // Source Sans 3
const EPISODE = '/developers/_examples/fixtures/encodes/990001/1.mkv'; // an encoded episode: AV1, Opus, ASS and PGS

const DISC1_FILES = ['BDMV/index.bdmv', 'BDMV/PLAYLIST/00000.mpls', 'BDMV/PLAYLIST/00001.mpls', 'BDMV/CLIPINF/00001.clpi', 'BDMV/CLIPINF/00002.clpi', 'BDMV/STREAM/00001.m2ts', 'BDMV/STREAM/00002.m2ts'];
const DISC3_FILES = ['BDMV/index.bdmv', 'BDMV/PLAYLIST/00000.mpls', 'BDMV/CLIPINF/00001.clpi', 'BDMV/STREAM/00001.m2ts'];
const DISC_SUBS_FILES = ['BDMV/index.bdmv', 'BDMV/MovieObject.bdmv', 'BDMV/PLAYLIST/00000.mpls', 'BDMV/PLAYLIST/00001.mpls', 'BDMV/CLIPINF/00001.clpi', 'BDMV/STREAM/00001.m2ts'];
const DISC_MENU_FILES = [...DISC1_FILES.slice(0, 5), 'BDMV/MovieObject.bdmv', 'BDMV/AUXDATA/sound.bdmv', 'BDMV/STREAM/00001.m2ts', 'BDMV/STREAM/00002.m2ts'];

/** A disc folder's files as a folder picker gives them: `[path, File]` pairs, paths starting at the folder. */
async function discFiles(dir: string, paths: readonly string[]): Promise<Array<[string, File]>> {
  const folder = dir.split('/').at(-2)!;
  return Promise.all(paths.map(async (path): Promise<[string, File]> => [`${folder}/${path}`, new File([await (await fetch(dir + path)).blob()], path.split('/').pop()!)]));
}

/** Resolves with the first snapshot that passes `test`, read through subscribe and getSnapshot. */
function until(controller: PlayerController, test: (s: PlayerSnapshot) => boolean, what: string, ms = 8_000): Promise<PlayerSnapshot> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      stop();
      reject(new Error(`timed out waiting for ${what} (state ${controller.getSnapshot().engineState})`));
    }, ms);
    const check = (): void => {
      const s = controller.getSnapshot();
      if (!test(s)) return;
      clearTimeout(timer);
      stop();
      resolve(s);
    };
    const stop = controller.subscribe(check);
    check();
  });
}

/** Notes the type of every command the page posts to `worker`, so the example can show what reached the engine. */
function recordCommands(worker: Worker, sent: string[]): Worker {
  const post = worker.postMessage.bind(worker) as (message: unknown, transfer: Transferable[]) => void;
  worker.postMessage = ((message: { type: string }, transfer: Transferable[] = []) => {
    sent.push(message.type);
    post(message, transfer);
  }) as Worker['postMessage'];
  return worker;
}

function check(ok: boolean, what: string): void {
  if (!ok) throw new Error(what);
}

export default async function example(): Promise<void> {
  const canvas = document.body.appendChild(document.createElement('canvas'));
  canvas.width = 640;
  canvas.height = 360;
  const sent: string[] = [];
  const controller = createController({ worker: () => recordCommands(createEngineWorker('engine'), sent), profile: 'desktop' });
  try {
    await tour(controller, canvas, sent);
  } finally {
    controller.closeDisc();
    canvas.remove();
  }
  await construct();
}

async function tour(controller: PlayerController, canvas: HTMLCanvasElement, sent: string[]): Promise<void> {
  // #region subscribe
  // called after every change; the snapshot is replaced, never mutated, so comparing objects tells what changed
  let last = controller.getSnapshot().engineState;
  const states: string[] = [];
  const unsubscribe = controller.subscribe(() => {
    const state = controller.getSnapshot().engineState;
    if (state !== last) states.push((last = state));
  });
  // #endregion

  // #region attachCanvas
  controller.attachCanvas(canvas); // from here on only the engine draws on it
  // #endregion

  // #region resize
  controller.resize(canvas.width, canvas.height); // again whenever the canvas's box changes size
  // #endregion

  // #region startAudio
  // from a click or key handler, so the browser lets the AudioContext start; open the disc once it resolves
  await controller.startAudio();
  // #endregion

  // #region open
  const files = await discFiles(DISC1, DISC1_FILES); // a folder pick: [file.webkitRelativePath, file] pairs
  controller.open(files);
  // #endregion
  const opened = await until(controller, (s) => s.engineState === 'idle' && s.playlists.length > 0, 'the playlists');

  // #region getSnapshot
  const snapshot = controller.getSnapshot();
  for (const p of snapshot.playlists) console.log(p.id, `${p.durationUs / 1e6} s`, p.playable ? 'playable' : 'not playable');
  // #endregion
  check(snapshot === opened && snapshot.playlists[0]?.id === '00000', 'disc1 lists its feature first');

  // #region playPlaylist
  controller.playPlaylist('00000'); // a disc without a menu program waits for the host to pick a playlist
  // #endregion
  await until(controller, (s) => s.engineState === 'playing' && s.timeUs > 300_000, 'playback');

  // #region pause
  controller.pause();
  // #endregion
  await until(controller, (s) => s.engineState === 'paused', 'the pause');

  // #region play
  controller.play();
  // #endregion
  await until(controller, (s) => s.engineState === 'playing', 'playing again');

  // #region togglePlay
  controller.togglePlay(); // the space bar: pauses while playing, plays otherwise
  // #endregion
  await until(controller, (s) => s.engineState === 'paused', 'the toggle');

  // #region seek
  controller.seek(5_000_000); // microseconds from the playlist's start
  // #endregion
  await until(controller, (s) => Math.abs(s.timeUs - 5_000_000) < 100_000, 'the seek to 5 s');

  // #region seekBy
  controller.seekBy(-2_000_000); // back 2 s from the last known position
  // #endregion
  await until(controller, (s) => Math.abs(s.timeUs - 3_000_000) < 100_000, 'the seek back to 3 s');

  // #region nextChapter
  console.log(controller.getSnapshot().chapters.map((c) => c.startUs)); // disc1's feature has a chapter every 2 s
  controller.nextChapter();
  // #endregion
  await until(controller, (s) => Math.abs(s.timeUs - 4_000_000) < 100_000, 'the next chapter at 4 s');

  // #region prevChapter
  controller.prevChapter();
  // #endregion
  await until(controller, (s) => s.timeUs < 3_900_000, 'an earlier chapter');

  // #region setVolume
  controller.setVolume(0.5); // 0 to 1, applied on the page's audio output
  // #endregion
  // #region adjustVolume
  controller.adjustVolume(-0.1); // volume keys: a step, unmuting first
  // #endregion
  // #region toggleMute
  controller.toggleMute();
  // #endregion
  const sound = controller.getSnapshot();
  check(Math.abs(sound.volume - 0.4) < 1e-9 && sound.muted, `volume ${sound.volume}, muted ${sound.muted}`);
  controller.toggleMute();

  // #region readPlace
  // the registers a saved place needs, to resume later through open(files, { playlistId, timeUs, ... })
  const place = await controller.readPlace();
  console.log(place.mode, place.psrs.length, 'PSRs'); // 'none' 128: disc1 has no menu program
  // #endregion
  check(place.mode === 'none' && place.psrs.length === 128, 'unexpected place');

  // #region showNotice
  controller.showNotice('example', 'Saved your place.'); // shown with the engine's notices, one per code
  // #endregion
  check(controller.getSnapshot().notices.some((n) => n.code === 'example'), 'the notice is missing');
  // #region dismissNotice
  controller.dismissNotice('example');
  // #endregion
  check(!controller.getSnapshot().notices.some((n) => n.code === 'example'), 'the notice stayed');

  // #region setShaderSet
  // an mpv user shader that inverts the picture; Seikou ships Anime4K's sets
  const invert = '//!HOOK MAIN\n//!BIND HOOKED\n//!DESC invert\nvec4 hook() { vec4 c = HOOKED_texOff(0); return vec4(1.0 - c.rgb, c.a); }\n';
  controller.setShaderSet({ name: 'Invert', files: [{ name: 'invert.glsl', source: invert }] });
  // #endregion
  const shaded = await until(controller, (s) => s.shaders.set === 'Invert' && s.shaders.state !== 'compiling', 'the shader set');
  console.log('shaders:', shaded.shaders.state); // 'active', or 'unavailable' without WebGL2 float targets
  check(shaded.shaders.state === 'active' || shaded.shaders.state === 'unavailable', `shader ${shaded.shaders.state}: ${shaded.shaders.error}`);
  controller.setShaderSet(null);
  await until(controller, (s) => s.shaders.state === 'off', 'shaders off');

  await textSubtitles(controller);

  // #region closeDisc
  controller.closeDisc(); // the snapshot starts over, keeping volume and mute
  // #endregion
  check(controller.getSnapshot().playlists.length === 0, 'the disc stayed open');
  unsubscribe();
  console.log('states seen:', states.join(' → '));
  check(states.includes('playing') && states.includes('paused'), `states ${states.join()}`);

  await audioTracks(controller);
  await pgSubtitles(controller);
  await menus(controller);
  await remote(controller, sent);
  await encode(controller);
}

async function textSubtitles(controller: PlayerController): Promise<void> {
  // #region loadSubtitleFile
  const srt = new File(['1\n00:00:01,000 --> 00:00:03,000\nHello\n'], 'hello.srt');
  await controller.loadSubtitleFile(srt); // a file the viewer picked: it becomes the text subtitle set
  // #endregion
  await until(controller, (s) => s.subtitles?.text?.files[0]?.name === 'hello.srt', 'the SRT file');

  // #region selectSubtitle
  controller.selectSubtitle({ kind: 'text' }); // { kind: 'pg', stream } for a disc track, { kind: 'off' } for none
  // #endregion
  await until(controller, (s) => s.subtitles?.selected === 'text', 'text subtitles shown');

  // #region cycleSubtitles
  controller.cycleSubtitles(); // the S key: off, each PG track, the text set, off again
  // #endregion
  await until(controller, (s) => s.subtitles?.selected === 'off', 'subtitles off');

  // #region shiftSubtitleFile
  controller.shiftSubtitleFile(0, 500); // the set's first file, half a second later
  // #endregion
  // #region shiftSubtitles
  controller.shiftSubtitles(-200); // the [ key: the file showing now, or the only one
  // #endregion
  await until(controller, (s) => s.subtitles?.text?.files[0]?.offsetMs === 300, 'a 300 ms offset');

  // #region scaleSubtitles
  controller.scaleSubtitles(0.2); // text 20% larger, within 0.5 to 2
  // #endregion
  check(controller.getSnapshot().subtitles?.scale === 1.2, 'the scale did not change');

  // #region setSubtitleStart
  controller.setSubtitleStart(0, 2_000_000); // the file's 0:00 is at 2 s of the playlist
  // #endregion
  await until(controller, (s) => s.subtitles?.text?.files[0]?.startUs === 2_000_000, 'the file placed at 2 s');

  // #region answerEncoding
  // "Café" in windows-1252, which is not UTF-8: the snapshot asks which encoding it is
  const latin = new File([new Uint8Array([...new TextEncoder().encode('1\n00:00:01,000 --> 00:00:02,000\nCaf'), 0xe9, 0x0a])], 'cafe.srt');
  await controller.loadSubtitleFile(latin);
  await until(controller, (s) => s.encodingPrompt !== null, 'the encoding prompt');
  await controller.answerEncoding('windows-1252'); // a TextDecoder label; null cancels
  // #endregion
  await until(controller, (s) => s.subtitles?.text?.files[0]?.name === 'cafe.srt', 'the file read as windows-1252');

  // #region loadSubtitleFiles
  const ass = `[Script Info]\nScriptType: v4.00+\n\n[V4+ Styles]\nFormat: Name, Fontname, Fontsize\nStyle: Default,Source Sans 3,40\n\n[Events]\nFormat: Layer, Start, End, Style, Text\nDialogue: 0,0:00:00.00,0:00:08.00,Default,Hello\n`;
  const font = new File([await (await fetch(FONT)).blob()], 'SourceSans3.otf');
  // a pick of several files: subtitle files become the set, fonts go to its ASS files
  await controller.loadSubtitleFiles([new File([ass], 'episode.ass'), new File([srt], 'episode.en.srt')]);
  // #endregion
  await until(controller, (s) => s.subtitles?.text?.files.length === 2, 'the two files');

  controller.selectSubtitle({ kind: 'text' });
  controller.play();
  // the script asks for Source Sans 3, which nothing supplied yet
  await until(controller, (s) => s.subtitles?.text?.missingFonts.includes('Source Sans 3') === true, 'the missing font');

  // #region addSubtitleFonts
  await controller.addSubtitleFonts([font]); // the fonts the ASS files ask for, picked later
  // #endregion
  const fonted = await until(controller, (s) => s.subtitles?.text?.missingFonts.length === 0, 'the font in the set');
  console.log('missing fonts:', fonted.subtitles?.text?.missingFonts);

  // #region removeSubtitleFile
  controller.removeSubtitleFile(); // the whole text set goes
  // #endregion
  await until(controller, (s) => s.subtitles?.text === null, 'the set removed');
}

async function audioTracks(controller: PlayerController): Promise<void> {
  controller.open(await discFiles(DISC3, DISC3_FILES));
  await until(controller, (s) => s.engineState === 'idle' && s.playlists.length > 0, 'disc3');
  controller.playPlaylist('00000');
  const tracks = await until(controller, (s) => s.engineState === 'playing' && s.audioTracks.length === 4, 'disc3 playing');
  console.log(tracks.audioTracks.map((t) => `${t.index}: ${t.codec}`)); // LPCM, AC-3, TrueHD (its AC-3 core plays) and DTS

  // #region selectAudio
  controller.selectAudio(2); // an index from snapshot.audioTracks; a notice names the track
  // #endregion
  await until(controller, (s) => s.selectedAudio === 2 && s.notices.some((n) => n.code === 'audio-track'), 'track 2');

  // #region cycleAudio
  controller.cycleAudio(); // the A key: the next playable track
  // #endregion
  await until(controller, (s) => s.selectedAudio === 3, 'track 3');
}

async function pgSubtitles(controller: PlayerController): Promise<void> {
  // disc-subs's First Play turns English PG subtitles on and plays its feature
  controller.open(await discFiles(DISC_SUBS, DISC_SUBS_FILES));
  const subs = await until(controller, (s) => s.engineState === 'playing' && (s.subtitles?.pg.length ?? 0) === 2, 'disc-subs playing');
  console.log(subs.subtitles?.pg, subs.subtitles?.selected); // eng and jpn; { pg: 1 }
  controller.selectSubtitle({ kind: 'pg', stream: 2 });
  await until(controller, (s) => typeof s.subtitles?.selected === 'object' && s.subtitles.selected.pg === 2, 'PG stream 2');
}

async function menus(controller: PlayerController): Promise<void> {
  // disc-menu's First Play shows its top menu: buttons A at (200, 200) and B at (200, 300), each 64×32, on page 0
  controller.open(await discFiles(DISC_MENU, DISC_MENU_FILES));
  await until(controller, (s) => s.menuActive && s.telemetry?.menu?.selectedButton === 1, 'the top menu');

  // #region menuKey
  controller.menuKey('down'); // arrows, ok and digits, as a remote sends them
  // #endregion
  await until(controller, (s) => s.telemetry?.menu?.selectedButton === 2, 'button B selected');

  // #region pointer
  controller.pointer('move', 232, 216); // in the 1920×1080 menu space: over button A
  // #endregion
  await until(controller, (s) => s.pointerButton === 1, 'the pointer over A');

  // #region playTitle
  controller.playTitle(1); // index title 1: its movie object plays playlist 00000
  // #endregion
  await until(controller, (s) => s.currentPlaylistId === '00000' && s.uoMask.length > 0, 'title 1');

  // #region isMasked
  console.log('time search allowed:', !controller.isMasked('timeSearch')); // false: title 1 masks it
  // #endregion
  check(controller.isMasked('timeSearch'), 'title 1 should mask time search');

  // #region allow
  // before a command the disc may refuse: false shows the "doesn't allow this here" notice
  if (controller.allow('timeSearch')) controller.seek(2_000_000);
  // #endregion
  check(controller.getSnapshot().notices.some((n) => n.code === 'uo-masked'), 'no masked notice');

  // #region menuCall
  controller.menuCall(); // the Top Menu button
  // #endregion
  await until(controller, (s) => s.menuActive && s.currentPlaylistId === '00001', 'back at the top menu');
}

async function remote(controller: PlayerController, sent: string[]): Promise<void> {
  // A server answers `GET <base>manifest` with the file list and the small files inlined, and serves the clips by range.
  // This page has no server, so it builds the manifest itself and inlines every file, clips too.
  const files = await discFiles(DISC1, DISC1_FILES);
  const base64 = async (f: File): Promise<string> => btoa(Array.from(new Uint8Array(await f.arrayBuffer()), (b) => String.fromCharCode(b)).join(''));
  const manifest: DiscManifest = {
    discId: 'example',
    name: 'Example disc',
    files: files.map(([path, f]) => ({ path: path.slice('disc1/'.length).toUpperCase(), size: f.size })),
    inline: Object.fromEntries(await Promise.all(files.map(async ([path, f]) => [path.slice('disc1/'.length).toUpperCase(), await base64(f)]))),
  };
  const base = 'https://nas.example/bluray/api/discs/example/';

  // #region openRemote
  // Against a real server the manifest comes from the disc's API, with the device's session token:
  //   const manifest = (await (await fetch(`${base}manifest`, { headers: { Authorization: `Bearer ${token}` } })).json()) as DiscManifest;
  const refreshToken = async (): Promise<string> => 'fresh-token'; // asked when the server refuses the token
  controller.openRemote({ kind: 'remote', base, token: 'token', manifest }, refreshToken);
  // #endregion
  const opened = await until(controller, (s) => s.engineState === 'idle' && s.playlists.length > 0, 'the remote disc');
  check(opened.remoteDisc, 'not a remote disc');
  controller.playPlaylist('00000');
  await until(controller, (s) => s.engineState === 'playing', 'the remote disc playing');

  // #region setRemoteToken
  controller.setRemoteToken('next-token'); // the page refreshed the session on its own schedule
  // #endregion
  // a real server sees `t=next-token` on the requests that follow (here only the fill below makes any, to nas.example,
  // where nothing answers: playback reads the inlined files)
  check(sent.includes('remoteToken'), 'the token did not reach the engine');

  // #region bufferAhead
  // fill the disc's on-disk read-ahead cache with 8 MB of the main playlist from 0 s (clamped to the playlist's size, here
  // about 2.7 MB); snapshot.buffer reports the fill
  controller.bufferAhead(0, 8_000_000);
  // #endregion
  const buffering = await until(controller, (s) => s.buffer !== null, 'the fill report');
  console.log('buffer:', buffering.buffer); // here the fill finds no server at nas.example, or no cache on this device
  // #region cancelBuffer
  controller.cancelBuffer(); // the viewer chose to play now
  // #endregion
  // a real server sees the fill's range requests stop
  check(sent.includes('cancelBuffer'), 'the cancel did not reach the engine');

  // #region setLevel
  // switch to another version of the same disc: a quality level's manifest (here the same one) and its query; it
  // reopens at the same place
  controller.setLevel({ kind: 'remote', base, token: 'next-token', manifest, query: 'level=h264-1080&audio=1' });
  // #endregion
  await until(controller, (s) => s.levelSwitch === 'idle' && s.engineState === 'playing', 'the level switch', 10_000);
}

async function encode(controller: PlayerController): Promise<void> {
  // An encoded episode on a NAS: one Matroska file of AV1 and Opus, served like a disc's files. This page has no server,
  // so its manifest inlines the whole file (a server's manifest lists EPISODE.MKV with its size, inlining nothing).
  const bytes = new Uint8Array(await (await fetch(EPISODE)).arrayBuffer());
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  const manifest: DiscManifest = { discId: '990001-1', name: 'Episode 1', files: [{ path: 'EPISODE.MKV', size: bytes.length }], inline: { 'EPISODE.MKV': btoa(binary) } };

  // #region openEncode
  // the encode's API base, as the NAS lists it; 10 s in, as a resume would
  controller.openEncode({ base: 'https://nas.example/bluray/api/encodes/990001-1/', token: 'token', manifest, encodeId: '990001-1' }, undefined, 10_000_000);
  // #endregion
  const playing = await until(controller, (s) => s.engineState === 'playing' && s.timeUs > 10_000_000, 'the episode playing');
  console.log(playing.currentPlaylistId, playing.chapters.map((c) => c.name), playing.audioTracks.map((t) => `${t.codec} ${t.language}`), playing.subtitles?.pg.map((t) => t.name));
  // mkv [Avant, Opening, Part A, Ending, Preview] [Opus jpn] [English, English (disc)]
  check(playing.encodeId === '990001-1' && playing.currentPlaylistId === 'mkv', 'not the encode');
  check(playing.chapters.map((c) => c.name).join() === 'Avant,Opening,Part A,Ending,Preview', 'unexpected chapters');
  check(playing.audioTracks.length === 1 && playing.audioTracks[0]!.codec === 'Opus' && playing.subtitles?.pg.length === 2, 'unexpected tracks');
  controller.closeDisc();
}

/** A controller built by hand: with your own audio output, doing what createController does. */
async function construct(): Promise<void> {
  // An output that never starts (a muted preview): playback then runs on the wall clock.
  const silent: AudioOutputLike = {
    ensureStarted: () => Promise.reject(new Error('this preview has no sound')),
    setVolume: () => {},
    setMuted: () => {},
    loadEffects: () => {},
    playEffect: () => {},
    onStateChange: () => {},
  };
  // #region construct
  const worker = createEngineWorker('preview');
  const preview = new PlayerController(worker, silent);
  // #endregion
  const sent: string[] = [];
  recordCommands(worker, sent);

  // #region setMemoryProfile
  preview.setMemoryProfile('constrained'); // once, before a disc opens: smaller caches, as on a phone
  // #endregion

  // #region setVisibility
  preview.setVisibility(document.hidden); // a BD-J title's start-up timeout counts only visible time
  // #endregion

  // #region flushSaves
  // the page is going away: a BD-J disc stores what it saved now rather than after its delay
  const listening = new AbortController(); // aborted when the player goes, which removes both listeners
  addEventListener('pagehide', () => preview.flushSaves(), { signal: listening.signal });
  document.addEventListener(
    'visibilitychange',
    () => {
      if (document.hidden) preview.flushSaves();
      preview.setVisibility(document.hidden);
    },
    { signal: listening.signal },
  );
  // #endregion
  dispatchEvent(new Event('pagehide')); // as the browser does when the page goes
  listening.abort();
  console.log('posted:', sent.join(', ')); // setMemoryProfile, visibility, flushSaves
  check(sent.join() === 'setMemoryProfile,visibility,flushSaves', `posted ${sent.join()}`);

  preview.open(await discFiles(DISC1, DISC1_FILES));
  const opened = await until(preview, (s) => s.engineState === 'idle' && s.playlists.length > 0, 'the preview disc');
  console.log(opened.notices.map((n) => n.message)); // the audio-output notice says why there is no sound
  check(opened.notices.some((n) => n.code === 'audio-output'), 'no audio-output notice');

  // #region reportInternalError
  // the host stopped the worker (or saw it fail): the snapshot says so, as the worker no longer can
  worker.terminate();
  preview.reportInternalError('The preview was stopped.');
  // #endregion
  const s = preview.getSnapshot();
  check(s.engineState === 'error' && s.error?.code === 'internal', 'the error is not shown');
  check(await preview.readPlace().then(() => false, () => true), 'readPlace should reject once the engine failed');
}
