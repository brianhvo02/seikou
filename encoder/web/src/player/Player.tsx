// SPDX-License-Identifier: LGPL-3.0-or-later
import { useEffect, useRef, useSyncExternalStore } from 'react';
import type { EpisodeTimes } from '../api-types';
import { clock } from '../steps/lineup-model';
import type { PlayerLike } from './use-controller';

/** What the player shows: the engine and the episode whose part of the playlist the controls cover. */
export interface PlayerProps {
  /** The page's engine; the player hands it its canvas and sends it play, pause and seeks. */
  readonly controller: PlayerLike;
  /** The episode on screen; the seek bar and the time cover only its range of the playlist. */
  readonly episode: EpisodeTimes;
}

/**
 * The preview: the engine's canvas (video with the subtitles drawn in), play and pause, a seek bar over the episode's
 * range only, and the episode time. Browsers start audio only from a user action, so the first press anywhere on the
 * player starts the engine's audio output.
 */
export function Player({ controller, episode }: PlayerProps) {
  const snapshot = useSyncExternalStore(controller.subscribe, controller.getSnapshot);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const audioStarted = useRef(false);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    controller.attachCanvas(canvas);
    if (typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(([entry]) => {
      if (!entry) return;
      const dpr = window.devicePixelRatio || 1;
      controller.resize(Math.round(entry.contentRect.width * dpr), Math.round(entry.contentRect.height * dpr));
    });
    observer.observe(canvas);
    return () => observer.disconnect();
  }, [controller]);

  const startAudio = () => {
    if (audioStarted.current) return;
    audioStarted.current = true;
    controller.startAudio();
  };

  const durationMs = episode.durationUs / 1000;
  const atMs = Math.min(durationMs, Math.max(0, (snapshot.timeUs - episode.startUs) / 1000));
  const playing = snapshot.engineState === 'playing' || snapshot.engineState === 'buffering';
  const waiting = snapshot.engineState === 'idle' || snapshot.engineState === 'loading';

  return (
    <div className="player" onPointerDown={startAudio} onKeyDown={startAudio}>
      <div className="player-frame">
        <canvas ref={canvasRef} className="player-canvas" aria-label={`Episode ${episode.index} preview`} />
        {snapshot.error ? (
          <p className="player-message error" role="alert">
            {snapshot.error.message}
          </p>
        ) : waiting ? (
          <p className="player-message muted">Opening the disc</p>
        ) : null}
      </div>
      <div className="player-controls">
        <button
          type="button"
          className="quiet play"
          disabled={waiting}
          onClick={() => (playing ? controller.pause() : controller.play())}
        >
          {playing ? 'Pause' : 'Play'}
        </button>
        <input
          type="range"
          className="seek"
          name="seek"
          aria-label="Seek within the episode"
          min={0}
          max={Math.max(0, Math.floor(durationMs))}
          step={100}
          value={Math.floor(atMs)}
          disabled={waiting}
          onChange={(e) => controller.seek(episode.startUs + Number(e.target.value) * 1000)}
        />
        <span className="player-time num">
          {clock(atMs)} <span className="muted">/ {clock(durationMs)}</span>
        </span>
      </div>
    </div>
  );
}
