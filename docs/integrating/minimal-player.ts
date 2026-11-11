// SPDX-License-Identifier: LGPL-3.0-or-later
// A minimal Blu-ray player page built on @seikou/engine. index.html beside this file loads it.
import { createController, createEngineWorker, type PlayerSnapshot } from '@seikou/engine';

const canvas = document.querySelector<HTMLCanvasElement>('#video')!;
const pick = document.querySelector<HTMLButtonElement>('#pick')!;
const folder = document.querySelector<HTMLInputElement>('#folder')!;
const playPause = document.querySelector<HTMLButtonElement>('#play-pause')!;
const back = document.querySelector<HTMLButtonElement>('#back')!;
const status = document.querySelector<HTMLParagraphElement>('#status')!;

// One controller per page. It starts the engine worker and owns the audio output.
const controller = createController({ worker: () => createEngineWorker('engine'), profile: 'desktop' });
// The canvas moves to the worker as an OffscreenCanvas. From here on only the engine draws on it.
controller.attachCanvas(canvas);
controller.resize(canvas.width, canvas.height);

let audioReady: Promise<void> = Promise.resolve();
let picked = false;

pick.addEventListener('click', () => {
  // The browser lets audio start only inside a user gesture, so start it on this click.
  audioReady = controller.startAudio();
  folder.click();
});

folder.addEventListener('change', async () => {
  const files = [...(folder.files ?? [])];
  if (!files.length) return;
  // A playlist that starts before the audio ring reaches the engine plays without sound.
  await audioReady;
  picked = false;
  controller.open(files.map((file) => [file.webkitRelativePath || file.name, file] as const));
});

playPause.addEventListener('click', () => controller.togglePlay());
back.addEventListener('click', () => controller.seek(Math.max(0, controller.getSnapshot().timeUs - 10_000_000)));

/** The longest playlist the engine can play, for a disc without a menu program to choose one. */
function mainPlaylist(s: PlayerSnapshot): string | null {
  const candidates = s.playlists.filter((p) => p.playable && !p.looped);
  candidates.sort((a, b) => b.durationUs - a.durationUs);
  return candidates[0]?.id ?? null;
}

const seconds = (us: number): string => (us / 1_000_000).toFixed(1);

function render(s: PlayerSnapshot): void {
  // An HDMV disc with menus runs its own First Play (indexTitles is set), and so does a BD-J disc when the engine
  // has a provider (bdjActive). Any other disc waits idle with its playlists listed: play the main one.
  if (!picked && s.engineState === 'idle' && s.currentPlaylistId === null && s.indexTitles === null && !s.bdjActive) {
    const id = mainPlaylist(s);
    if (id) {
      picked = true;
      controller.playPlaylist(id);
    }
  }
  playPause.textContent = s.engineState === 'playing' || s.engineState === 'buffering' ? 'Pause' : 'Play';
  const where = s.currentPlaylistId ? `playlist ${s.currentPlaylistId}, ${seconds(s.timeUs)} / ${seconds(s.durationUs)} s` : 'no playlist';
  const problem = s.error ? `: ${s.error.message}` : '';
  const notices = s.notices.map((n) => n.message).join(' ');
  status.textContent = `${s.engineState}, ${where}${problem} ${notices}`.trim();
}

// The snapshot is replaced on every change, so render reads one consistent state.
controller.subscribe(() => render(controller.getSnapshot()));
render(controller.getSnapshot());
