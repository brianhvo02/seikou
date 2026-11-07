import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { PlaylistPicker } from './PlaylistPicker';

const titles = [{ number: 1, kind: 'hdmv' as const }, { number: 2, kind: 'bdj' as const }];
const render = (bdjSupported: boolean): string =>
  renderToStaticMarkup(createElement(PlaylistPicker, { playlists: [], usesBdj: true, bdjSupported, titles, onPick: () => undefined, onCloseDisc: () => undefined }));
const titleButton = (html: string, n: number): string => html.match(new RegExp(`<button[^>]*data-testid="title-${n}"[^>]*>.*?</button>`))![0];

describe('PlaylistPicker', () => {
  it('disables BD-J titles with a badge when the engine cannot run BD-J', () => {
    const html = render(false);
    expect(titleButton(html, 2)).toContain('disabled');
    expect(titleButton(html, 2)).toContain('Needs BD-J');
    expect(html).toContain('This disc uses BD-J menus');
  });

  it('enables BD-J titles without the badge or the unsupported hint when the engine runs BD-J', () => {
    const html = render(true);
    expect(titleButton(html, 2)).not.toContain('disabled');
    expect(titleButton(html, 2)).not.toContain('Needs BD-J');
    expect(titleButton(html, 1)).not.toContain('disabled');
    expect(html).not.toContain('This disc uses BD-J menus');
  });

  it('names what the browser lacks when BD-J cannot run here', () => {
    const html = renderToStaticMarkup(
      createElement(PlaylistPicker, { playlists: [], usesBdj: true, bdjSupported: false, bdjMissing: ['workers started from workers'], titles, onPick: () => undefined, onCloseDisc: () => undefined }),
    );
    expect(html).toContain("This disc uses BD-J menus, which this browser can&#x27;t run: it lacks workers started from workers.");
  });

  it('says the player has no BD-J (not that the browser lacks something) when the engine has no BD-J runtime', () => {
    const html = renderToStaticMarkup(
      createElement(PlaylistPicker, { playlists: [], usesBdj: true, bdjSupported: false, bdjMissing: ['BD-J runtime'], titles, onPick: () => undefined, onCloseDisc: () => undefined }),
    );
    expect(html).toContain('This disc uses BD-J menus, which this player does not include.');
    expect(html).not.toContain('browser');
  });
});
