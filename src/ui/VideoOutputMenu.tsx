import { useEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type ReactElement } from 'react';
import type { DeinterlaceMode, VideoPath } from '@seikou/engine/protocol';
import { DEINTERLACE_OPTIONS, VIDEO_OUTPUT_OPTIONS } from './video-output';
import { AUDIO_CHANNELS_OPTIONS, type AudioChannelsSettingValue } from './audio-channels';

interface VideoOutputMenuProps {
  /** The choice in force. */
  readonly value: VideoPath;
  onPick(path: VideoPath): void;
  /** The deinterlacing choice in force. */
  readonly deinterlace: DeinterlaceMode;
  onDeinterlace(mode: DeinterlaceMode): void;
  /** The Sound choice in force, and what the output plays now (2, 6 or 8 channels; null before it started). */
  readonly sound?: { readonly value: AudioChannelsSettingValue; readonly playing: number | null; onPick(value: AudioChannelsSettingValue): void };
  /** While open, the player keeps its controls up. */
  onOpenChange(open: boolean): void;
}

/**
 * The control bar's Video output button and its radio list: Auto (HDR through the browser's video player), Always the
 * video player, Always the canvas, with `value` checked, then a Deinterlacing group (Auto, Off, `deinterlace` checked,
 * applied at once through `onDeinterlace`), then, with `sound`, a Sound group (Surround where the device has it, Always
 * stereo; it applies after a reload, and a line says what the output plays now). A line under the list says a Video
 * output pick applies from the next playlist. `onPick` takes the choice; `onOpenChange` tells the player to keep its controls up while the list is open.
 */
export function VideoOutputMenu({ value, onPick, deinterlace, onDeinterlace, sound, onOpenChange }: VideoOutputMenuProps): ReactElement {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const listRef = useRef<HTMLUListElement>(null);

  const items = (): HTMLButtonElement[] => [...(listRef.current?.querySelectorAll<HTMLButtonElement>('button:not(:disabled)') ?? [])];
  const close = (refocus: boolean): void => {
    setOpen(false);
    if (refocus) buttonRef.current?.focus();
  };

  useEffect(() => onOpenChange(open), [open, onOpenChange]);

  useEffect(() => {
    if (!open) return;
    const all = items();
    (all.find((b) => b.getAttribute('aria-checked') === 'true') ?? all[0])?.focus();
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
    const all = items();
    if (all.length === 0) return;
    const at = all.indexOf(document.activeElement as HTMLButtonElement);
    const next = { ArrowDown: at + 1, ArrowUp: at - 1, Home: 0, End: all.length - 1 }[e.key];
    if (next === undefined) return;
    e.preventDefault();
    all[(next + all.length) % all.length].focus();
  };

  return (
    <div className="audio-menu" ref={rootRef}>
      <button ref={buttonRef} type="button" aria-haspopup="menu" aria-expanded={open} data-testid="video-output-menu" onClick={() => setOpen((o) => !o)}>
        Video output
      </button>
      {open && (
        <ul ref={listRef} role="menu" className="audio-menu-list" onKeyDown={moveFocus}>
          {VIDEO_OUTPUT_OPTIONS.map((o) => (
            <li key={o.path} role="none">
              <button
                type="button"
                role="menuitemradio"
                aria-checked={o.path === value}
                data-path={o.path}
                onClick={() => {
                  close(true);
                  if (o.path !== value) onPick(o.path);
                }}
              >
                {o.label}
              </button>
            </li>
          ))}
          <li role="none" className="audio-menu-hint">
            A Video output change applies from the next playlist.
          </li>
          <li role="presentation" className="audio-menu-hint" id="deinterlace-label">
            Deinterlacing
          </li>
          {DEINTERLACE_OPTIONS.map((o) => (
            <li key={o.mode} role="none">
              <button
                type="button"
                role="menuitemradio"
                aria-checked={o.mode === deinterlace}
                data-deinterlace={o.mode}
                data-testid={`deinterlace-${o.mode}`}
                onClick={() => {
                  close(true);
                  if (o.mode !== deinterlace) onDeinterlace(o.mode);
                }}
              >
                {o.label}
              </button>
            </li>
          ))}
          {sound && (
            <>
              <li role="presentation" className="audio-menu-hint">
                Sound
              </li>
              {AUDIO_CHANNELS_OPTIONS.map((o) => (
                <li key={o.value} role="none">
                  <button
                    type="button"
                    role="menuitemradio"
                    aria-checked={o.value === sound.value}
                    data-testid={`sound-${o.value}`}
                    onClick={() => {
                      close(true);
                      if (o.value !== sound.value) sound.onPick(o.value);
                    }}
                  >
                    {o.label}
                  </button>
                </li>
              ))}
              <li role="none" className="audio-menu-hint" data-testid="sound-now">
                {soundLine(sound.playing)}
              </li>
            </>
          )}
        </ul>
      )}
    </div>
  );
}

/** What the output plays now, and that a Sound change applies after a reload. */
function soundLine(channels: number | null): string {
  const now = channels === 8 ? '7.1' : channels === 6 ? '5.1' : channels === 2 ? 'stereo' : null;
  return now ? `Playing ${now}. A Sound change applies after a reload.` : 'A Sound change applies after a reload.';
}
