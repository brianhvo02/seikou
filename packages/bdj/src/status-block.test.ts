import { describe, expect, it } from 'vitest';
import { StatusBlockReader, StatusBlockWriter, createStatusBlock } from './status-block';

describe('status block', () => {
  it('starts zeroed', () => {
    const r = new StatusBlockReader(createStatusBlock());
    expect([r.time45(), r.uoMask()]).toEqual([0n, 0n]);
  });

  it('carries time and the full 64-bit UO mask from writer to reader', () => {
    const buf = createStatusBlock();
    const w = new StatusBlockWriter(buf);
    const r = new StatusBlockReader(buf);
    w.setTime45(0xffffffffn);
    w.setUoMask(0x8000000000000003n);
    expect([r.time45(), r.uoMask()]).toEqual([0xffffffffn, 0x8000000000000003n]);
  });
});
