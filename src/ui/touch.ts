import type { PlaybackState } from '@seikou/engine/protocol';
import { fitRect } from '@seikou/engine/render/compositor';
import { MENU_HEIGHT, MENU_WIDTH } from './pointer';

/** A touch tap on the video: where it landed horizontally and when. */
export interface Tap {
  readonly x: number;
  readonly timeMs: number;
}

export type TapAction = 'toggleControls' | 'seekBack' | 'seekForward' | 'menuClick' | 'showControls' | 'none';

/** Two taps within this many ms make a double tap. */
export const DOUBLE_TAP_MS = 300;

/**
 * Whether a point (client px) on the canvas lies off the picture: in a letterbox or pillarbox band (top, bottom or sides)
 * around the 1920×1080 picture as the compositor fits it into the canvas (the rectangle taps are mapped through, as
 * toMenuSpace). A tap there reaches no disc, so over a menu it shows the controls instead (rulings R13, R14).
 */
export function offPicture(x: number, y: number, canvas: { readonly left: number; readonly top: number; readonly width: number; readonly height: number }): boolean {
  const fit = fitRect(MENU_WIDTH, MENU_HEIGHT, canvas.width, canvas.height);
  const px = x - canvas.left;
  const py = y - canvas.top;
  if (px < 0 || py < 0 || px >= canvas.width || py >= canvas.height) return false; // not on the canvas at all
  return px < fit.x || py < fit.y || px >= fit.x + fit.width || py >= fit.y + fit.height;
}

/** A touch held at least this long (ms) is a long press. */
export const LONG_PRESS_MS = 500;
/** A touch that moves more than this many px from where it went down is no long press. */
export const LONG_PRESS_SLOP_PX = 10;

/** Whether a touch has moved too far from where it went down to be a long press. */
export function beyondLongPressSlop(start: { readonly x: number; readonly y: number }, now: { readonly x: number; readonly y: number }): boolean {
  return Math.hypot(now.x - start.x, now.y - start.y) > LONG_PRESS_SLOP_PX;
}

/**
 * Whether a touch held for `heldMs` makes a long press that shows the controls (ruling R15): only over a disc menu, held at
 * least LONG_PRESS_MS without moving beyond the slop. It is not sent to the disc; elsewhere a long touch is an ordinary tap.
 */
export function isMenuLongPress(ctx: { readonly inMenu: boolean; readonly heldMs: number; readonly moved: boolean }): boolean {
  return ctx.inMenu && !ctx.moved && ctx.heldMs >= LONG_PRESS_MS;
}

/**
 * What a tap on the video does. While a disc menu is shown (an HDMV menu, or a BD-J plane with anything visible) a tap on
 * the picture is a click on the menu, and with the controls hidden a tap off it (`offPicture`) shows them: nothing reaches
 * the disc there (rulings R13, R14). Otherwise a single tap toggles the controls, and a second tap within DOUBLE_TAP_MS in
 * the left or right third seeks back or forward.
 */
export function classifyTap(
  prev: Tap | null,
  tap: Tap,
  ctx: { width: number; menuActive: boolean; bdjMenuVisible?: boolean; offPicture?: boolean; controlsShown?: boolean },
): TapAction {
  if (ctx.menuActive || ctx.bdjMenuVisible) {
    if (ctx.controlsShown === false && ctx.offPicture === true) return 'showControls';
    return 'menuClick';
  }
  if (prev && tap.timeMs - prev.timeMs <= DOUBLE_TAP_MS && ctx.width > 0) {
    if (tap.x < ctx.width / 3) return 'seekBack';
    if (tap.x >= (ctx.width * 2) / 3) return 'seekForward';
  }
  return 'toggleControls';
}

/** The tap a following tap pairs with: a tap on a menu (a click, or one that showed the controls) never starts a double tap. */
export function pairableTap(action: TapAction, tap: Tap): Tap | null {
  return action === 'menuClick' || action === 'showControls' ? null : tap;
}

/**
 * The controls' idle flag after a single tap on the video. Only playback (or buffering) toggles it: while paused the controls
 * are always shown, and flipping the hidden flag would make them vanish the moment play is pressed.
 */
export function idleAfterTap(idle: boolean, state: PlaybackState): boolean {
  return state === 'playing' || state === 'buffering' ? !idle : idle;
}

/**
 * Whether the controls may hide after the idle timeout: only during playback, and not while a control is held, a menu of
 * the control bar is open, or the remote is open over a disc menu, HDMV or BD-J (the remote sits with the controls and
 * would go too).
 */
export function controlsMayIdle(ctx: { playing: boolean; pressed: boolean; menuOpen: boolean; remoteOpen: boolean; inMenu: boolean }): boolean {
  return ctx.playing && !ctx.pressed && !ctx.menuOpen && !(ctx.remoteOpen && ctx.inMenu);
}

/**
 * Whether a menu click the disc didn't take (an HDMV tap on no button) shows the controls (ruling R13): for a touch, which
 * has no other way to bring them back over the picture. A mouse or pen click leaves them as they are (ruling R9).
 */
export function missedMenuTapShowsControls(pointerType: string): boolean {
  return pointerType === 'touch';
}

/** Whether a pointer can hover (a mouse or a pen); a touch pointer cannot. */
export function isHoverPointer(pointerType: string): boolean {
  return pointerType === 'mouse' || pointerType === 'pen';
}

/** Over a disc menu, the mouse wakes the control bar only within this many px of the player's bottom edge (ruling R9). */
export const MENU_WAKE_ZONE_PX = 24;

/** What a hover pointer's move (or press) over a disc menu does to the control bar. */
export type MenuPointerEffect = 'wake' | 'hide' | 'keep';

/**
 * The control bar never covers a disc menu (ruling R9). Over a menu a mouse or pen wakes the bar only within
 * MENU_WAKE_ZONE_PX of the player's bottom edge, or while the pointer is over the shown bar (`barTop`, null when hidden)
 * or on a control (so its buttons can be reached once it shows). Anywhere else the bar hides at once, unless something
 * holds it (a control held down, a bar menu open, the remote open), and then it is left as it is.
 */
export function menuPointerEffect(p: { y: number; playerBottom: number; barTop: number | null; overControls: boolean; held: boolean }): MenuPointerEffect {
  if (p.overControls || p.playerBottom - p.y <= MENU_WAKE_ZONE_PX) return 'wake';
  if (p.barTop !== null && p.y >= p.barTop) return 'wake';
  return p.held ? 'keep' : 'hide';
}

/**
 * Whether the controls show. They always show while paused, except over a disc menu when a hover pointer hid them (moving
 * over the menu, ruling R9): then they stay hidden while paused, since a real player draws nothing over the menu. Controls
 * that idled out by the timer show again on pause, as outside a menu (ruling R12).
 */
export function controlsShown(ctx: { idle: boolean; playing: boolean; inMenu: boolean; hiddenByHover: boolean }): boolean {
  return !ctx.idle || (!ctx.playing && !(ctx.inMenu && ctx.hiddenByHover));
}

/** A pointer's position in client coordinates, with its pointerId. */
export interface PointerPoint {
  readonly id: number;
  readonly x: number;
  readonly y: number;
}

/**
 * Where a touch tap landed: the matching pointerdown's position. iPadOS Safari was seen reporting a touch's pointerup at
 * (0, 0) (under remote automation, at least), while pointerdown carries the real position; without a matching
 * pointerdown, the pointerup's own position.
 */
export function tapPoint(down: PointerPoint | null, up: PointerPoint): { x: number; y: number } {
  return down && down.id === up.id ? { x: down.x, y: down.y } : { x: up.x, y: up.y };
}
