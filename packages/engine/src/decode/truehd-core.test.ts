import { describe, expect, it } from 'vitest';
import { UnsupportedCodecError } from './decoder';
import { TrueHdCoreFilter } from './truehd-core';

const unit = (ext: number | undefined, ptsUs: number, first = 0xf8) => ({ data: new Uint8Array([first, 0x77, 0, 0]), ptsUs, streamIdExtension: ext });

describe('TrueHdCoreFilter', () => {
  it('keeps the AC-3 core (0x76) and drops MLP (0x72)', () => {
    const f = new TrueHdCoreFilter();
    expect([f.accept(unit(0x72, 0)), f.accept(unit(0x76, 0)), f.accept(unit(0x72, 1000))]).toEqual([false, true, false]);
  });

  it('falls back to the AC-3 sync word when a packet has no extension', () => {
    const f = new TrueHdCoreFilter();
    expect([f.accept(unit(undefined, 0, 0x0b)), f.accept(unit(undefined, 0, 0xf8))]).toEqual([true, false]);
  });

  it('gives up after 2 s of input without a core', () => {
    const f = new TrueHdCoreFilter();
    expect(f.accept(unit(0x72, 0))).toBe(false);
    expect(f.accept(unit(0x72, 1_999_000))).toBe(false);
    expect(() => f.accept(unit(0x72, 2_000_000))).toThrow(new UnsupportedCodecError(0x83, "This TrueHD track has no Dolby Digital core, so it can't be played."));
  });
});
