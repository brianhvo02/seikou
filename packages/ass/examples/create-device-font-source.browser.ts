// SPDX-License-Identifier: LGPL-3.0-or-later
// Look up a font installed on the device by its likely names and measure its vertical size.
import { createDeviceFontSource } from '@seikou/ass';

export default async function example(): Promise<void> {
  const ctx = new OffscreenCanvas(1, 1).getContext('2d')!;
  const source = createDeviceFontSource(document.fonts, ctx);
  // Nothing on a device is called this, so the lookup finds no face and answers null.
  const missing = await source.load('example-installed', ['Starfall Sans', 'StarfallSans-Regular']);
  source.unload('example-installed');
  console.log('metrics of a font nobody has:', missing);
  if (missing !== null) throw new Error('a made-up font was found');
}
