import { fitRect } from '@seikou/engine/render/compositor';

/** The width of menu space, the graphics plane's size on the disc (1920 px). */
export const MENU_WIDTH = 1920;
/** The height of menu space (1080 px). */
export const MENU_HEIGHT = 1080;

/** A point on the canvas in menu space (1920×1080, letterboxed as the compositor draws it), or null outside the picture. */
export function toMenuSpace(clientX: number, clientY: number, canvasRect: DOMRect): { x: number; y: number } | null {
  const fit = fitRect(MENU_WIDTH, MENU_HEIGHT, canvasRect.width, canvasRect.height);
  const px = clientX - canvasRect.left - fit.x;
  const py = clientY - canvasRect.top - fit.y;
  if (fit.width <= 0 || px < 0 || py < 0 || px >= fit.width || py >= fit.height) return null;
  return { x: Math.floor((px * MENU_WIDTH) / fit.width), y: Math.floor((py * MENU_HEIGHT) / fit.height) };
}
