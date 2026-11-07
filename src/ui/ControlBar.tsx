import { useEffect, useRef, useState, type ReactElement } from 'react';
import type { UoOp } from '../engine/hdmv/uo-mask';
import type { Chapter } from '../engine/nav/timeline';
import type { PlayerController, PlayerSnapshot } from '../player/player-controller';
import { AudioMenu, type LevelAudio } from './AudioMenu';
import type { LevelId } from '@seikou/nas/nas-api';
import type { LevelState } from './nas/level-session';
import { QualityMenu } from './QualityMenu';
import { ShaderMenu } from './ShaderMenu';
import type { ShaderModel, ShaderModelState } from './shader-model';
import { SubtitleMenu, type StoredSubtitles } from './SubtitleMenu';
import type { ToshoSearch } from './ToshoSearch';
import { formatTime } from './format';

const MASKED_TOOLTIP = "The disc doesn't allow this here";

interface SeekBarProps {
  readonly durationUs: number;
  readonly timeUs: number;
  readonly chapters: readonly Chapter[];
  /** The disc masks time search here. */
  readonly disabled: boolean;
  onSeek(timeUs: number): void;
}

/** How long a committed seek keeps the thumb at its target if the engine never reports getting there. */
const SEEK_SETTLE_MS = 3000;
/** The engine time counts as having reached a committed target within this distance. */
const SEEK_REACHED_US = 1_000_000;

function SeekBar({ durationUs, timeUs, chapters, disabled, onSeek }: SeekBarProps): ReactElement {
  // While dragging: the thumb position. After a commit: the target, held until the engine time gets there,
  // so the thumb doesn't jump back to the old time while the seek is in flight.
  const [heldUs, setHeldUs] = useState<number | null>(null);
  const max = Math.max(1, durationUs);
  const pointerDown = useRef(false);
  const dragUs = useRef<number | null>(null);
  const committedUs = useRef<number | null>(null);

  useEffect(() => {
    const target = committedUs.current;
    if (target === null || pointerDown.current) return;
    if (Math.abs(timeUs - target) < SEEK_REACHED_US) {
      committedUs.current = null;
      setHeldUs(null);
      return;
    }
    const timer = window.setTimeout(() => {
      if (committedUs.current !== target || pointerDown.current) return;
      committedUs.current = null;
      setHeldUs(null);
    }, SEEK_SETTLE_MS);
    return () => window.clearTimeout(timer);
  }, [timeUs, heldUs]);

  const seek = (us: number): void => {
    committedUs.current = us;
    setHeldUs(us);
    onSeek(us);
  };
  const commit = (): void => {
    pointerDown.current = false;
    const us = dragUs.current;
    dragUs.current = null;
    if (us !== null) seek(us);
  };
  const cancel = (): void => {
    if (!pointerDown.current) return;
    pointerDown.current = false;
    dragUs.current = null;
    setHeldUs(committedUs.current);
  };
  return (
    <div className="seek-bar">
      <input
        type="range"
        aria-label="Seek"
        data-testid="seek"
        disabled={disabled}
        title={disabled ? MASKED_TOOLTIP : undefined}
        min={0}
        max={max}
        step={100_000}
        value={Math.min(heldUs ?? timeUs, max)}
        onChange={(e) => {
          const value = Number(e.target.value);
          if (pointerDown.current) {
            dragUs.current = value;
            setHeldUs(value);
          } else if (value !== committedUs.current) {
            // Chrome may fire a trailing `change` after pointerup; it repeats the committed value and is ignored.
            seek(value);
          }
        }}
        onPointerDown={() => {
          pointerDown.current = true;
        }}
        onPointerUp={commit}
        onPointerCancel={cancel}
        onBlur={cancel}
      />
      {durationUs > 0 &&
        chapters.map((c) => <span key={c.index} className="chapter-tick" style={{ left: `${(c.startUs / durationUs) * 100}%` }} />)}
    </div>
  );
}

interface ControlBarProps {
  readonly controller: PlayerController;
  readonly snapshot: PlayerSnapshot;
  readonly shaderModel: ShaderModel;
  readonly shaderState: ShaderModelState;
  readonly visible: boolean;
  onOpenPlaylists(): void;
  /** Absent where the browser has no fullscreen API: the button is not shown. */
  onFullscreen?(): void;
  /** Top Menu / Pop-up and the remote send menu keys through the same UO check as the keyboard. */
  onMenuKey(key: 'topMenu' | 'popup'): void;
  readonly remoteOpen: boolean;
  onToggleRemote(): void;
  onMenuOpenChange(open: boolean): void;
  /** Subtitle files or fonts the user picked, as they go to the controller (the player keeps them for a resume). */
  onSubtitleFiles?(files: readonly File[]): void;
  /** A NAS disc's stored subtitles for the playing playlist, for the Subtitles menu; absent for other discs. */
  readonly storedSubtitles?: StoredSubtitles | null;
  /** A NAS disc's Anime Tosho search, in the Subtitles menu. */
  readonly toshoSearch?: ToshoSearch | null;
  /** A NAS disc's quality level: the Quality menu, and the Audio menu's original tracks at a re-encoded level. */
  readonly quality?: { readonly state: LevelState; onPick(level: LevelId): void; readonly audio: LevelAudio | null } | null;
}

export function ControlBar({ controller, snapshot, shaderModel, shaderState, visible, onOpenPlaylists, onFullscreen, onMenuKey, remoteOpen, onToggleRemote, onMenuOpenChange, onSubtitleFiles, storedSubtitles = null, toshoSearch = null, quality = null }: ControlBarProps): ReactElement {
  const playing = snapshot.engineState === 'playing' || snapshot.engineState === 'buffering';
  const silent = snapshot.muted || snapshot.volume === 0;
  const masked = (op: UoOp): boolean => snapshot.uoMask.includes(op);
  const tip = (op: UoOp): string | undefined => (masked(op) ? MASKED_TOOLTIP : undefined);
  const pauseMasked = playing && masked('pauseOn');
  const popupOp: UoOp = snapshot.menuActive && snapshot.popupAvailable ? 'popupOff' : 'popupOn';
  const hdmv = snapshot.indexTitles !== null;
  return (
    <div className={`control-bar${visible ? '' : ' hidden'}`} data-testid="control-bar">
      <SeekBar durationUs={snapshot.durationUs} timeUs={snapshot.timeUs} chapters={snapshot.chapters} disabled={masked('timeSearch')} onSeek={(us) => controller.seek(us)} />
      <div className="control-row">
        <button type="button" aria-label="Previous chapter" disabled={masked('skipBackToPreviousPoint')} title={tip('skipBackToPreviousPoint')} onClick={() => controller.prevChapter()}>
          ⏮
        </button>
        <button
          type="button"
          aria-label={playing ? 'Pause' : 'Play'}
          data-testid="play-toggle"
          disabled={pauseMasked}
          title={pauseMasked ? MASKED_TOOLTIP : undefined}
          onClick={() => controller.togglePlay()}
        >
          {playing ? '⏸' : '▶'}
        </button>
        <button type="button" aria-label="Next chapter" data-testid="next-chapter" disabled={masked('skipToNextPoint')} title={tip('skipToNextPoint')} onClick={() => controller.nextChapter()}>
          ⏭
        </button>
        <span className="time" data-testid="time">
          {formatTime(snapshot.timeUs)} / {formatTime(snapshot.durationUs)}
        </span>
        <span className="spacer" />
        <button type="button" aria-label={snapshot.muted ? 'Unmute' : 'Mute'} onClick={() => controller.toggleMute()}>
          {silent ? '🔇' : '🔊'}
        </button>
        <input
          type="range"
          aria-label="Volume"
          data-role="volume"
          min={0}
          max={1}
          step={0.05}
          value={snapshot.muted ? 0 : snapshot.volume}
          onChange={(e) => {
            if (snapshot.muted) controller.toggleMute();
            controller.setVolume(Number(e.target.value));
          }}
        />
        <AudioMenu
          tracks={snapshot.audioTracks}
          selected={snapshot.selectedAudio}
          disabledReason={tip('primaryAudioChange')}
          levelAudio={quality?.audio ?? null}
          onSelect={(i) => controller.selectAudio(i)}
          onOpenChange={onMenuOpenChange}
        />
        {quality && <QualityMenu state={quality.state} onPick={quality.onPick} onOpenChange={onMenuOpenChange} />}
        <SubtitleMenu
          subtitles={snapshot.currentPlaylistId !== null ? snapshot.subtitles : null}
          isMasked={masked}
          chapters={snapshot.chapters}
          nowUs={snapshot.timeUs}
          showingFile={snapshot.telemetry?.textFile ?? null}
          stored={storedSubtitles}
          search={toshoSearch}
          onSelect={(choice) => controller.selectSubtitle(choice)}
          onLoadFiles={(files) => {
            void controller.loadSubtitleFiles(files);
            onSubtitleFiles?.(files);
          }}
          onAddFonts={(files) => {
            void controller.addSubtitleFonts(files);
            onSubtitleFiles?.(files);
          }}
          onShift={(file, ms) => controller.shiftSubtitleFile(file, ms)}
          onStart={(file, startUs) => controller.setSubtitleStart(file, startUs)}
          onScale={(d) => controller.scaleSubtitles(d)}
          onRemove={() => controller.removeSubtitleFile()}
          onOpenChange={onMenuOpenChange}
        />
        <ShaderMenu model={shaderModel} state={shaderState} status={snapshot.shaders} dropWarning={snapshot.shaderDropWarning} onOpenChange={onMenuOpenChange} />
        {snapshot.indexTitles?.hasTopMenu && (
          <button type="button" data-testid="top-menu" disabled={masked('menuCall')} title={tip('menuCall')} onClick={() => onMenuKey('topMenu')}>
            Top Menu
          </button>
        )}
        {snapshot.popupAvailable && (
          <button type="button" data-testid="popup" disabled={masked(popupOp)} title={tip(popupOp)} onClick={() => onMenuKey('popup')}>
            Pop-up
          </button>
        )}
        {(hdmv || snapshot.bdjActive) && (
          <button type="button" aria-pressed={remoteOpen} aria-label="Remote" data-testid="remote-toggle" onClick={onToggleRemote}>
            Remote
          </button>
        )}
        <button type="button" data-testid={hdmv ? 'titles' : undefined} onClick={onOpenPlaylists}>
          {hdmv ? 'Titles' : 'Playlists'}
        </button>
        {onFullscreen && (
          <button type="button" aria-label="Fullscreen" onClick={onFullscreen}>
            ⛶
          </button>
        )}
      </div>
    </div>
  );
}
