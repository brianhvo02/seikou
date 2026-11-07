import type { ReactElement } from 'react';
import type { MenuKey } from '@seikou/engine/protocol';

interface RemotePadProps {
  onKey(key: MenuKey): void;
}

const ARROWS: ReadonlyArray<{ readonly key: MenuKey; readonly label: string; readonly glyph: string }> = [
  { key: 'up', label: 'Up', glyph: '▲' },
  { key: 'left', label: 'Left', glyph: '◀' },
  { key: 'ok', label: 'OK', glyph: 'OK' },
  { key: 'right', label: 'Right', glyph: '▶' },
  { key: 'down', label: 'Down', glyph: '▼' },
];
const DIGITS: readonly MenuKey[] = ['1', '2', '3', '4', '5', '6', '7', '8', '9', '0'];

/** An on-screen remote for disc menus: arrows, OK, digits, Top Menu and Pop-up. */
export function RemotePad({ onKey }: RemotePadProps): ReactElement {
  const button = (key: MenuKey, label: string, glyph: string, className = ''): ReactElement => (
    <button key={key} type="button" className={className} aria-label={label} data-testid={`remote-${key}`} onClick={() => onKey(key)}>
      {glyph}
    </button>
  );
  return (
    <div className="remote-pad" role="group" aria-label="Remote control" data-testid="remote-pad">
      <div className="remote-arrows">{ARROWS.map((a) => button(a.key, a.label, a.glyph, `remote-${a.key}`))}</div>
      <div className="remote-digits">{DIGITS.map((d) => button(d, `Digit ${d}`, d))}</div>
      <div className="remote-menus">
        {button('topMenu', 'Top Menu', 'Top Menu')}
        {button('popup', 'Pop-up', 'Pop-up')}
      </div>
    </div>
  );
}
