import { useEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type ReactElement } from 'react';
import type { VideoPath } from '@seikou/engine/protocol';
import { VIDEO_OUTPUT_OPTIONS } from './video-output';

interface VideoOutputMenuProps {
  /** The choice in force. */
  readonly value: VideoPath;
  onPick(path: VideoPath): void;
  /** While open, the player keeps its controls up. */
  onOpenChange(open: boolean): void;
}

/**
 * The control bar's Video output button and its radio list: Auto (HDR through the browser's video player), Always the
 * video player, Always the canvas, with `value` checked. A line under the list says a pick applies from the next
 * playlist. `onPick` takes the choice; `onOpenChange` tells the player to keep its controls up while the list is open.
 */
export function VideoOutputMenu({ value, onPick, onOpenChange }: VideoOutputMenuProps): ReactElement {
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
            A change applies from the next playlist.
          </li>
        </ul>
      )}
    </div>
  );
}
