// SPDX-License-Identifier: LGPL-3.0-or-later
// Draw a canvas through a projective matrix, as \frx, \fry and \frz transform text.
import { drawWarped, type Mat3 } from '@seikou/ass';

export default async function example(): Promise<void> {
  const source = new OffscreenCanvas(20, 10);
  const sourceCtx = source.getContext('2d')!;
  sourceCtx.fillStyle = '#fff';
  sourceCtx.fillRect(0, 0, 20, 10);
  const target = new OffscreenCanvas(100, 100);
  const ctx = target.getContext('2d')!;
  // Source pixels map to 26.6 coordinates (64 units to a pixel): this matrix moves the canvas 30 px right and 40 px down.
  const move: Mat3 = [1, 0, 30 * 64, 0, 1, 40 * 64, 0, 0, 1];
  drawWarped(ctx, source, move, 0, 0);
  const inside = ctx.getImageData(40, 45, 1, 1).data[3]!;
  const outside = ctx.getImageData(5, 5, 1, 1).data[3]!;
  console.log('alpha inside', inside, 'outside', outside);
  if (inside !== 255 || outside !== 0) throw new Error('the canvas was not drawn where the matrix puts it');
}
