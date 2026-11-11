import type { UoOp } from '@seikou/engine/hdmv/uo-mask';
import type { MenuKey } from '@seikou/engine/protocol';

/** What a key press asks the player to do; `keyToAction` maps a key to one, and `keyActionUo` names the disc operation it needs. */
export type KeyAction =
  | { readonly type: 'togglePlay' }
  | { readonly type: 'seekBy'; readonly deltaUs: number }
  | { readonly type: 'volumeBy'; readonly delta: number }
  | { readonly type: 'fullscreen' }
  | { readonly type: 'cycleAudio' }
  | { readonly type: 'subtitleOffset'; readonly deltaMs: number }
  | { readonly type: 'cycleSubtitles' }
  | { readonly type: 'cycleShaders' }
  | { readonly type: 'menuKey'; readonly key: MenuKey };

/** What `keyToAction` needs to know about the player. */
export interface KeyContext {
  /** A disc menu is shown: arrows, Enter and digits go to it. */
  readonly menuActive: boolean;
}

const MENU_ARROWS: Readonly<Record<string, MenuKey>> = { ArrowUp: 'up', ArrowDown: 'down', ArrowLeft: 'left', ArrowRight: 'right', Enter: 'ok' };

/** Maps a `KeyboardEvent.key` to an action: playback keys (space, arrows, F for fullscreen), A (audio track), S (subtitles), V (video shaders), [ and ] (text subtitle timing), M (top menu), P (pop-up), and menu keys while a menu is shown. Returns null for a key that maps to nothing. */
export function keyToAction(key: string, ctx: KeyContext = { menuActive: false }): KeyAction | null {
  if (ctx.menuActive) {
    const menuKey = MENU_ARROWS[key] ?? (/^[0-9]$/.test(key) ? (key as MenuKey) : undefined);
    if (menuKey) return { type: 'menuKey', key: menuKey };
  }
  switch (key) {
    case ' ':
      return { type: 'togglePlay' };
    case 'ArrowLeft':
      return { type: 'seekBy', deltaUs: -10_000_000 };
    case 'ArrowRight':
      return { type: 'seekBy', deltaUs: 10_000_000 };
    case 'ArrowUp':
      return { type: 'volumeBy', delta: 0.1 };
    case 'ArrowDown':
      return { type: 'volumeBy', delta: -0.1 };
    case 'f':
    case 'F':
      return { type: 'fullscreen' };
    case 'a':
    case 'A':
      return { type: 'cycleAudio' };
    case 's':
    case 'S':
      return { type: 'cycleSubtitles' };
    case 'v':
    case 'V':
      return { type: 'cycleShaders' };
    case '[':
      return { type: 'subtitleOffset', deltaMs: -100 };
    case ']':
      return { type: 'subtitleOffset', deltaMs: 100 };
    case 'm':
    case 'M':
      return { type: 'menuKey', key: 'topMenu' };
    case 'p':
    case 'P':
      return { type: 'menuKey', key: 'popup' };
    default:
      return null;
  }
}

/**
 * Whether a key press shows the controls. Over a disc menu, keys that go to the disc (arrows, Enter, digits,
 * Top Menu, pop-up: any menu key) leave the control bar as it is, so it never comes over the menu; every other key,
 * player shortcuts included, wakes it as anywhere else. `action` is null for a key that maps to nothing.
 */
export function keyWakesControls(action: KeyAction | null, inMenu: boolean): boolean {
  return !(inMenu && action?.type === 'menuKey');
}

const MENU_KEY_UO: Partial<Record<MenuKey, UoOp>> = { up: 'moveUp', down: 'moveDown', left: 'moveLeft', right: 'moveRight', ok: 'activate', topMenu: 'menuCall' };

/** The disc user operation (UO) a key action performs, checked against the disc's UO mask before it is sent; null if none. */
export function keyActionUo(action: KeyAction, ctx: { readonly playing: boolean; readonly popupShown: boolean }): UoOp | null {
  switch (action.type) {
    case 'togglePlay':
      return ctx.playing ? 'pauseOn' : null;
    case 'seekBy':
      return 'timeSearch';
    case 'cycleAudio':
      return 'primaryAudioChange';
    // cycleSubtitles: the controller names pgChange or pgEnableDisable once it knows the next choice; the text offset is no disc operation
    case 'menuKey':
      if (action.key === 'popup') return ctx.popupShown ? 'popupOff' : 'popupOn';
      return MENU_KEY_UO[action.key] ?? null;
    default:
      return null;
  }
}
