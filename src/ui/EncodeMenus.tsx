// SPDX-License-Identifier: LGPL-3.0-or-later
/**
 * The control bar's menus for an encoded episode: Chapters (the MKV's named chapters, a click seeks) and Settings (the
 * person's Next episode countdown). They open as the Audio and Quality menus do: above the bar, arrows move, Escape
 * or a click outside closes.
 */
import { useEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type ReactElement, type ReactNode, type RefObject } from 'react';
import type { Chapter } from '@seikou/engine/nav/timeline';
import { chapterLabel } from './chapter-actions';

interface Popup {
  readonly open: boolean;
  readonly rootRef: RefObject<HTMLDivElement | null>;
  readonly buttonRef: RefObject<HTMLButtonElement | null>;
  readonly listRef: RefObject<HTMLUListElement | null>;
  toggle(): void;
  close(refocus: boolean): void;
  moveFocus(e: ReactKeyboardEvent): void;
}

/** A menu button's open state, focus and dismissal, as QualityMenu has them. */
function usePopup(onOpenChange: (open: boolean) => void): Popup {
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
    all[(next + all.length) % all.length]!.focus();
  };
  return { open, rootRef, buttonRef, listRef, toggle: () => setOpen((o) => !o), close, moveFocus };
}

/** The button and popup list the encode's menus share: a `label` button that opens `popup`'s list, with the list's `children` inside. */
function MenuShell({ popup, label, testId, className, children }: { popup: Popup; label: string; testId: string; className?: string; children: ReactNode }): ReactElement {
  return (
    <div className="audio-menu" ref={popup.rootRef}>
      <button ref={popup.buttonRef} type="button" aria-haspopup="menu" aria-expanded={popup.open} data-testid={testId} onClick={popup.toggle}>
        {label}
      </button>
      {popup.open && (
        <ul ref={popup.listRef} role="menu" aria-label={label} className={`audio-menu-list${className ? ` ${className}` : ''}`} onKeyDown={popup.moveFocus}>
          {children}
        </ul>
      )}
    </div>
  );
}

/** The chapter playing at `timeUs`: the last one starting at or before it; -1 before the first. */
export function chapterAt(chapters: readonly Chapter[], timeUs: number): number {
  let at = -1;
  for (let i = 0; i < chapters.length; i++) if (chapters[i]!.startUs <= timeUs) at = i;
  return at;
}

interface ChapterMenuProps {
  readonly chapters: readonly Chapter[];
  readonly timeUs: number;
  onSeek(startUs: number): void;
  onOpenChange(open: boolean): void;
}

/** Chapters: each as "name · m:ss" ("Chapter N" without a name), the one playing checked; a click seeks to its start. */
export function ChapterMenu({ chapters, timeUs, onSeek, onOpenChange }: ChapterMenuProps): ReactElement | null {
  const popup = usePopup(onOpenChange);
  if (chapters.length === 0) return null;
  const at = chapterAt(chapters, timeUs);
  return (
    <MenuShell popup={popup} label="Chapters" testId="chapter-menu" className="chapter-menu">
      {chapters.map((c, i) => (
        <li key={c.index} role="none">
          <button
            type="button"
            role="menuitemradio"
            aria-checked={i === at}
            data-chapter={c.index}
            onClick={() => {
              popup.close(true);
              onSeek(c.startUs);
            }}
          >
            {chapterLabel(c)}
          </button>
        </li>
      ))}
    </MenuShell>
  );
}

interface EncodeSettingsMenuProps {
  /** The person's Next episode countdown; null until the NAS has said (the item is disabled meanwhile). */
  readonly countdown: boolean | null;
  onCountdown(on: boolean): void;
  onOpenChange(open: boolean): void;
}

/** Settings: the person's Next episode countdown, on or off (it follows them across devices). */
export function EncodeSettingsMenu({ countdown, onCountdown, onOpenChange }: EncodeSettingsMenuProps): ReactElement {
  const popup = usePopup(onOpenChange);
  return (
    <MenuShell popup={popup} label="Settings" testId="player-settings-menu">
      <li role="none">
        <button
          type="button"
          role="menuitemcheckbox"
          className="menu-switch"
          aria-checked={countdown === true}
          disabled={countdown === null}
          data-testid="countdown-setting"
          onClick={() => {
            if (countdown !== null) onCountdown(!countdown);
          }}
        >
          <span>Next episode countdown</span>
          <span className="menu-switch-state">{countdown ? 'On' : 'Off'}</span>
        </button>
      </li>
    </MenuShell>
  );
}
