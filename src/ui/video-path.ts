// SPDX-License-Identifier: LGPL-3.0-or-later
import type { VideoPath } from '@seikou/engine/protocol';

/**
 * The video path the app asks the engine for as it loads: `?videopath=element|canvas|auto` when given, else `auto`
 * (HDR streams through the page's video element, the rest on the canvas). The engine's own default is the canvas,
 * for hosts with no video element.
 */
export function initialVideoPath(params: URLSearchParams): VideoPath {
  const flag = params.get('videopath');
  return flag === 'element' || flag === 'canvas' || flag === 'auto' ? flag : 'auto';
}
