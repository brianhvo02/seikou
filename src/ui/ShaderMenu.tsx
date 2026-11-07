import { useEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type ReactElement } from 'react';
import type { ShaderModel, ShaderModelState } from './shader-model';
import { missingLabel } from './shader-sets';
import type { PlayerSnapshot } from '@seikou/engine/controller/player-controller';

/** Shown when the engine reports no usable WebGL2 render targets (same text as the engine's UNAVAILABLE). */
const UNAVAILABLE_TEXT = 'Not available on this device';

interface ShaderMenuProps {
  readonly model: ShaderModel;
  readonly state: ShaderModelState;
  readonly status: PlayerSnapshot['shaders'];
  /** Fraction of frames dropped over the last window while a set runs, or null. */
  readonly dropWarning: number | null;
  /** While open, the player keeps its controls up. */
  onOpenChange(open: boolean): void;
}

export function ShaderMenu({ model, state, status, dropWarning, onOpenChange }: ShaderMenuProps): ReactElement {
  const [open, setOpen] = useState(false);
  const [manageOpen, setManageOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const listRef = useRef<HTMLUListElement>(null);
  const folderRef = useRef<HTMLInputElement>(null);
  const filesRef = useRef<HTMLInputElement>(null);
  const dialogRef = useRef<HTMLDivElement>(null);
  const unavailable = status.state === 'unavailable';

  const playableItems = (): HTMLButtonElement[] => [...(listRef.current?.querySelectorAll<HTMLButtonElement>('button:not(:disabled)') ?? [])];
  const close = (refocus: boolean): void => {
    setOpen(false);
    if (refocus) buttonRef.current?.focus();
  };
  const closeManage = (refocus: boolean): void => {
    setManageOpen(false);
    if (refocus) buttonRef.current?.focus();
  };

  useEffect(() => onOpenChange(open || manageOpen), [open, manageOpen, onOpenChange]);

  useEffect(() => {
    if (!open) return;
    const items = playableItems();
    (items.find((b) => b.getAttribute('aria-checked') === 'true') ?? items[0])?.focus();
  }, [open]);

  useEffect(() => {
    if (manageOpen) dialogRef.current?.focus();
  }, [manageOpen]);

  useEffect(() => {
    if (!open && !manageOpen) return;
    const outside = (e: PointerEvent): void => {
      if (rootRef.current?.contains(e.target as Node)) return;
      setOpen(false);
      setManageOpen(false);
    };
    const escape = (e: KeyboardEvent): void => {
      if (e.key !== 'Escape') return;
      if (manageOpen) closeManage(true);
      else close(true);
    };
    window.addEventListener('pointerdown', outside);
    window.addEventListener('keydown', escape);
    return () => {
      window.removeEventListener('pointerdown', outside);
      window.removeEventListener('keydown', escape);
    };
  }, [open, manageOpen]);

  const moveFocus = (e: ReactKeyboardEvent): void => {
    const items = playableItems();
    if (items.length === 0) return;
    const at = items.indexOf(document.activeElement as HTMLButtonElement);
    const next = { ArrowDown: at + 1, ArrowUp: at - 1, Home: 0, End: items.length - 1 }[e.key];
    if (next === undefined) return;
    e.preventDefault();
    items[(next + items.length) % items.length].focus();
  };

  const pick = (input: HTMLInputElement): void => {
    const files = [...(input.files ?? [])];
    input.value = ''; // the same files can be picked again
    if (files.length) void model.add(files.map((f) => ({ name: f.name, size: f.size, text: () => f.text() }))).catch((e) => console.error('shader add failed', e));
  };
  const choose = (name: string | null): void => {
    close(true);
    void model.select(name).catch((e) => console.error('shader select failed', e));
  };

  const compiling = status.state === 'compiling';
  const failed = status.state === 'error';
  const { report } = state;
  const warning = dropWarning !== null && status.set !== null ? `${status.set}: ${Math.round(dropWarning * 100)} % frames dropped — try a Fast mode.` : null;

  return (
    <div className="audio-menu shader-menu" ref={rootRef}>
      <button ref={buttonRef} type="button" aria-haspopup="menu" aria-expanded={open} data-testid="shader-menu" onClick={() => setOpen((o) => !o)}>
        Shaders
        {dropWarning !== null && (
          <span className="shader-warning-mark" data-testid="shader-warning" role="img" aria-label="Frames are being dropped">
            {' ⚠'}
          </span>
        )}
      </button>
      <input
        ref={folderRef}
        type="file"
        multiple
        hidden
        data-testid="shader-add-folder"
        {...{ webkitdirectory: '' }}
        onChange={(e) => pick(e.target)}
      />
      <input ref={filesRef} type="file" multiple hidden accept=".glsl,.conf" data-testid="shader-add-files" onChange={(e) => pick(e.target)} />
      {open && (
        <ul ref={listRef} role="menu" className="audio-menu-list" onKeyDown={moveFocus}>
          {unavailable ? (
            <li role="none" className="subtitle-warning">
              {UNAVAILABLE_TEXT}
            </li>
          ) : (
            <>
              <li role="none">
                <button type="button" role="menuitemradio" aria-checked={state.selected === null} data-testid="shader-set-off" onClick={() => choose(null)}>
                  Off
                </button>
              </li>
              {state.sets.map((s) => {
                const selected = s.name === state.selected;
                return (
                  <li key={s.name} role="none">
                    <button
                      type="button"
                      role="menuitemradio"
                      aria-checked={selected}
                      disabled={!s.available}
                      data-testid={`shader-set-${s.name}`}
                      onClick={() => choose(s.name)}
                    >
                      {s.name}
                      {selected && compiling && <span className="shader-sub"> Compiling…</span>}
                      {!s.available && <span className="shader-sub">{missingLabel(s.missing)}</span>}
                      {selected && failed && status.error && <span className="shader-sub shader-error">{status.error}</span>}
                    </button>
                  </li>
                );
              })}
              {state.selectedMissing && state.selected !== null && !state.sets.some((s) => s.name === state.selected) && (
                <li role="none">
                  <button type="button" role="menuitemradio" aria-checked disabled>
                    {state.selected}
                    <span className="shader-sub">missing</span>
                  </button>
                </li>
              )}
              <li role="separator" className="shader-sep" />
              <li role="none">
                <button type="button" role="menuitem" onClick={() => folderRef.current?.click()}>
                  Add shaders…
                </button>
              </li>
              <li role="none">
                <button type="button" role="menuitem" onClick={() => filesRef.current?.click()}>
                  Add files…
                </button>
              </li>
              <li role="none">
                <button
                  type="button"
                  role="menuitem"
                  data-testid="shader-manage"
                  onClick={() => {
                    close(false);
                    setManageOpen(true);
                  }}
                >
                  Manage…
                </button>
              </li>
            </>
          )}
          {warning && (
            <li role="none" className="subtitle-warning">
              {warning}
            </li>
          )}
        </ul>
      )}
      {report && (
        <div className="shader-report" data-testid="shader-report" role="status">
          <button type="button" aria-label="Dismiss" onClick={() => model.dismissReport()}>
            ×
          </button>
          {/* A bundled file that failed to load is reported with nothing added. */}
          {(report.added.length > 0 || report.importedSets > 0 || report.rejected.length === 0) && (
            <div>
              Added {report.added.length} {report.added.length === 1 ? 'file' : 'files'}
              {report.importedSets > 0 && `, imported ${report.importedSets} ${report.importedSets === 1 ? 'set' : 'sets'}`}.
            </div>
          )}
          {report.rejected.map((r) => (
            <div key={r.name} className="shader-error">
              {r.name}: {r.reason}
            </div>
          ))}
        </div>
      )}
      {manageOpen && (
        <div ref={dialogRef} tabIndex={-1} role="dialog" aria-label="Manage shaders" className="shader-dialog">
          <h3>Files</h3>
          {state.files.length === 0 && <p>No shader files.</p>}
          <ul>
            {state.files.map((f) => (
              <li key={f}>
                <span>{f}</span>
                <button type="button" aria-label={`Remove ${f}`} onClick={() => void model.removeFile(f).catch((e) => console.error(e))}>
                  Remove
                </button>
              </li>
            ))}
          </ul>
          <h3>Imported sets</h3>
          {state.imported.length === 0 && <p>No imported sets.</p>}
          <ul>
            {state.imported.map((n) => (
              <li key={n}>
                <span>{n}</span>
                <button type="button" aria-label={`Remove set ${n}`} onClick={() => void model.removeSet(n).catch((e) => console.error(e))}>
                  Remove
                </button>
              </li>
            ))}
          </ul>
          <button type="button" onClick={() => closeManage(true)}>
            Close
          </button>
        </div>
      )}
    </div>
  );
}
