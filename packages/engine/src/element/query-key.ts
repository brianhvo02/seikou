// SPDX-License-Identifier: LGPL-3.0-or-later
import type { ElementQuery } from '../protocol';

/**
 * The key an element question and its answer are kept under: the codec with the HDR facts, size and frame rate, since
 * the browser may play a codec at one size or transfer function and not another.
 * @internal
 */
export function elementQueryKey(q: ElementQuery): string {
  const hdr = q.hdr ? `${q.hdr.transfer}${q.hdr.mastering ? '+m' : ''}` : 'sdr';
  return `${q.codec}|${hdr}|${q.width ?? ''}x${q.height ?? ''}@${q.frameRate ?? ''}`;
}
