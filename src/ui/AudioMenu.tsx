import { useEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type ReactElement } from 'react';
import type { AudioTrack } from '@seikou/engine/protocol';
import { trackLabel } from '@seikou/engine/controller/language';
import type { OriginalAudioTrack } from './nas/level-session';

/** At a re-encoded level the menu lists the original disc's tracks, and a pick switches the level's audio. */
export interface LevelAudio {
  readonly tracks: readonly OriginalAudioTrack[];
  readonly current: number;
  onPick(n: number): void;
}

interface AudioMenuProps {
  readonly levelAudio?: LevelAudio | null;
  readonly tracks: readonly AudioTrack[];
  readonly selected: number | null;
  /** Set when the disc does not allow changing the audio here: the button is disabled with this tooltip. */
  readonly disabledReason?: string;
  onSelect(index: number): void;
  /** While open, the player keeps its controls up. */
  onOpenChange(open: boolean): void;
}

/**
 * The control bar's Audio button and its list of tracks. It renders nothing unless there is more than one track to pick
 * (`tracks`, or `levelAudio.tracks` at a re-encoded level, where a pick switches the level's audio instead of calling
 * `onSelect`). `selected` is the checked track's index; `disabledReason` greys the button with a tooltip when the disc's
 * UO mask forbids the change. `onOpenChange` tells the player to keep its controls up while the list is open.
 */
export function AudioMenu({ tracks, selected, disabledReason, levelAudio = null, onSelect, onOpenChange }: AudioMenuProps): ReactElement | null {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const listRef = useRef<HTMLUListElement>(null);
  const shown = (levelAudio ? levelAudio.tracks.length : tracks.length) > 1;

  const playableItems = (): HTMLButtonElement[] => [...(listRef.current?.querySelectorAll<HTMLButtonElement>('button:not(:disabled)') ?? [])];
  const close = (refocus: boolean): void => {
    setOpen(false);
    if (refocus) buttonRef.current?.focus();
  };

  useEffect(() => {
    if (!shown || (!levelAudio && disabledReason)) setOpen(false);
  }, [shown, disabledReason, levelAudio]);

  useEffect(() => onOpenChange(open), [open, onOpenChange]);

  useEffect(() => {
    if (!open) return;
    const items = playableItems();
    (items.find((b) => b.getAttribute('aria-checked') === 'true') ?? items[0])?.focus();
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const outside = (e: PointerEvent): void => {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false);
    };
    const escape = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') close(true);
    };
    window.addEventListener('pointerdown', outside);
    window.addEventListener('keydown', escape);
    return () => {
      window.removeEventListener('pointerdown', outside);
      window.removeEventListener('keydown', escape);
    };
  }, [open]);

  const moveFocus = (e: ReactKeyboardEvent): void => {
    const items = playableItems();
    if (items.length === 0) return;
    const at = items.indexOf(document.activeElement as HTMLButtonElement);
    const next = { ArrowDown: at + 1, ArrowUp: at - 1, Home: 0, End: items.length - 1 }[e.key];
    if (next === undefined) return;
    e.preventDefault();
    items[(next + items.length) % items.length].focus();
  };

  if (!shown) return null;
  return (
    <div className="audio-menu" ref={rootRef}>
      <button ref={buttonRef} type="button" aria-haspopup="menu" aria-expanded={open} data-testid="audio-menu" disabled={!levelAudio && disabledReason !== undefined} title={levelAudio ? undefined : disabledReason} onClick={() => setOpen((o) => !o)}>
        Audio
      </button>
      {open && (
        <ul ref={listRef} role="menu" className="audio-menu-list" onKeyDown={moveFocus}>
          {levelAudio?.tracks.map((t) => (
            <li key={t.number} role="none">
              <button
                type="button"
                role="menuitemradio"
                aria-checked={t.number === levelAudio.current}
                data-testid={`audio-track-${t.number}`}
                onClick={() => {
                  close(true);
                  if (t.number !== levelAudio.current) levelAudio.onPick(t.number);
                }}
              >
                {t.label}
              </button>
            </li>
          ))}
          {!levelAudio && tracks.map((t) => (
            <li key={t.index} role="none">
              <button
                type="button"
                role="menuitemradio"
                aria-checked={t.index === selected}
                disabled={!t.playable}
                title={t.playable ? undefined : `${t.codec} isn't supported`}
                data-testid={`audio-track-${t.index}`}
                data-codec={t.codec}
                onClick={() => {
                  close(true);
                  onSelect(t.index);
                }}
              >
                {trackLabel(t)}
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
