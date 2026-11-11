import { useEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type ReactElement } from 'react';
import type { LevelId, LevelInfo } from '@seikou/nas/nas-api';
import { REASON_COPY, levelRateMbps } from './nas/level-model';
import type { LevelState } from './nas/level-session';

interface QualityMenuProps {
  readonly state: LevelState;
  onPick(level: LevelId): void;
  /** While open, the player keeps its controls up. */
  onOpenChange(open: boolean): void;
}

/** `1080p · 10 Mbps`; Original has no rate. */
export function levelItemLabel(l: LevelInfo): string {
  return l.level === 'original' ? l.label : `${l.label} · ${Math.round(levelRateMbps(l, 0))} Mbps`;
}

/** One row of the Quality menu. */
export interface LevelMenuItem {
  /** The level it switches to. */
  readonly level: LevelId;
  /** `levelItemLabel` of the level. */
  readonly label: string;
  /** It is the level now playing. */
  readonly checked: boolean;
  /** The NAS says the level is not available. */
  readonly disabled: boolean;
  /** The reason it is unavailable, shown as a tooltip; undefined when it is available. */
  readonly title: string | undefined;
}

/** The menu's items, or none when fewer than two levels are available (the menu is then hidden). */
export function levelMenuItems(state: LevelState): LevelMenuItem[] {
  if (state.levels.filter((l) => l.available).length < 2) return [];
  return state.levels.map((l) => ({
    level: l.level,
    label: levelItemLabel(l),
    checked: l.level === state.at.level,
    disabled: !l.available,
    title: l.available ? undefined : l.reason ? REASON_COPY[l.reason] : 'not available',
  }));
}

/**
 * The control bar's Quality button and its radio list of the NAS's quality levels for the open disc (`state`), with the
 * playing one checked and unavailable ones disabled with their reason. It renders nothing unless two or more levels are
 * available. `onPick` switches level; `onOpenChange` tells the player to keep its controls up while the list is open.
 */
export function QualityMenu({ state, onPick, onOpenChange }: QualityMenuProps): ReactElement | null {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const listRef = useRef<HTMLUListElement>(null);
  const items = levelMenuItems(state);
  const shown = items.length > 0;

  const playableItems = (): HTMLButtonElement[] => [...(listRef.current?.querySelectorAll<HTMLButtonElement>('button:not(:disabled)') ?? [])];
  const close = (refocus: boolean): void => {
    setOpen(false);
    if (refocus) buttonRef.current?.focus();
  };

  useEffect(() => {
    if (!shown) setOpen(false);
  }, [shown]);

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
      <button ref={buttonRef} type="button" aria-haspopup="menu" aria-expanded={open} data-testid="quality-menu" onClick={() => setOpen((o) => !o)}>
        Quality
      </button>
      {open && (
        <ul ref={listRef} role="menu" className="audio-menu-list" onKeyDown={moveFocus}>
          {items.map((l) => (
            <li key={l.level} role="none">
              <button
                type="button"
                role="menuitemradio"
                aria-checked={l.checked}
                disabled={l.disabled}
                title={l.title}
                data-level={l.level}
                onClick={() => {
                  close(true);
                  if (!l.checked) onPick(l.level);
                }}
              >
                {l.label}
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
