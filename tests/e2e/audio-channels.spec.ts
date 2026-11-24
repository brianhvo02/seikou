// SPDX-License-Identifier: LGPL-3.0-or-later
import { readdirSync } from 'node:fs';
import { expect, test } from '@playwright/test';

// The built player's AudioWorklet, rendered offline in the browser: the ring's channels must come out on the same
// output channels, through a discrete gain node, at 2, 6 and 8 channels. No device needed, so it runs everywhere;
// hearing the order on real speakers is the owner's check (docs/known-issues.md).
const worklet = readdirSync('dist/assets').find((f) => /^pcm-worklet-.*\.js$/.test(f));

for (const channels of [2, 6, 8]) {
  test(`the worklet plays a ${channels}-channel ring onto ${channels} output channels in order`, async ({ page }) => {
    expect(worklet, 'npm run build first').toBeDefined();
    await page.goto('/');
    const rendered = await page.evaluate(
      async ({ url, channels }) => {
        // the ring's layout (packages/engine/src/audio/ring.ts): 16 bytes of counters, 9 Int32 control slots, frames
        const capacity = 4800;
        const sab = new SharedArrayBuffer(16 + 9 * 4 + capacity * channels * 4);
        const counters = new BigInt64Array(sab, 0, 2);
        const control = new Int32Array(sab, 16, 9);
        control[5] = capacity; // Capacity
        control[6] = 48_000; // SampleRate
        control[8] = channels; // Channels
        const data = new Float32Array(sab, 52, capacity * channels);
        const frames = 1024;
        for (let f = 0; f < frames; f++) for (let c = 0; c < channels; c++) data[f * channels + c] = (c + 1) / 10;
        counters[0] = BigInt(frames); // written
        control[0] = 1; // Playing
        const ctx = new OfflineAudioContext(channels, 512, 48_000);
        await ctx.audioWorklet.addModule(url);
        const node = new AudioWorkletNode(ctx, 'pcm-player', { numberOfInputs: 0, numberOfOutputs: 1, outputChannelCount: [channels], processorOptions: { ring: sab } });
        const gain = ctx.createGain();
        if (channels > 2) {
          gain.channelCount = channels;
          gain.channelCountMode = 'explicit';
          gain.channelInterpretation = 'discrete';
          ctx.destination.channelInterpretation = 'discrete';
        }
        node.connect(gain).connect(ctx.destination);
        const out = await ctx.startRendering();
        return Array.from({ length: out.numberOfChannels }, (_, c) => Math.round(out.getChannelData(c)[300] * 100) / 100);
      },
      { url: `/assets/${worklet}`, channels },
    );
    expect(rendered).toEqual(Array.from({ length: channels }, (_, c) => (c + 1) / 10));
  });
}
