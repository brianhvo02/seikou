// SPDX-License-Identifier: LGPL-3.0-or-later
// Start the engine and its controller in a page, open a disc from its files and play its main playlist.
import { createController, createEngineWorker, type PlayerSnapshot } from '@seikou/engine';

const DISC1 = '/developers/_examples/fixtures/disc1/';
const FILES = ['BDMV/index.bdmv', 'BDMV/PLAYLIST/00000.mpls', 'BDMV/PLAYLIST/00001.mpls', 'BDMV/CLIPINF/00001.clpi', 'BDMV/CLIPINF/00002.clpi', 'BDMV/STREAM/00001.m2ts', 'BDMV/STREAM/00002.m2ts'];

export default async function example(): Promise<void> {
  const canvas = document.body.appendChild(document.createElement('canvas'));
  canvas.width = 640;
  canvas.height = 360;
  // the files a folder picker would give, as [path, File] pairs
  const entries = await Promise.all(FILES.map(async (path) => [`disc1/${path}`, new File([await (await fetch(DISC1 + path)).blob()], path)] as const));

  // One controller per player, on the main thread. createEngineWorker starts the package's engine worker (no BD-J).
  const controller = createController({ worker: () => createEngineWorker('engine'), profile: 'desktop' });
  controller.attachCanvas(canvas);
  controller.resize(canvas.width, canvas.height);
  await controller.startAudio(); // in a page, from the click that picked the disc
  controller.open(entries);

  // a disc without a menu program waits idle with its playlists listed: play the first, the main feature
  const reached = (test: (s: PlayerSnapshot) => boolean): Promise<PlayerSnapshot> =>
    new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`stuck in ${controller.getSnapshot().engineState}`)), 10_000);
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
  const ready = await reached((s) => s.engineState === 'idle' && s.playlists.length > 0);
  controller.playPlaylist(ready.playlists[0]!.id);
  const playing = await reached((s) => s.engineState === 'playing' && s.timeUs > 500_000);
  console.log(playing.currentPlaylistId, `${(playing.timeUs / 1e6).toFixed(1)} s of ${(playing.durationUs / 1e6).toFixed(1)} s`);

  controller.closeDisc();
  canvas.remove();
  if (playing.currentPlaylistId !== '00000' || playing.error) throw new Error('the main playlist did not play');
}
